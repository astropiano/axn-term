using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Porta.Pty;

namespace Astropiano.AxnTerm.SessionHost;

/// <summary>
/// Bridges shell PTYs to /ws WebSockets: each connection spawns a PTY via
/// <see cref="PtyHost"/> and bridges bytes both ways. Text frames carrying
/// JSON control messages — resize, fs-read, fs-write — are routed through
/// <see cref="WsControlRouter"/> so request handling runs off the receive
/// loop (keystrokes keep flowing while a slow fs-* op is in flight) and
/// every send is serialized through <see cref="SocketSender"/>. Task state
/// files written by task-state CLI (AXN_TASK_STATE_FILE) are pushed to
/// /tasks subscribers on change.
/// </summary>
public sealed class SessionHostService : BackgroundService
{
    private const int BufferSize = 8192;
    private static readonly TimeSpan TaskSendTimeout = TimeSpan.FromSeconds(5);

    private readonly PtyHost _host;
    private readonly ILogger<SessionHostService> _logger;
    private readonly WsControlRouter _router;

    private readonly ConcurrentDictionary<string, DateTime> _sessionMtimes = new();
    private readonly ConcurrentDictionary<WebSocket, TaskSubscriber> _taskSubscribers = new();

    public SessionHostService(PtyHost host, ILogger<SessionHostService> logger, ILogger<WsControlRouter> routerLogger)
    {
        _host = host;
        _logger = logger;
        _router = new WsControlRouter(host, routerLogger);
    }

    /// <summary>
    /// One /ws connection = one PTY session. `cmd` (non-empty) runs
    /// `sh -c <cmd>` instead of the login shell; `cwd` overrides the spawn
    /// directory — used for sub-shell tabs.
    /// </summary>
    public async Task RunSessionAsync(
        WebSocket socket, string? cmd, string? cwd, CancellationToken cancellationToken)
    {
        var sender = new SocketSender(socket);
        var sessionId = Guid.NewGuid().ToString("N");
        var session = await _host.SpawnAsync(sessionId, cmd, cwd, 80, 24, cancellationToken);
        if (session is null)
        {
            await CloseSocketAsync(socket, WebSocketCloseStatus.InternalServerError, cancellationToken);
            return;
        }

        var pty = session.Pty;
        await sender.SendJsonAsync(new JsonObject { ["type"] = "session", ["sessionId"] = sessionId }, cancellationToken);

        using (pty)
        using (var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            var requests = new SessionRequests();
            var ptyToWs = PumpPtyToSocketAsync(pty, sender, sessionCts.Token);
            var wsToPty = PumpSocketToPtyAsync(socket, sender, pty, requests, sessionCts.Token);

            await Task.WhenAny(ptyToWs, wsToPty);

            _host.Kill(session);
            await Task.WhenAll(
                ptyToWs.ContinueWith(_ => { }),
                wsToPty.ContinueWith(_ => { }),
                requests.WhenAll().ContinueWith(_ => { }));
        }

        _host.Remove(sessionId);
        _sessionMtimes.TryRemove(sessionId, out _);
        await sender.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", cancellationToken);
    }

    /// <summary>/tasks subscribers get the session's task state on connect and on change.</summary>
    public async Task RunTaskSubscriptionAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        var subscriber = new TaskSubscriber(new SocketSender(socket));
        var buffer = new byte[BufferSize];
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result;
                var message = new MemoryStream();
                do
                {
                    result = await socket.ReceiveAsync(buffer, cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }
                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (!WsControlRouter.TryParseJson(message, out var msg)
                    || !msg.TryGetProperty("type", out var typeProp)
                    || typeProp.GetString() != "subscribe"
                    || !msg.TryGetProperty("sessionId", out var idProp))
                {
                    continue;
                }

                var sessionId = idProp.GetString();
                if (string.IsNullOrEmpty(sessionId))
                {
                    continue;
                }

                _taskSubscribers[socket] = subscriber;
                subscriber.SessionId = sessionId;
                var snapshot = _host.ReadTaskState(sessionId);
                if (snapshot is not null)
                {
                    await SendTaskStateAsync(subscriber.Sender, snapshot.Value, cancellationToken);
                }
            }
        }
        catch (IOException) { }
        catch (WebSocketException) { }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }

        _taskSubscribers.TryRemove(socket, out _);
        await subscriber.Sender.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", cancellationToken);
    }

    /// <summary>
    /// PTY → socket pump. Returns true when the PTY stream ended (the shell
    /// exited) so the caller can report a clean close.
    /// </summary>
    private static async Task<bool> PumpPtyToSocketAsync(IPtyConnection pty, SocketSender sender, CancellationToken cancellationToken)
    {
        var reader = pty.ReaderStream;
        var byteBuffer = new byte[BufferSize];
        var decoder = Encoding.UTF8.GetDecoder();
        var charBuffer = new char[BufferSize];

        try
        {
            while (sender.CanSend)
            {
                var read = await reader.ReadAsync(byteBuffer.AsMemory(0, byteBuffer.Length), cancellationToken);
                if (read <= 0)
                {
                    return true;
                }

                // Decode incrementally so multi-byte UTF8 sequences split across
                // reads stay intact, then send a text frame like the node server.
                var chars = decoder.GetChars(byteBuffer, 0, read, charBuffer, 0, false);
                if (chars == 0)
                {
                    continue;
                }

                var payload = Encoding.UTF8.GetBytes(charBuffer, 0, chars);
                await sender.SendAsync(payload, WebSocketMessageType.Text, cancellationToken);
            }
        }
        catch (IOException) { }
        catch (WebSocketException) { }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }

        return false;
    }

    private async Task PumpSocketToPtyAsync(WebSocket socket, SocketSender sender, IPtyConnection pty, SessionRequests requests, CancellationToken cancellationToken)
    {
        var buffer = new byte[BufferSize];
        try
        {
            while (socket.State == WebSocketState.Open)
            {
                // A single WS *message* may arrive as multiple frames — the
                // gateway forwards fragments verbatim and control payloads
                // (e.g. large fs-write bodies) can exceed the buffer. Assemble
                // until EndOfMessage so fragments never reach the PTY.
                WebSocketReceiveResult result;
                var message = new MemoryStream();
                do
                {
                    result = await socket.ReceiveAsync(buffer, cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }
                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                var data = message.GetBuffer().AsMemory(0, (int)message.Length);
                if (result.MessageType == WebSocketMessageType.Binary)
                {
                    await pty.WriterStream.WriteAsync(data, cancellationToken);
                    await pty.WriterStream.FlushAsync(cancellationToken);
                    continue;
                }

                var text = Encoding.UTF8.GetString(data.Span);
                if (WsControlRouter.TryParseJson(text, out var msg) && msg.ValueKind == JsonValueKind.Object &&
                    msg.TryGetProperty("type", out var typeProp) &&
                    _router.Handle(sender, pty, requests, msg, typeProp.GetString(), cancellationToken))
                {
                    continue;
                }

                var bytes = Encoding.UTF8.GetBytes(text);
                await pty.WriterStream.WriteAsync(bytes, cancellationToken);
                await pty.WriterStream.FlushAsync(cancellationToken);
            }
        }
        catch (IOException) { }
        catch (WebSocketException) { }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    /// <summary>
    /// Poll every active session's task state file; push on mtime change.
    /// Nothing in here may throw out of the loop — this BackgroundService
    /// ending would stop the whole host and every PTY with it.
    /// </summary>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _host.EnsureStateDir();
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            foreach (var (sessionId, session) in _host.Sessions)
            {
                try
                {
                    await PushTaskStateAsync(sessionId, session.StateFile, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Task state push failed for session {SessionId}", sessionId);
                }
            }
        }
    }

    private async Task PushTaskStateAsync(string sessionId, string stateFile, CancellationToken stoppingToken)
    {
        if (!File.Exists(stateFile))
        {
            return;
        }

        var mtime = File.GetLastWriteTimeUtc(stateFile);
        if (_sessionMtimes.TryGetValue(sessionId, out var seen) && seen == mtime)
        {
            return;
        }

        var snapshot = _host.ReadTaskState(sessionId);
        if (snapshot is null)
        {
            return;
        }

        _sessionMtimes[sessionId] = mtime;
        foreach (var (socket, subscriber) in _taskSubscribers)
        {
            if (subscriber.SessionId != sessionId)
            {
                continue;
            }

            if (!subscriber.Sender.CanSend)
            {
                _taskSubscribers.TryRemove(socket, out _);
                continue;
            }

            // Bounded per subscriber: a stalled client is dropped (the
            // cancelled send aborts its socket) instead of holding up the rest.
            using var sendCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            sendCts.CancelAfter(TaskSendTimeout);
            try
            {
                await SendTaskStateAsync(subscriber.Sender, snapshot.Value, sendCts.Token);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                _logger.LogDebug(ex, "Dropping task subscriber for session {SessionId}", sessionId);
                _taskSubscribers.TryRemove(socket, out _);
            }
        }
    }

    private static Task SendTaskStateAsync(SocketSender sender, JsonElement state, CancellationToken cancellationToken) =>
        sender.SendJsonAsync(new { type = "tasks", payload = state }, cancellationToken);

    private static async Task CloseSocketAsync(WebSocket socket, WebSocketCloseStatus status, CancellationToken cancellationToken)
    {
        if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            try
            {
                await socket.CloseAsync(status, "Closing", cancellationToken);
            }
            catch
            {
                // ignored
            }
        }
    }

    private sealed class TaskSubscriber(SocketSender sender)
    {
        public SocketSender Sender { get; } = sender;

        public volatile string? SessionId;
    }

    /// <summary>
    /// Control requests in flight for one session. fs-* ops keep their
    /// arrival order (a write followed by a read sees the write, as when they
    /// ran inline); everything else runs independently.
    /// </summary>
    private sealed class SessionRequests : WsControlRouter.ISessionRequests
    {
        private readonly List<Task> _running = new();
        private Task _orderedTail = Task.CompletedTask;

        public void Run(Func<Task> request) => Track(Task.Run(request));

        /// <summary>Only called from the receive loop, so the tail needs no lock.</summary>
        public void RunOrdered(Func<Task> request)
        {
            _orderedTail = _orderedTail.ContinueWith(_ => request(), TaskScheduler.Default).Unwrap();
            Track(_orderedTail);
        }

        public Task WhenAll()
        {
            lock (_running)
            {
                return Task.WhenAll(_running);
            }
        }

        private void Track(Task task)
        {
            lock (_running)
            {
                _running.RemoveAll(t => t.IsCompleted);
                _running.Add(task);
            }
        }
    }
}
