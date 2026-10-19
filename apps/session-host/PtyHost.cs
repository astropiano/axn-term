using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Porta.Pty;

namespace Astropiano.AxnTerm.SessionHost;

/// <summary>
/// One shell PTY owned by the host — spawned either for a /ws connection or a
/// Ramphastos createPty command. `Id` is the AXN_SESSION_ID handed to the
/// shell env; it doubles as the registry key, so clients can reattach to a
/// live PTY instead of respawning.
/// </summary>
public sealed class PtySession
{
    public required string Id { get; init; }
    public required IPtyConnection Pty { get; init; }
    public required string StateFile { get; init; }
    public string? Command { get; init; }
    /// <summary>Session-model fields — owned by the host, shared by every
    /// Ramphastos session projecting this PTY (name/workspace survive VM
    /// rebuilds on attach/resume).</summary>
    public string? SessionId { get; set; }
    public string? WorkspaceId { get; set; }
    public string? Name { get; set; }
    public string? Kind { get; set; }
    public required string Cwd { get; init; }
    public int Cols { get; set; }
    public int Rows { get; set; }
    /// <summary>Set once the process has exited; the PTY stays registered so
    /// clients can still see its final state until it is closed.</summary>
    public int? ExitCode { get; set; }
    public DateTimeOffset SpawnedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Ring buffer of recent PTY output — late-attaching clients
    /// fetch it via <c>ptyTail</c> to repaint the screen before live frames.</summary>
    public byte[] Tail { get; private set; } = [];
    private readonly object _tailLock = new();
    private const int TailMax = 64 * 1024;
    public void AppendTail(ReadOnlySpan<byte> data)
    {
        lock (_tailLock)
        {
            var combined = new byte[Tail.Length + data.Length];
            Tail.CopyTo(combined, 0);
            data.CopyTo(combined.AsSpan(Tail.Length));
            Tail = combined.Length > TailMax ? combined[^TailMax..] : combined;
        }
    }
    public byte[] TailSnapshot() { lock (_tailLock) return Tail; }
}

/// <summary>
/// Host-scoped PTY lifecycle and filesystem/exec surface: spawn/kill plus the
/// cwd, foreground-process, tty, fs-* and exec helpers. Both the /ws session
/// bridge (SessionHostService) and the Ramphastos host view-model drive PTYs
/// through this — the registry makes PTYs survive whatever transport brought
/// them up.
/// </summary>
public sealed class PtyHost
{
    private const int BufferSize = 8192;
    /// <summary>Cap for `fs-read` bodies — matches the ws-era limit.</summary>
    public const long MaxReadBytes = 16 * 1024 * 1024;
    /// <summary>Cap for exec/fs child output.</summary>
    private const long MaxExecOutputBytes = 16 * 1024 * 1024;
    /// <summary>fs helpers shell out briefly; they should never hang.</summary>
    private static readonly TimeSpan FsTimeout = TimeSpan.FromSeconds(30);

    private readonly ILogger<PtyHost> _logger;
    private readonly string _ptyCmd;
    private readonly string[] _ptyArgs;
    private readonly string _ptyCwd;
    private readonly string _stateDir;
    private readonly string _ptyUser;
    /// <summary>AXN_FS_JAIL_HOME=1: fs-*/exec paths stay inside the PTY
    /// user's $HOME — defense for hosts shared beyond a dev box.</summary>
    private readonly bool _fsJail;
    private readonly TimeSpan _execTimeout;

    private readonly ConcurrentDictionary<string, PtySession> _sessions = new();

    public PtyHost(IConfiguration configuration, ILogger<PtyHost> logger)
    {
        _logger = logger;
        _ptyCmd = configuration["PTY_CMD"] ?? "/bin/bash";
        _ptyArgs = (configuration["PTY_ARGS"] ?? "")
            .Split(' ', StringSplitOptions.RemoveEmptyEntries);
        _ptyCwd = configuration["PTY_CWD"]
            ?? configuration["HOME"]
            ?? "/tmp";
        _stateDir = configuration["AXN_STATE_DIR"] ?? "/tmp/axn-term";
        _ptyUser = configuration["PTY_USER"]
            ?? configuration["KEYCLOAK_USERNAME"]
            ?? configuration["USER"]
            ?? "node";
        _fsJail = configuration["AXN_FS_JAIL_HOME"] is "1" or "true";
        // AXN_EXEC_TIMEOUT_SECONDS bounds `exec` requests; the process tree
        // is killed on timeout, output overflow or cancellation.
        _execTimeout = TimeSpan.FromSeconds(
            int.TryParse(configuration["AXN_EXEC_TIMEOUT_SECONDS"], out var execSeconds) && execSeconds > 0
                ? execSeconds
                : 60);
    }

    public IReadOnlyDictionary<string, PtySession> Sessions => _sessions;

    /// <summary>Workspace id → display name. Host-owned like <see cref="Sessions"/>;
    /// each Ramphastos VM mirrors it into its synced Workspaces collection.</summary>
    public System.Collections.Concurrent.ConcurrentDictionary<string, string?> Workspaces { get; } = new();
    public string DefaultShell => _ptyCmd;
    public string DefaultCwd => _ptyCwd;
    public string StateDir => _stateDir;

    /// <summary>
    /// Spawn a shell PTY (or `sh -c <cmd>`) and register it. `cwd` overrides
    /// the spawn directory — used for sub-shell tabs.
    /// </summary>
    public async Task<PtySession?> SpawnAsync(
        string id, string? cmd, string? cwd, int cols, int rows, CancellationToken cancellationToken)
    {
        var stateFile = Path.Combine(_stateDir, $"tasks-{id}.json");
        EnsureStateDir();

        // When the service runs as root (e.g. docker-in-session needs it),
        // spawn the PTY as the session user instead — a real shell in
        // /home/<user>, like SSHing into the box. setpriv execs the shell
        // directly, so pty.Pid stays the shell and cwd tracking keeps working.
        var runAsUser = geteuid() == 0 && _ptyUser != "root";
        // `cmd` mode runs a one-shot `sh -c` sub-shell; plain mode spawns the
        // login shell.
        var innerApp = string.IsNullOrEmpty(cmd) ? _ptyCmd : "/bin/sh";
        var innerArgs = string.IsNullOrEmpty(cmd) ? _ptyArgs : new[] { "-c", cmd };
        var ptyApp = runAsUser ? "setpriv" : innerApp;
        var ptyArgs = runAsUser
            ? new[] { "--reuid", _ptyUser, "--regid", _ptyUser, "--init-groups", innerApp }
                .Concat(innerArgs).ToArray()
            : innerArgs;
        var defaultCwd = runAsUser ? $"/home/{_ptyUser}" : _ptyCwd;
        var ptyCwd = string.IsNullOrEmpty(cwd)
            ? defaultCwd
            : Path.GetFullPath(Path.IsPathRooted(cwd) ? cwd : Path.Combine(defaultCwd, cwd));

        var env = new Dictionary<string, string>
        {
            ["TERM"] = "xterm-256color",
            ["AXN_SESSION_ID"] = id,
            ["AXN_TASK_STATE_FILE"] = stateFile,
            ["USER"] = _ptyUser,
            ["LOGNAME"] = _ptyUser,
            ["HOME"] = runAsUser ? $"/home/{_ptyUser}" : Environment.GetEnvironmentVariable("HOME") ?? "/tmp",
        };

        IPtyConnection pty;
        try
        {
            pty = await PtyProvider.SpawnAsync(new PtyOptions
            {
                Name = "xterm-256color",
                Cols = cols,
                Rows = rows,
                Cwd = ptyCwd,
                App = ptyApp,
                CommandLine = ptyArgs,
                Environment = env,
            }, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to spawn PTY ({Cmd}) for session {SessionId}", _ptyCmd, id);
            return null;
        }

        var session = new PtySession
        {
            Id = id,
            Pty = pty,
            StateFile = stateFile,
            Command = cmd,
            Cwd = ptyCwd,
            Cols = cols,
            Rows = rows,
        };
        _sessions[id] = session;
        return session;
    }

    /// <summary>Kill the process (if still running), unregister, and remove it.</summary>
    public void Kill(PtySession session)
    {
        try
        {
            session.Pty.Kill();
        }
        catch (Exception)
        {
            try
            {
                Process.GetProcessById(session.Pty.Pid).Kill();
            }
            catch
            {
                // already gone
            }
        }
    }

    /// <summary>Drop a session from the registry (task-state polling stops).</summary>
    public void Remove(string id) => _sessions.TryRemove(id, out _);

    /// <summary>Resolve a client path relative to the shell's live cwd.
    /// With AXN_FS_JAIL_HOME=1 the result must stay inside the PTY user's
    /// home — anything outside is rejected.</summary>
    public string ResolveSessionPath(IPtyConnection pty, string path)
    {
        var resolved = Path.IsPathRooted(path)
            ? Path.GetFullPath(path)
            : Path.GetFullPath(Path.Combine(SessionCwd(pty), path));
        if (_fsJail)
        {
            var home = $"/home/{_ptyUser}";
            if (!resolved.Equals(home, StringComparison.Ordinal) &&
                !resolved.StartsWith(home + '/', StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"path outside session home is not allowed: {path}");
            }
        }
        return resolved;
    }

    public string SessionCwd(IPtyConnection pty)
    {
        try
        {
            var target = File.ResolveLinkTarget($"/proc/{pty.Pid}/cwd", returnFinalTarget: true);
            if (target is not null)
            {
                return target.FullName;
            }
        }
        catch (Exception ex)
        {
            _logger.LogTrace(ex, "Could not resolve /proc cwd for pid {Pid}", pty.Pid);
        }

        return _ptyCwd;
    }

    /// <summary>
    /// Controlling terminal of the session PTY (`/dev/pts/N`) — lets plugins
    /// correlate tty-keyed out-of-band events (e.g. agent hooks).
    /// </summary>
    public string? SessionTty(IPtyConnection pty)
    {
        try
        {
            return File.ResolveLinkTarget($"/proc/{pty.Pid}/fd/0", returnFinalTarget: true)?.FullName;
        }
        catch (Exception ex)
        {
            _logger.LogTrace(ex, "Could not resolve /proc tty for pid {Pid}", pty.Pid);
            return null;
        }
    }

    /// <summary>
    /// Comm name of the terminal's foreground process-group leader: the
    /// shell's /proc stat carries the fg pgrp as tpgid, and the pgrp id is the
    /// leader's pid. Returns null when /proc is unavailable.
    /// </summary>
    public string? ForegroundProcess(IPtyConnection pty)
    {
        try
        {
            var stat = File.ReadAllText($"/proc/{pty.Pid}/stat");
            var close = stat.LastIndexOf(')');
            if (close < 0)
            {
                return null;
            }

            // Fields after comm: state ppid pgrp session tty_nr tpgid …
            var fields = stat[(close + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length <= 5 || !int.TryParse(fields[5], out var tpgid) || tpgid <= 0)
            {
                return null;
            }

            // The shell itself in the foreground means an idle prompt — the
            // client has no reliable shell name to compare against (the PTY
            // may be a `cmd` sub-shell), so report no process instead.
            if (tpgid == pty.Pid)
            {
                return null;
            }

            return File.ReadAllText($"/proc/{tpgid}/comm").Trim();
        }
        catch (Exception ex)
        {
            _logger.LogTrace(ex, "Could not read foreground process for pid {Pid}", pty.Pid);
            return null;
        }
    }

    // ---- fs/exec surface (JsonObject result bodies — callers add their own
    // envelope fields such as type/requestId). Everything runs through
    // ProcessRunner: stdout/stderr drain concurrently (sequential drains
    // deadlock once a pipe buffer fills), output is capped, and timeout or
    // cancellation kills the whole process tree. When the service runs as
    // root the commands run as the PTY user — root could read files the
    // session user cannot see. ----

    /// <summary>
    /// Reads as the PTY user (root would read anything, e.g. other users'
    /// files mounted in) through `head -c`, capped at <see cref="MaxReadBytes"/>;
    /// non-regular files (/dev/zero, FIFOs) are refused instead of read forever.
    /// </summary>
    public async Task<JsonObject> ReadFile(IPtyConnection pty, string path, bool base64, CancellationToken cancellationToken)
    {
        var resolved = ResolveSessionPath(pty, path);
        try
        {
            const string script =
                "if [ ! -e \"$1\" ]; then echo \"no such file or directory\" >&2; exit 2; fi; " +
                "if [ ! -f \"$1\" ]; then echo \"not a regular file\" >&2; exit 2; fi; " +
                "exec head -c \"$2\" -- \"$1\"";
            var psi = CommandPsi("/bin/sh", new[]
            {
                "-c", script, "sh", resolved, (MaxReadBytes + 1).ToString(CultureInfo.InvariantCulture),
            });
            var result = await ProcessRunner.RunAsync(psi, null, FsTimeout, MaxReadBytes, cancellationToken);
            if (result.OutputLimitExceeded)
            {
                return new JsonObject { ["ok"] = false, ["error"] = $"file too large (over {MaxReadBytes / (1024 * 1024)} MB)", ["resolved"] = resolved };
            }

            if (result.ExitCode != 0)
            {
                return new JsonObject { ["ok"] = false, ["error"] = ProcessError(result, "read failed"), ["resolved"] = resolved };
            }

            var contents = base64 ? Convert.ToBase64String(result.Stdout) : result.StdoutText;
            return new JsonObject { ["ok"] = true, ["contents"] = contents, ["resolved"] = resolved };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new JsonObject { ["ok"] = false, ["error"] = ex.Message, ["resolved"] = resolved };
        }
    }

    public async Task<JsonObject> WriteFile(IPtyConnection pty, string path, string contents, CancellationToken cancellationToken)
    {
        var resolved = ResolveSessionPath(pty, path);
        try
        {
            if (RunsAsPtyUser)
            {
                // Write as the PTY user — a root-owned file would be
                // unwritable for agents running in the session.
                var psi = CommandPsi("/bin/sh", new[] { "-c", "cat > \"$1\"", "sh", resolved });
                var result = await ProcessRunner.RunAsync(psi, contents, FsTimeout, MaxExecOutputBytes, cancellationToken);
                return result.ExitCode == 0
                    ? new JsonObject { ["ok"] = true, ["resolved"] = resolved }
                    : new JsonObject { ["ok"] = false, ["error"] = ProcessError(result, "write failed"), ["resolved"] = resolved };
            }
            await File.WriteAllTextAsync(resolved, contents, cancellationToken);
            return new JsonObject { ["ok"] = true, ["resolved"] = resolved };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new JsonObject { ["ok"] = false, ["error"] = ex.Message, ["resolved"] = resolved };
        }
    }

    public async Task<JsonObject> StatFile(IPtyConnection pty, string path, CancellationToken cancellationToken)
    {
        var resolved = ResolveSessionPath(pty, path);
        bool isFile;
        bool isDir;
        if (RunsAsPtyUser)
        {
            // As the PTY user: paths it cannot see report as absent.
            var psi = CommandPsi("/bin/sh", new[]
            {
                "-c", "if [ -d \"$1\" ]; then echo dir; elif [ -e \"$1\" ]; then echo file; fi", "sh", resolved,
            });
            try
            {
                var kind = (await ProcessRunner.RunAsync(psi, null, FsTimeout, 64, cancellationToken)).StdoutText.Trim();
                isFile = kind == "file";
                isDir = kind == "dir";
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return new JsonObject { ["ok"] = false, ["error"] = ex.Message, ["resolved"] = resolved };
            }
        }
        else
        {
            isFile = File.Exists(resolved);
            isDir = Directory.Exists(resolved);
        }

        if (!isFile && !isDir)
        {
            return new JsonObject { ["ok"] = false, ["error"] = "no such file or directory", ["resolved"] = resolved };
        }

        return new JsonObject { ["ok"] = true, ["isFile"] = isFile, ["isDir"] = isDir, ["resolved"] = resolved };
    }

    private sealed record DirEntry(string name, bool isFile, bool isDirectory, bool isSymlink);

    public async Task<JsonObject> ListDir(IPtyConnection pty, string path, CancellationToken cancellationToken)
    {
        var resolved = ResolveSessionPath(pty, path);
        try
        {
            var entries = RunsAsPtyUser
                ? await ListDirAsPtyUserAsync(resolved, cancellationToken)
                : Directory.GetFileSystemEntries(resolved)
                    .Select(e =>
                    {
                        var attrs = File.GetAttributes(e);
                        var isLink = attrs.HasFlag(FileAttributes.ReparsePoint);
                        var isDir = attrs.HasFlag(FileAttributes.Directory);
                        return new DirEntry(Path.GetFileName(e), !isDir, isDir, isLink);
                    })
                    .ToArray();
            return new JsonObject
            {
                ["ok"] = true,
                ["entries"] = new JsonArray(entries.Select(e => (JsonNode)new JsonObject
                {
                    ["name"] = e.name, ["isFile"] = e.isFile, ["isDirectory"] = e.isDirectory, ["isSymlink"] = e.isSymlink,
                }).ToArray()),
                ["resolved"] = resolved,
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new JsonObject { ["ok"] = false, ["error"] = ex.Message, ["resolved"] = resolved };
        }
    }

    /// <summary>
    /// GNU find as the PTY user: `%y` is the entry's own type (l = symlink),
    /// `%Y` the type behind symlinks (d = directory), NUL-separated names.
    /// </summary>
    private async Task<DirEntry[]> ListDirAsPtyUserAsync(string resolved, CancellationToken cancellationToken)
    {
        const string script =
            "[ -d \"$1\" ] || { echo \"not a directory\" >&2; exit 1; }; " +
            "exec find \"$1\" -mindepth 1 -maxdepth 1 -printf '%y%Y%f\\0'";
        var psi = CommandPsi("/bin/sh", new[] { "-c", script, "sh", resolved });
        var result = await ProcessRunner.RunAsync(psi, null, FsTimeout, MaxExecOutputBytes, cancellationToken);
        if (result.ExitCode != 0 || result.OutputLimitExceeded)
        {
            throw new IOException(ProcessError(result, "list failed"));
        }

        return Encoding.UTF8.GetString(result.Stdout)
            .Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Where(e => e.Length > 2)
            .Select(e =>
            {
                var isDir = e[1] == 'd';
                return new DirEntry(e[2..], !isDir, isDir, e[0] == 'l');
            })
            .ToArray();
    }

    public async Task<JsonObject> Mkdir(IPtyConnection pty, string path, CancellationToken cancellationToken)
    {
        var resolved = ResolveSessionPath(pty, path);
        try
        {
            if (RunsAsPtyUser)
            {
                var psi = CommandPsi("mkdir", new[] { "-p", "--", resolved });
                var result = await ProcessRunner.RunAsync(psi, null, FsTimeout, MaxExecOutputBytes, cancellationToken);
                return result.ExitCode == 0
                    ? new JsonObject { ["ok"] = true, ["resolved"] = resolved }
                    : new JsonObject { ["ok"] = false, ["error"] = ProcessError(result, "mkdir failed"), ["resolved"] = resolved };
            }
            Directory.CreateDirectory(resolved);
            return new JsonObject { ["ok"] = true, ["resolved"] = resolved };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new JsonObject { ["ok"] = false, ["error"] = ex.Message, ["resolved"] = resolved };
        }
    }

    /// <summary>
    /// `exec`: run `argv` directly (no shell) or `command` via `sh -c`, cwd
    /// resolved against the session's live cwd like fs-* ops. Runs as the
    /// PTY user when the service runs as root; bounded by AXN_EXEC_TIMEOUT_SECONDS.
    /// </summary>
    public async Task<JsonObject> Exec(
        IPtyConnection pty, string[]? argv, string? command, string? cwd, CancellationToken cancellationToken)
    {
        if (argv is null && string.IsNullOrEmpty(command))
        {
            return new JsonObject { ["ok"] = false, ["error"] = "exec requires argv or command" };
        }

        var app = argv is { Length: > 0 } ? argv[0] : "/bin/sh";
        var args = argv is { Length: > 0 } ? argv.Skip(1).ToArray() : new[] { "-c", command! };
        var workingDir = string.IsNullOrEmpty(cwd)
            ? SessionCwd(pty)
            : ResolveSessionPath(pty, cwd!);

        try
        {
            var result = await ProcessRunner.RunAsync(
                CommandPsi(app, args, workingDir), null, _execTimeout, MaxExecOutputBytes, cancellationToken);
            var stdout = result.StdoutText;
            var error = result.TimedOut
                ? $"exec timed out after {_execTimeout.TotalSeconds:0}s"
                : result.OutputLimitExceeded
                    ? $"exec output exceeded {MaxExecOutputBytes / (1024 * 1024)} MB"
                    : null;
            if (error is not null)
            {
                return new JsonObject { ["ok"] = false, ["error"] = error, ["stdout"] = stdout, ["stderr"] = result.Stderr, ["exitCode"] = result.ExitCode };
            }

            return new JsonObject
            {
                ["ok"] = result.ExitCode == 0,
                ["stdout"] = stdout,
                ["stderr"] = result.Stderr,
                ["exitCode"] = result.ExitCode,
            };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new JsonObject { ["ok"] = false, ["error"] = ex.Message };
        }
    }

    private static string ProcessError(ProcessResult result, string fallback)
    {
        var stderr = result.Stderr.Trim();
        return stderr.Length > 0 ? stderr : result.TimedOut ? "timed out" : fallback;
    }

    /// Service runs as root while the PTY user doesn't — mutations must go
    /// through `setpriv` (same as `exec` and PTY spawn) so files and dirs
    /// land owned by the shell user.
    private bool RunsAsPtyUser => geteuid() == 0 && _ptyUser != "root";

    /// <summary>
    /// `app args` — wrapped in `setpriv` to run as the PTY user when the
    /// service runs as root, as-is otherwise.
    /// </summary>
    private ProcessStartInfo CommandPsi(string app, IEnumerable<string> args, string? workingDirectory = null, bool stdin = false)
    {
        var runAsUser = RunsAsPtyUser;
        var psi = new ProcessStartInfo
        {
            FileName = runAsUser ? "setpriv" : app,
            UseShellExecute = false,
            RedirectStandardInput = stdin,
        };
        if (workingDirectory is not null)
        {
            psi.WorkingDirectory = workingDirectory;
        }
        foreach (var a in runAsUser
            ? new[] { "--reuid", _ptyUser, "--regid", _ptyUser, "--init-groups", app }.Concat(args)
            : args)
        {
            psi.ArgumentList.Add(a);
        }
        psi.Environment["USER"] = _ptyUser;
        psi.Environment["LOGNAME"] = _ptyUser;
        // Already absent from the process env (Program.cs); never hand it on.
        psi.Environment.Remove(SessionHostAuth.SecretEnvName);
        return psi;
    }

    /// <summary>
    /// Creates the task-state dir. When PTYs run as an unprivileged session
    /// user (setpriv), the dir must be writable by that user — the state file
    /// is written by task-state CLI inside the PTY, not by this service.
    /// </summary>
    public void EnsureStateDir()
    {
        var dir = Directory.CreateDirectory(_stateDir);
        if (OperatingSystem.IsLinux() && geteuid() == 0 && _ptyUser != "root")
        {
            dir.UnixFileMode = UnixFileMode.StickyBit
                | UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
                | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
        }
    }

    [System.Runtime.InteropServices.DllImport("libc", SetLastError = true)]
    private static extern uint geteuid();

    /// <summary>Read a session's task state file (task-state CLI output).</summary>
    public JsonElement? ReadTaskState(string sessionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var session) || !File.Exists(session.StateFile))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(session.StateFile));
            return doc.RootElement.Clone();
        }
        catch (Exception ex)
        {
            _logger.LogTrace(ex, "Could not read task state {StateFile}", session.StateFile);
            return null;
        }
    }
}
