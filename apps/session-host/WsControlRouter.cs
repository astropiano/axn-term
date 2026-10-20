using System.Text.Json;
using Porta.Pty;

namespace Astropiano.AxnTerm.SessionHost;

/// <summary>
/// Routes /ws JSON control messages (resize, fs-*, cwd, fg-process, exec) to
/// <see cref="PtyHost"/>. fs-* ops are queued ordered — a write followed by a
/// read must see the write — while exec/cwd/fg-process run independently so a
/// slow exec never stalls the file ops. Terminal input flows on the caller's
/// receive loop; the work itself is dispatched here onto <see
/// cref="ISessionRequests"/> so keystrokes keep flowing.
/// </summary>
public sealed class WsControlRouter
{
    /// <summary>
    /// Per-session request scheduling: <see cref="RunOrdered"/> for fs-* (they
    /// observe each other's effects), <see cref="Run"/> for independent reads
    /// and exec.
    /// </summary>
    public interface ISessionRequests
    {
        void Run(Func<Task> request);
        void RunOrdered(Func<Task> request);
    }

    private readonly PtyHost _host;
    private readonly ControlBroker _control;
    private readonly ILogger<WsControlRouter> _logger;

    public WsControlRouter(PtyHost host, ControlBroker control, ILogger<WsControlRouter> logger)
    {
        _host = host;
        _control = control;
        _logger = logger;
    }

    /// <summary>Returns true when the message was consumed as a control op.</summary>
    public bool Handle(
        SocketSender sender, IPtyConnection pty, ISessionRequests requests,
        JsonElement msg, string? type, CancellationToken cancellationToken)
    {
        switch (type)
        {
            case "resize"
                when msg.TryGetProperty("cols", out var cols) && cols.TryGetInt32(out var c)
                  && msg.TryGetProperty("rows", out var rows) && rows.TryGetInt32(out var r):
                pty.Resize(c, r);
                return true;

            case "fs-read"
                when TryGetString(msg, "requestId", out var requestId) && TryGetString(msg, "path", out var path):
            {
                var base64 = msg.TryGetProperty("encoding", out var enc) && enc.GetString() == "base64";
                requests.RunOrdered(() => RespondAsync(sender,
                    () => _host.ReadFile(pty, path!, base64, cancellationToken), "fs-read-result", requestId!, cancellationToken));
                return true;
            }

            case "fs-write"
                when TryGetString(msg, "requestId", out var requestId2) && TryGetString(msg, "path", out var path2)
                  && TryGetString(msg, "contents", out var contents):
                requests.RunOrdered(() => RespondAsync(sender,
                    () => _host.WriteFile(pty, path2!, contents!, cancellationToken), "fs-write-result", requestId2!, cancellationToken));
                return true;

            case "fs-stat"
                when TryGetString(msg, "requestId", out var requestId3) && TryGetString(msg, "path", out var path3):
                requests.RunOrdered(() => RespondAsync(sender,
                    () => _host.StatFile(pty, path3!, cancellationToken), "fs-stat-result", requestId3!, cancellationToken));
                return true;

            case "fs-list"
                when TryGetString(msg, "requestId", out var requestId4) && TryGetString(msg, "path", out var path4):
                requests.RunOrdered(() => RespondAsync(sender,
                    () => _host.ListDir(pty, path4!, cancellationToken), "fs-list-result", requestId4!, cancellationToken));
                return true;

            case "fs-mkdir"
                when TryGetString(msg, "requestId", out var requestId5) && TryGetString(msg, "path", out var path5):
                requests.RunOrdered(() => RespondAsync(sender,
                    () => _host.Mkdir(pty, path5!, cancellationToken), "fs-mkdir-result", requestId5!, cancellationToken));
                return true;

            case "cwd"
                when TryGetString(msg, "requestId", out var requestId6):
                requests.Run(() => RespondAsync(sender,
                    () => Task.FromResult(new System.Text.Json.Nodes.JsonObject
                        { ["ok"] = true, ["cwd"] = _host.SessionCwd(pty) }),
                    "cwd-result", requestId6!, cancellationToken));
                return true;

            case "tty"
                when TryGetString(msg, "requestId", out var requestId7):
                requests.Run(() => RespondAsync(sender,
                    () => Task.FromResult(new System.Text.Json.Nodes.JsonObject
                        { ["ok"] = true, ["tty"] = _host.SessionTty(pty) }),
                    "tty-result", requestId7!, cancellationToken));
                return true;

            case "fg-process"
                when TryGetString(msg, "requestId", out var requestId8):
                requests.Run(() => RespondAsync(sender,
                    () => Task.FromResult(new System.Text.Json.Nodes.JsonObject
                        { ["ok"] = true, ["process"] = _host.ForegroundProcess(pty) }),
                    "fg-process-result", requestId8!, cancellationToken));
                return true;

            // The browser's answer to a forwarded `axn-term session …` line.
            case "control-reply"
                when TryGetString(msg, "requestId", out var controlRequestId):
                _control.Reply(controlRequestId!, ControlReply.FromJson(
                    System.Text.Json.Nodes.JsonNode.Parse(msg.GetRawText())));
                return true;

            case "exec"
                when TryGetString(msg, "requestId", out var requestId9):
            {
                // Independent of each other and of fs-* ops — a slow exec
                // (docker system df, git log) must not hold anything up.
                requests.Run(async () =>
                {
                    string[]? argv = null;
                    if (msg.TryGetProperty("argv", out var argvProp) && argvProp.ValueKind == JsonValueKind.Array)
                    {
                        argv = argvProp.EnumerateArray().Select(e => e.GetString() ?? "").ToArray();
                    }
                    var command = TryGetString(msg, "command", out var cmd) ? cmd : null;
                    var cwd = TryGetString(msg, "cwd", out var cw) ? cw : null;
                    await RespondAsync(sender,
                        () => _host.Exec(pty, argv, command, cwd, cancellationToken),
                        "exec-result", requestId9!, cancellationToken);
                });
                return true;
            }

            default:
                // Unknown fs-* control messages are dropped; anything else is
                // treated as terminal input, like the node server did.
                return type?.StartsWith("fs-") == true || type == "exec";
        }
    }

    /// <summary>Wrap the result body in the ws control envelope and send it.</summary>
    private async Task RespondAsync(
        SocketSender sender, Func<Task<System.Text.Json.Nodes.JsonObject>> handle,
        string type, string requestId, CancellationToken cancellationToken)
    {
        try
        {
            var body = await handle();
            body["type"] = type;
            body["requestId"] = requestId;
            await sender.SendJsonAsync(body, cancellationToken);
        }
        catch (Exception ex) when (ex is OperationCanceledException or System.Net.WebSockets.WebSocketException or ObjectDisposedException)
        {
            // the session is closing
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Control request failed");
        }
    }

    internal static bool TryParseJson(MemoryStream message, out JsonElement element) =>
        TryParseJson(System.Text.Encoding.UTF8.GetString(message.GetBuffer().AsSpan(0, (int)message.Length)), out element);

    internal static bool TryParseJson(string text, out JsonElement element)
    {
        element = default;
        if (string.IsNullOrEmpty(text) || (text[0] != '{' && text[0] != '['))
        {
            return false;
        }

        try
        {
            using var doc = JsonDocument.Parse(text);
            element = doc.RootElement.Clone();
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryGetString(JsonElement msg, string name, out string? value)
    {
        value = msg.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String
            ? prop.GetString()
            : null;
        return value is not null;
    }
}
