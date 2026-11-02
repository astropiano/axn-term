using System.Collections.ObjectModel;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Ramphastos.Core;
using Ramphastos.Protocol;

namespace AxnTerm.SessionHost;

/// <summary>Synced workspace — shared so every device renders the same name.</summary>
public sealed class RemoteWorkspaceInfo : SyncedObject
{
    public RemoteWorkspaceInfo(string id, string? name) { Id = id; _name = name; }
    public string Id { get; }
    private string? _name;
    public string? Name
    {
        get => _name;
        set => Set(ref _name, value);
    }
}

/// <summary>Synced plugin-state blob — plugins declare state via the
/// updateAppState/updatePluginState APIs and it rides the hub: every
/// device renders the same plugin views. Key scheme: <c>app:&lt;pluginId&gt;</c>
/// for app-level pluginData, <c>sess:&lt;sessionId&gt;:&lt;pluginId&gt;</c> for
/// per-session pluginState. Data is an opaque JSON string.</summary>
public sealed class RemotePluginStateInfo : SyncedObject
{
    public RemotePluginStateInfo(string key, string data) { Key = key; _data = data; }
    public string Key { get; }
    private string _data;
    public string Data
    {
        get => _data;
        set => Set(ref _data, value);
    }
}

/// <summary>Synced view of one remote PTY — what clients see in <c>vm.ptys</c>.</summary>
public sealed class RemotePtyInfo : SyncedObject
{
    public RemotePtyInfo(string id, string? command, string cwd, int cols, int rows, DateTimeOffset spawnedAt)
    {
        Id = id;
        Command = command;
        _cwd = cwd;
        _cols = cols;
        _rows = rows;
        SpawnedAt = spawnedAt;
    }

    public string Id { get; }
    public string? Command { get; }
    public DateTimeOffset SpawnedAt { get; }

    // Session-model fields — published so every attached device derives the
    // same window state (the mirror store groups workspaces/sessions from
    // them). The server owns these; clients update via setPtyMeta.

    /// <summary>Owning session id — the PTY's own id for main shells, the
    /// parent's for sub-shells.</summary>
    private string? _sessionId;
    public string? SessionId
    {
        get => _sessionId;
        set => Set(ref _sessionId, value);
    }

    private string? _workspaceId;
    public string? WorkspaceId
    {
        get => _workspaceId;
        set => Set(ref _workspaceId, value);
    }

    private string? _name;
    public string? Name
    {
        get => _name;
        set => Set(ref _name, value);
    }

    /// <summary>"session" | "subshell" | "detached".</summary>
    private string? _kind;
    public string? Kind
    {
        get => _kind;
        set => Set(ref _kind, value);
    }

    private string _cwd;
    public string Cwd
    {
        get => _cwd;
        set => Set(ref _cwd, value);
    }

    private int _cols;
    public int Cols
    {
        get => _cols;
        set => Set(ref _cols, value);
    }

    private int _rows;
    public int Rows
    {
        get => _rows;
        set => Set(ref _rows, value);
    }

    /// <summary>"running" | "exited" — exited entries keep their exit code.</summary>
    private string _status = "running";
    public string Status
    {
        get => _status;
        set => Set(ref _status, value);
    }

    private int? _exitCode;
    public int? ExitCode
    {
        get => _exitCode;
        set => Set(ref _exitCode, value);
    }
}

/// <summary>
/// Server-authoritative view-model of this session host: the synced
/// <see cref="Ptys"/> collection plus the command surface (createPty,
/// resizePty, closePty, cwd/fgProcess/tty, fs-*, exec). PTY IO rides named
/// duplex streams: every created PTY gets a server-opened
/// <c>pty:&lt;id&gt;</c> stream announced to all connections — controllers
/// write upstream, everyone (viewers included) receives output frames.
/// The underlying PTYs live in <see cref="PtyHost"/>, so they survive the
/// Ramphastos session itself (suspend/resume, reconnect, re-attach).
/// </summary>
public sealed class AxnHostVm : ApplicationModel, IDisposable
{
    private readonly PtyHost _host;
    private readonly ILogger<AxnHostVm> _logger;

    /// <summary>Wired from SessionOptions.ConfigureSession — services are not
    /// part of the synced graph.</summary>
    [NoSync]
    public Session? Session { get; set; }

    private readonly Dictionary<string, RemotePtyInfo> _infos = new();

    /// <summary>Smallest-wins geometry across live connections — see
    /// <see cref="ViewportSizer"/>.</summary>
    private readonly ViewportSizer _viewports = new();

    /// <summary>Rate limit PTY creation per connection — a runaway client
    /// cannot fork-bomb the session host.</summary>
    private readonly Dictionary<string, DateTimeOffset> _spawnTimes = new();
    private static readonly TimeSpan SpawnMinInterval = TimeSpan.FromMilliseconds(500);

    private bool SpawnThrottled()
    {
        var connId = ConnectionContext.Current?.Id;
        if (connId is null) return false;
        var now = DateTimeOffset.UtcNow;
        if (_spawnTimes.TryGetValue(connId, out var last) && now - last < SpawnMinInterval)
        {
            return true;
        }
        _spawnTimes[connId] = now;
        return false;
    }

    public override void OnClientConnected(SessionConnection connection)
    {
        _controlConnections++;
        TryRegisterControl();
    }

    public override void OnClientDisconnected(SessionConnection connection)
    {
        // A session nobody is connected to cannot answer — stop routing
        // `axn-term session …` lines to it.
        if (--_controlConnections <= 0)
        {
            _controlConnections = 0;
            _controlChannel?.Dispose();
            _controlChannel = null;
        }
        if (!_viewports.Remove(connection.Id)) return;
        // The smallest viewport left — re-fit every live PTY.
        foreach (var pty in _host.Sessions.Values)
        {
            _viewports.Apply(pty, _infos);
        }
    }
    // Touched both inside the actor turn (tear-down) and by background pump
    // continuations (registration) — concurrent for safety.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SessionStream> _streams = new();
    /// <summary>PTYs this session publishes, with their output subscription.</summary>
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, PtyAttachment> _attachments = new();

    public AxnHostVm(PtyHost host, ControlBroker control, ILogger<AxnHostVm> logger)
    {
        _host = host;
        _control = control;
        _logger = logger;
    }

    /// <summary>The Ramphastos session is gone: stop receiving PTY output.
    /// The PTYs themselves live on in the host.</summary>
    public void Dispose()
    {
        foreach (var id in _attachments.Keys)
        {
            if (_attachments.TryRemove(id, out var attachment))
            {
                attachment.Close();
            }
        }
        _controlChannel?.Dispose();
        _controlChannel = null;
    }

    // ---- `axn-term session …` (ControlBroker) ----
    // Requests go to the client as JSON lines on the duplex `control` stream
    // ({requestId, ptyId, line}); its answers come back the same way
    // ({requestId, ok, message?, error?}).

    private const string ControlStreamName = "control";
    private readonly ControlBroker _control;
    private SessionStream? _controlStream;
    private IDisposable? _controlChannel;
    private int _controlConnections;

    private void DeclareControlStream()
    {
        Session!.DeclareStream(new StreamDeclaration
        {
            Name = ControlStreamName,
            Direction = StreamDirection.Duplex,
            OnData = data =>
            {
                try
                {
                    var reply = JsonNode.Parse(System.Text.Encoding.UTF8.GetString(data.Span));
                    var requestId = reply?["requestId"]?.GetValue<string>();
                    if (requestId is not null) _control.Reply(requestId, ControlReply.FromJson(reply));
                }
                catch (System.Text.Json.JsonException)
                {
                    // not an answer — ignore
                }
                return ValueTask.CompletedTask;
            },
            OnClose = _ =>
            {
                _controlChannel?.Dispose();
                _controlChannel = null;
                _controlStream = null;
                return ValueTask.CompletedTask;
            },
        });
        // OpenStreamAsync posts to the session mailbox — continue out of band.
        _ = OpenControlStreamAsync();
    }

    private async Task OpenControlStreamAsync()
    {
        _controlStream = await Session!.OpenStreamAsync(ControlStreamName);
        TryRegisterControl();
    }

    private void TryRegisterControl()
    {
        var stream = _controlStream;
        if (stream is null || _controlConnections <= 0 || _controlChannel is not null) return;
        _controlChannel = _control.RegisterHub((requestId, ptyId, line) =>
        {
            var json = new JsonObject { ["requestId"] = requestId, ["ptyId"] = ptyId, ["line"] = line };
            stream.Write(System.Text.Encoding.UTF8.GetBytes(json.ToJsonString()));
            return Task.CompletedTask;
        });
    }

    public string Hostname { get; } = Environment.MachineName;
    public string DefaultShell => _host.DefaultShell;
    public string DefaultCwd => _host.DefaultCwd;

    public ObservableCollection<RemotePtyInfo> Ptys { get; } = new();

    /// <summary>Workspaces referenced by PTYs — id + display name, shared
    /// across devices (rename on one propagates to all).</summary>
    public ObservableCollection<RemoteWorkspaceInfo> Workspaces { get; } = new();

    /// <summary>Plugin-declared state — generic shared plane; any value a
    /// plugin stores through updateAppState/updatePluginState is mirrored to
    /// every attached device (e.g. ram's stats from the desktop).</summary>
    public ObservableCollection<RemotePluginStateInfo> PluginStates { get; } = new();

    /// <summary>Set (or clear, with a null/empty payload) a shared plugin
    /// state entry. Values are opaque JSON strings.</summary>
    [Command]
    public JsonObject SetPluginState(string key, string? data)
    {
        var existing = PluginStates.FirstOrDefault(p => p.Key == key);
        if (data is null || data.Length == 0)
        {
            if (existing is not null) PluginStates.Remove(existing);
        }
        else if (existing is null)
        {
            PluginStates.Add(new RemotePluginStateInfo(key, data));
        }
        else
        {
            existing.Data = data;
        }
        return new JsonObject { ["ok"] = true };
    }

    [Command]
    public JsonObject UpsertWorkspace(string id, string? name = null)
    {
        _host.Workspaces.AddOrUpdate(id, name, (_, old) => name ?? old);
        var ws = Workspaces.FirstOrDefault(w => w.Id == id);
        if (ws is null)
        {
            Workspaces.Add(new RemoteWorkspaceInfo(id, _host.Workspaces[id]));
        }
        else if (name is not null)
        {
            ws.Name = name;
        }
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>
    /// Called from ConfigureSession once the session exists: adopt PTYs that
    /// outlived a previous session instance — re-declare and re-open their
    /// streams so a resumed session re-publishes live terminals.
    /// </summary>
    public void Attach(Session session)
    {
        Session = session;
        DeclareControlStream();

        // Hydrated entries (resumed session record) re-index; PTYs the host
        // no longer runs are pruned from the projection.
        foreach (var info in Ptys)
        {
            _infos[info.Id] = info;
        }
        foreach (var stale in Ptys.Where(i => !_host.Sessions.ContainsKey(i.Id)).ToArray())
        {
            _infos.Remove(stale.Id);
            Ptys.Remove(stale);
        }

        foreach (var pty in _host.Sessions.Values)
        {
            RegisterPty(pty);
        }
        foreach (var (id, name) in _host.Workspaces)
        {
            if (Workspaces.All(w => w.Id != id)) Workspaces.Add(new RemoteWorkspaceInfo(id, name));
        }
    }

    // ---- PTY lifecycle ----

    [Command]
    public async Task<JsonObject> CreatePty(
        string id, int cols = 80, int rows = 24, string? cmd = null, string? cwd = null,
        string? sessionId = null, string? workspaceId = null, string? name = null, string? kind = null)
    {
        if (!PtyHost.IsValidPtyId(id))
        {
            return new JsonObject { ["ok"] = false, ["error"] = "invalid pty id" };
        }

        // Reattach: a live PTY with this id already exists — the client gets
        // the existing stream, no respawn (spawned=false, like the desktop).
        if (TryLive(id, out var live))
        {
            RegisterPty(live);
            return new JsonObject { ["ok"] = true, ["spawned"] = false, ["id"] = id };
        }

        if (SpawnThrottled())
        {
            return new JsonObject { ["ok"] = false, ["error"] = "rate limited" };
        }

        var session = await _host.SpawnAsync(id, cmd, cwd, cols, rows, CancellationToken.None);
        if (session is null)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "spawn failed" };
        }
        _viewports.Apply(session, _infos, cols, rows);

        session.SessionId = sessionId;
        session.WorkspaceId = workspaceId;
        session.Name = name;
        session.Kind = kind;
        RegisterPty(session);
        return new JsonObject { ["ok"] = true, ["spawned"] = true, ["id"] = id };
    }

    /// <summary>Recent PTY output for late attachers (base64) — replayed
    /// client-side before live stream frames so a fresh attach isn't blank.</summary>
    [Command]
    public JsonObject PtyTail(string id)
    {
        if (!_host.Sessions.TryGetValue(id, out var pty))
        {
            return NoSuchPty(id);
        }
        return new JsonObject { ["ok"] = true, ["data"] = Convert.ToBase64String(pty.TailSnapshot()) };
    }

    /// <summary>
    /// Update a published PTY's session-model fields — rename, workspace
    /// move, re-parenting after a sub-shell promotion. Null args leave the
    /// field untouched; empty string clears it.
    /// </summary>
    [Command]
    public JsonObject SetPtyMeta(
        string id, string? sessionId = null, string? workspaceId = null,
        string? name = null, string? kind = null)
    {
        if (!_host.Sessions.TryGetValue(id, out var pty))
        {
            return NoSuchPty(id);
        }
        if (sessionId is not null) pty.SessionId = sessionId;
        if (workspaceId is not null) pty.WorkspaceId = workspaceId;
        if (name is not null) pty.Name = name;
        if (kind is not null) pty.Kind = kind;
        if (_infos.TryGetValue(id, out var info))
        {
            info.SessionId = pty.SessionId;
            info.WorkspaceId = pty.WorkspaceId;
            info.Name = pty.Name;
            info.Kind = pty.Kind;
        }
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Release this connection's viewport claim — the PTY geometry
    /// re-fits to the remaining live viewports (the device stops pinning the
    /// smallest size while staying connected).</summary>
    [Command]
    public JsonObject PauseViewport()
    {
        if (ConnectionContext.Current is not { } conn)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "no connection" };
        }
        _viewports.Remove(conn.Id);
        foreach (var pty in _host.Sessions.Values)
        {
            _viewports.Apply(pty, _infos);
        }
        return new JsonObject { ["ok"] = true };
    }

    /// <summary>Re-claim this connection's viewport with its current size —
    /// the PTY geometry clamps back to smallest-wins across live devices.</summary>
    [Command]
    public JsonObject ResumeViewport(int cols, int rows)
    {
        if (cols <= 0 || rows <= 0)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "bad size" };
        }
        foreach (var pty in _host.Sessions.Values)
        {
            _viewports.Apply(pty, _infos, cols, rows);
        }
        return new JsonObject { ["ok"] = true };
    }

    [Command]
    public JsonObject ResizePty(string id, int cols, int rows)
    {
        if (!TryLive(id, out var pty))
        {
            return NoSuchPty(id);
        }
        var (ec, er) = _viewports.Apply(pty, _infos, cols, rows);
        return new JsonObject { ["ok"] = true, ["cols"] = ec, ["rows"] = er };
    }

    [Command]
    public JsonObject ClosePty(string id)
    {
        // Kill goes through the stream close so every attachment mode
        // converges on the same teardown path.
        if (_streams.TryRemove(id, out var stream))
        {
            stream.Close("closed");
        }
        else if (_host.Sessions.TryGetValue(id, out var pty))
        {
            TearDown(pty, reason: "closed");
        }
        else if (_infos.Remove(id, out var stale))
        {
            // Dead entry whose PTY another session already removed.
            Ptys.Remove(stale);
        }
        else
        {
            return NoSuchPty(id);
        }
        return new JsonObject { ["ok"] = true };
    }

    // ---- session queries ----

    [Command]
    public JsonObject PtyCwd(string id) =>
        TryLive(id, out var pty)
            ? new JsonObject { ["ok"] = true, ["cwd"] = _host.SessionCwd(pty.Pty) }
            : NoSuchPty(id);

    [Command]
    public JsonObject PtyFgProcess(string id) =>
        TryLive(id, out var pty)
            ? new JsonObject { ["ok"] = true, ["process"] = _host.ForegroundProcess(pty.Pty) }
            : NoSuchPty(id);

    [Command]
    public JsonObject PtyTty(string id) =>
        TryLive(id, out var pty)
            ? new JsonObject { ["ok"] = true, ["tty"] = _host.SessionTty(pty.Pty) }
            : NoSuchPty(id);

    // ---- fs/exec (same bodies as the /ws control protocol) ----

    [Command]
    public Task<JsonObject> FsRead(string id, string path, string? encoding = null) =>
        TryLive(id, out var pty)
            ? _host.ReadFile(pty.Pty, path, encoding == "base64", CancellationToken.None)
            : Task.FromResult(NoSuchPty(id));

    [Command]
    public Task<JsonObject> FsWrite(string id, string path, string contents) =>
        TryLive(id, out var pty)
            ? _host.WriteFile(pty.Pty, path, contents, CancellationToken.None)
            : Task.FromResult(NoSuchPty(id));

    [Command]
    public Task<JsonObject> FsStat(string id, string path) =>
        TryLive(id, out var pty)
            ? _host.StatFile(pty.Pty, path, CancellationToken.None)
            : Task.FromResult(NoSuchPty(id));

    [Command]
    public Task<JsonObject> FsList(string id, string path) =>
        TryLive(id, out var pty)
            ? _host.ListDir(pty.Pty, path, CancellationToken.None)
            : Task.FromResult(NoSuchPty(id));

    [Command]
    public Task<JsonObject> FsMkdir(string id, string path) =>
        TryLive(id, out var pty)
            ? _host.Mkdir(pty.Pty, path, CancellationToken.None)
            : Task.FromResult(NoSuchPty(id));

    [Command]
    public Task<JsonObject> Exec(string id, string[]? argv = null, string? command = null, string? cwd = null) =>
        TryLive(id, out var pty)
            ? _host.Exec(pty.Pty, argv, command, cwd, CancellationToken.None)
            : Task.FromResult(NoSuchPty(id));

    // ---- internals ----

    private bool TryLive(string id, out PtySession pty) =>
        _host.Sessions.TryGetValue(id, out pty!) && pty.ExitCode is null;

    private static JsonObject NoSuchPty(string id) =>
        new() { ["ok"] = false, ["error"] = $"no live pty '{id}'" };

    /// <summary>
    /// Register a host PTY in this session's projection: add the synced entry,
    /// declare its <c>pty:&lt;id&gt;</c> duplex stream, open it server-side and
    /// start pumping PTY output into stream frames. Must run inside the actor
    /// turn (or session setup) — it mutates synced state.
    /// </summary>
    private RemotePtyInfo RegisterPty(PtySession pty)
    {
        if (!_infos.TryGetValue(pty.Id, out var info))
        {
            info = new RemotePtyInfo(pty.Id, pty.Command, pty.Cwd, pty.Cols, pty.Rows, pty.SpawnedAt)
            {
                SessionId = pty.SessionId,
                WorkspaceId = pty.WorkspaceId,
                Name = pty.Name,
                Kind = pty.Kind,
            };
            _infos[pty.Id] = info;
            Ptys.Add(info);
        }

        var attachment = new PtyAttachment();
        if (pty.ExitCode is not null || !_attachments.TryAdd(pty.Id, attachment))
        {
            return info;
        }

        var streamName = $"pty:{pty.Id}";
        Session!.DeclareStream(new StreamDeclaration
        {
            Name = streamName,
            Direction = StreamDirection.Duplex,
            OnData = async data =>
            {
                await pty.Pty.WriterStream.WriteAsync(data);
                await pty.Pty.WriterStream.FlushAsync();
            },
            // Stream close means "this terminal is done" — the PTY goes down
            // with it (same semantic as a /ws disconnect killing its PTY).
            OnClose = reason =>
            {
                TearDown(pty, reason);
                return ValueTask.CompletedTask;
            },
        });

        // OpenStreamAsync posts to the session mailbox — awaiting it inside
        // this actor turn would deadlock, so continue out of band.
        _ = OpenAndPumpAsync(pty, streamName, attachment);
        return info;
    }

    private async Task OpenAndPumpAsync(PtySession pty, string streamName, PtyAttachment attachment)
    {
        var stream = await Session!.OpenStreamAsync(streamName);
        if (stream is null)
        {
            _logger.LogWarning("Stream {Stream} never materialized", streamName);
            _attachments.TryRemove(KeyValuePair.Create(pty.Id, attachment));
            return;
        }
        _streams[pty.Id] = stream;
        // PTY output → stream frames (fanned out to every connection). The
        // PTY's own pump reads; other sessions and /ws get the same bytes.
        // Exit closes with "exited[:code]", which funnels through the
        // declaration's OnClose → TearDown inside the actor turn.
        attachment.Set(pty.SubscribeOutput(
            data =>
            {
                stream.Write(data);
                return ValueTask.CompletedTask;
            },
            exitCode => stream.Close(exitCode is { } code ? $"exited:{code}" : "exited")));
    }

    /// <summary>One published PTY's output subscription; closing it before
    /// the stream opened drops the subscription as soon as it arrives.</summary>
    private sealed class PtyAttachment
    {
        private readonly object _lock = new();
        private IDisposable? _subscription;
        private bool _closed;

        public void Set(IDisposable subscription)
        {
            lock (_lock)
            {
                if (!_closed)
                {
                    _subscription = subscription;
                    return;
                }
            }
            subscription.Dispose();
        }

        public void Close()
        {
            IDisposable? subscription;
            lock (_lock)
            {
                _closed = true;
                subscription = _subscription;
                _subscription = null;
            }
            subscription?.Dispose();
        }
    }

    /// <summary>
    /// Runs inside the actor turn (declaration OnClose): mark the projection
    /// exited (or remove it on explicit close), kill the process and drop the
    /// host registration. Safe to call twice — teardown is idempotent.
    /// </summary>
    private void TearDown(PtySession pty, string? reason)
    {
        _streams.TryRemove(pty.Id, out _);
        if (_attachments.TryRemove(pty.Id, out var attachment))
        {
            attachment.Close();
        }
        _host.Kill(pty);

        var exited = reason?.StartsWith("exited") == true;
        int? code = null;
        if (exited && reason!.Length > 7 && int.TryParse(reason[7..], out var parsed))
        {
            code = parsed;
        }

        if (exited && _infos.TryGetValue(pty.Id, out var info) && _host.Sessions.ContainsKey(pty.Id))
        {
            // Keep the host registration and the entry — clients see the dead
            // terminal (task state stays readable) until closePty removes it.
            // The process is gone, so its descriptors can go now.
            pty.ExitCode = code;
            info.Status = "exited";
            info.ExitCode = code;
            pty.DisposePty();
        }
        else
        {
            _host.Remove(pty.Id);
            if (_infos.Remove(pty.Id, out var removed))
            {
                Ptys.Remove(removed);
            }
        }
    }
}
