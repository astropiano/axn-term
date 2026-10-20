using System.Diagnostics;
using Microsoft.AspNetCore.Server.Kestrel.Core;

namespace Astropiano.AxnTerm.SessionHost;

/// <summary>
/// The control endpoint programs inside our terminals talk to: plain HTTP on
/// a Unix socket (<c>$AXN_STATE_DIR/control.sock</c>, owner-only), served by
/// its own minimal Kestrel app — it never shares a listener with the
/// gateway-facing endpoints and their per-container secret. A request
/// authenticates as one PTY (<c>X-Axn-Pty</c> + <c>X-Axn-Pty-Secret</c>) and
/// carries the command line as the form field <c>line</c>; the answer is the
/// message (200) or the reason (403/409/504) as text.
///
/// The client is <see cref="ClientScript"/>, written next to the socket and
/// handed to every PTY as <c>$AXN_TERM_CLI</c>: sh + curl, no extra binary.
/// </summary>
public sealed class ControlListener : IHostedService
{
    public const string SocketName = "control.sock";
    public const string ScriptName = "axn-term";

    private readonly PtyHost _host;
    private readonly ControlBroker _broker;
    private readonly ILogger<ControlListener> _logger;
    private WebApplication? _app;

    public ControlListener(PtyHost host, ControlBroker broker, ILogger<ControlListener> logger)
    {
        _host = host;
        _broker = broker;
        _logger = logger;
    }

    public string SocketPath => Path.Combine(_host.StateDir, SocketName);
    public string ScriptPath => Path.Combine(_host.StateDir, "bin", ScriptName);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        try
        {
            _host.EnsureStateDir();
            WriteClientScript();
            File.Delete(SocketPath);

            var builder = WebApplication.CreateSlimBuilder();
            builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
            builder.WebHost.ConfigureKestrel(k => k.ListenUnixSocket(SocketPath, o => o.Protocols = HttpProtocols.Http1));
            _app = builder.Build();
            // as a Delegate: a method group binds as RequestDelegate and the IResult would be dropped
            _app.MapPost("/control", (Delegate)HandleAsync);
            await _app.StartAsync(cancellationToken);
            RestrictSocket();
            _logger.LogInformation("Control socket listening on {Socket}", SocketPath);
        }
        catch (Exception ex)
        {
            // The terminal works without it — `axn-term session …` then
            // reports that it cannot reach the session host.
            _logger.LogWarning(ex, "Control socket disabled");
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (_app is not null)
        {
            await _app.StopAsync(cancellationToken);
            await _app.DisposeAsync();
        }
    }

    private async Task<IResult> HandleAsync(HttpContext context)
    {
        var pty = context.Request.Headers["X-Axn-Pty"].FirstOrDefault();
        var secret = context.Request.Headers["X-Axn-Pty-Secret"].FirstOrDefault();
        if (!_broker.Verify(pty, secret))
        {
            return Results.Text("unknown terminal — run this inside an axn-term session", statusCode: 403);
        }
        var form = context.Request.HasFormContentType ? await context.Request.ReadFormAsync() : null;
        var line = form?["line"].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(line))
        {
            return Results.Text("empty command line", statusCode: 400);
        }

        var reply = await _broker.SendAsync(pty!, line, ControlBroker.ReplyTimeout, context.RequestAborted);
        if (reply.Ok)
        {
            return Results.Text(reply.Message ?? "");
        }
        var status = reply.Error is "no axn-term window answered" ? 504 : 409;
        return Results.Text(reply.Error ?? "failed", statusCode: status);
    }

    /// <summary>Owner-only; when PTYs run as the session user, that user owns it.</summary>
    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    private void RestrictSocket()
    {
        File.SetUnixFileMode(SocketPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        if (_host.RunsAsPtyUser)
        {
            using var chown = Process.Start(new ProcessStartInfo("chown", [_host.PtyUser, SocketPath]));
            chown?.WaitForExit();
        }
    }

    [System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
    private void WriteClientScript()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(ScriptPath)!);
        File.WriteAllText(ScriptPath, ClientScript);
        File.SetUnixFileMode(ScriptPath,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            | UnixFileMode.GroupRead | UnixFileMode.GroupExecute
            | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
    }

    /// <summary>
    /// `axn-term session summary|rename|focus|command …` — same commands and
    /// exit codes as the desktop CLI (0 done, 1 refused/failed, 2 usage or
    /// not inside axn-term). curl does the form encoding, so any text is safe.
    /// </summary>
    public const string ClientScript = """
        #!/bin/sh
        # axn-term session … for web terminals — written by the session host.
        usage() { echo "usage: axn-term session <summary|rename|focus|command> …" >&2; exit 2; }
        [ "$1" = session ] || usage
        shift
        case "$1" in
          summary) cmd=axn-session-summary ;;
          rename) cmd=axn-rename ;;
          focus) cmd=axn-focus ;;
          command)
            shift
            case "$1" in
              axn-*) cmd=$1 ;;
              *) echo "axn-term session: not an axn-term command: $1" >&2; exit 2 ;;
            esac ;;
          *) usage ;;
        esac
        shift
        if [ -z "$AXN_SESSION_ID" ] || [ -z "$AXN_TERM_PTY_SECRET" ] || [ -z "$AXN_TERM_CONTROL_SOCKET" ]; then
          echo "axn-term session: not inside an axn-term terminal" >&2
          exit 2
        fi
        line=$cmd
        [ $# -gt 0 ] && line="$cmd $*"
        out=$(curl -sS --max-time 15 --unix-socket "$AXN_TERM_CONTROL_SOCKET" \
          -H "X-Axn-Pty: $AXN_SESSION_ID" -H "X-Axn-Pty-Secret: $AXN_TERM_PTY_SECRET" \
          --data-urlencode "line=$line" -w '\n%{http_code}' http://axn-term/control) || {
          echo "axn-term session: cannot reach the session host" >&2
          exit 1
        }
        code=$(printf '%s\n' "$out" | tail -n 1)
        body=$(printf '%s\n' "$out" | sed '$d')
        if [ "$code" = 200 ]; then
          [ -n "$body" ] && printf '%s\n' "$body"
          exit 0
        fi
        printf 'axn-term session: %s\n' "$body" >&2
        exit 1

        """;
}
