using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace AxnTerm.SessionHost;

/// <summary>
/// `axn-term session …` from a program inside one of our terminals — the web
/// counterpart of the desktop control socket (src-tauri/src/control.rs).
/// Every PTY gets a random secret; <see cref="ControlListener"/> verifies it
/// and hands the command line here, which forwards it to the browser that
/// shows the PTY and waits for its answer. The browser runs the line through
/// the same command dispatch as a typed one.
///
/// Delivery goes to exactly one browser channel: the /ws connection of that
/// PTY when there is one, else the most recently attached Ramphastos session —
/// so a command never runs twice.
/// </summary>
public sealed class ControlBroker
{
    /// <summary>How long a request waits for the browser's answer.</summary>
    public static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(5);

    /// <summary>A browser channel: delivers (requestId, ptyId, line).</summary>
    public delegate Task Deliver(string requestId, string ptyId, string line);

    private readonly ConcurrentDictionary<string, string> _secrets = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<ControlReply>> _pending = new();
    private readonly object _lock = new();
    private readonly Dictionary<string, Deliver> _ptyChannels = new();
    private readonly List<Deliver> _hubChannels = new();

    /// <summary>A fresh secret for a PTY about to spawn.</summary>
    public string MintSecret(string ptyId)
    {
        var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        _secrets[ptyId] = secret;
        return secret;
    }

    public void Forget(string ptyId) => _secrets.TryRemove(ptyId, out _);

    public bool Verify(string? ptyId, string? secret)
    {
        if (ptyId is null || secret is null || !_secrets.TryGetValue(ptyId, out var known))
        {
            return false;
        }
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(known), Encoding.UTF8.GetBytes(secret));
    }

    /// <summary>The /ws connection showing <paramref name="ptyId"/>.</summary>
    public IDisposable RegisterPty(string ptyId, Deliver deliver)
    {
        lock (_lock) _ptyChannels[ptyId] = deliver;
        return new Release(() =>
        {
            lock (_lock)
            {
                if (_ptyChannels.TryGetValue(ptyId, out var current) && current == deliver) _ptyChannels.Remove(ptyId);
            }
        });
    }

    /// <summary>A Ramphastos session — it sees every PTY.</summary>
    public IDisposable RegisterHub(Deliver deliver)
    {
        lock (_lock) _hubChannels.Add(deliver);
        return new Release(() =>
        {
            lock (_lock) _hubChannels.Remove(deliver);
        });
    }

    /// <summary>Forward a verified line and wait for the browser's answer.</summary>
    public async Task<ControlReply> SendAsync(string ptyId, string line, TimeSpan timeout, CancellationToken cancellationToken)
    {
        Deliver? deliver;
        lock (_lock)
        {
            deliver = _ptyChannels.GetValueOrDefault(ptyId) ?? _hubChannels.LastOrDefault();
        }
        if (deliver is null)
        {
            return ControlReply.Failure("no axn-term window is connected");
        }

        var requestId = Guid.NewGuid().ToString("N");
        var reply = new TaskCompletionSource<ControlReply>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[requestId] = reply;
        try
        {
            await deliver(requestId, ptyId, line);
            var done = await Task.WhenAny(reply.Task, Task.Delay(timeout, cancellationToken));
            return done == reply.Task ? reply.Task.Result : ControlReply.Failure("no axn-term window answered");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return ControlReply.Failure("the axn-term window is gone");
        }
        finally
        {
            _pending.TryRemove(requestId, out _);
        }
    }

    /// <summary>The browser's answer; false when nobody waits (late or duplicate).</summary>
    public bool Reply(string requestId, ControlReply reply) =>
        _pending.TryRemove(requestId, out var pending) && pending.TrySetResult(reply);

    private sealed class Release(Action release) : IDisposable
    {
        private Action? _release = release;
        public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
    }
}

/// <summary>Same shape as the desktop control reply: ok + message, or an error.</summary>
public sealed record ControlReply(bool Ok, string? Message = null, string? Error = null)
{
    public static ControlReply Failure(string error) => new(false, null, error);

    /// <summary>Wrongly typed fields read as absent — a client reply must never throw.</summary>
    public static ControlReply FromJson(JsonNode? node) =>
        node is JsonObject o
            ? new ControlReply(
                o["ok"] is JsonValue ok && ok.TryGetValue<bool>(out var b) && b,
                o["message"] is JsonValue m && m.TryGetValue<string>(out var message) ? message : null,
                o["error"] is JsonValue e && e.TryGetValue<string>(out var error) ? error : null)
            : Failure("malformed reply");
}
