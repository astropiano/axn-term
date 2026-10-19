using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Astropiano.AxnTerm.SessionHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Astropiano.AxnTerm.SessionHost.Tests;

/// <summary>Real PTY sessions over a loopback WebSocket.</summary>
public sealed class SessionTests : IDisposable
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    private readonly string _dir = Directory.CreateTempSubdirectory("axn-session-test").FullName;
    private readonly List<IDisposable> _resources = new();

    public void Dispose()
    {
        foreach (var resource in _resources)
        {
            resource.Dispose();
        }

        Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public async Task ShellExitClosesTheSocketWithPtyExited()
    {
        var (session, client) = await StartAsync("echo hello");

        var close = await ReceiveUntilCloseAsync(client);

        Assert.Equal(SessionHostService.PtyExitedStatus, close.Status);
        Assert.Equal(4001, (int)close.Status!);
        Assert.Equal("pty-exited", close.Description);
        Assert.Contains("hello", close.Output);
        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        await session.WaitAsync(Timeout);
    }

    [Fact]
    public async Task GatewaySecretNeverReachesShellsOrExecChildren()
    {
        const string secret = "gateway-secret-value";
        Environment.SetEnvironmentVariable(SessionHostAuth.SecretEnvName, secret);
        try
        {
            var (_, shellClient) = await StartAsync("env");
            var shell = await ReceiveUntilCloseAsync(shellClient);
            Assert.Contains("AXN_SESSION_ID=", shell.Output);
            Assert.DoesNotContain(secret, shell.Output);

            var (_, client) = await StartAsync("sleep 60");
            await ReceiveJsonAsync(client, "session");
            await SendTextAsync(client, JsonSerializer.Serialize(new { type = "exec", requestId = "env", argv = new[] { "env" } }));
            var exec = await ReceiveJsonAsync(client, "exec-result");
            Assert.Contains("LOGNAME=", exec.GetProperty("stdout").GetString());
            Assert.DoesNotContain(secret, exec.GetProperty("stdout").GetString());
        }
        finally
        {
            Environment.SetEnvironmentVariable(SessionHostAuth.SecretEnvName, null);
        }
    }

    [Fact]
    public async Task ClientCloseIsAnsweredWithANormalClose()
    {
        var (session, client) = await StartAsync("sleep 60");
        await ReceiveJsonAsync(client, "session");

        await client.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        var close = await ReceiveUntilCloseAsync(client);

        Assert.Equal(WebSocketCloseStatus.NormalClosure, close.Status);
        await session.WaitAsync(Timeout);
    }

    [Fact]
    public async Task KeystrokesFlowWhileAnExecIsRunning()
    {
        // `cat` echoes input; the exec blocks for seconds.
        var (_, client) = await StartAsync("cat");
        await ReceiveJsonAsync(client, "session");

        await SendTextAsync(client, JsonSerializer.Serialize(new { type = "exec", requestId = "slow", command = "sleep 3; echo slow" }));
        await client.SendAsync(Encoding.UTF8.GetBytes("ping\n"), WebSocketMessageType.Binary, true, CancellationToken.None);

        var output = new StringBuilder();
        while (true)
        {
            var text = await ReceiveTextAsync(client);
            if (text.Contains("\"exec-result\""))
            {
                Assert.Contains("ping", output.ToString());
                Assert.Contains("slow", text);
                break;
            }

            output.Append(text);
        }
    }

    [Fact]
    public async Task FsReadRefusesNonRegularFilesAndHugeFiles()
    {
        var (_, client) = await StartAsync("sleep 60");
        await ReceiveJsonAsync(client, "session");
        var big = Path.Combine(_dir, "big.bin");
        await using (var file = File.Create(big))
        {
            file.SetLength(SessionHostService.MaxReadBytes + 1);
        }
        var small = Path.Combine(_dir, "small.txt");
        await File.WriteAllTextAsync(small, "contents");

        await SendTextAsync(client, JsonSerializer.Serialize(new { type = "fs-read", requestId = "zero", path = "/dev/zero" }));
        var zero = await ReceiveJsonAsync(client, "fs-read-result");
        Assert.False(zero.GetProperty("ok").GetBoolean());
        Assert.Contains("not a regular file", zero.GetProperty("error").GetString());

        await SendTextAsync(client, JsonSerializer.Serialize(new { type = "fs-read", requestId = "big", path = big }));
        var tooBig = await ReceiveJsonAsync(client, "fs-read-result");
        Assert.False(tooBig.GetProperty("ok").GetBoolean());
        Assert.Contains("too large", tooBig.GetProperty("error").GetString());

        await SendTextAsync(client, JsonSerializer.Serialize(new { type = "fs-read", requestId = "small", path = small }));
        var ok = await ReceiveJsonAsync(client, "fs-read-result");
        Assert.True(ok.GetProperty("ok").GetBoolean());
        Assert.Equal("contents", ok.GetProperty("contents").GetString());
    }

    private async Task<(Task Session, WebSocket Client)> StartAsync(string cmd)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                // "root" keeps the PTY in-process even when tests run as root.
                ["PTY_USER"] = "root",
                ["PTY_CWD"] = _dir,
                ["AXN_STATE_DIR"] = Path.Combine(_dir, "state"),
            })
            .Build();
        var service = new SessionHostService(configuration, NullLogger<SessionHostService>.Instance);

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var tcpClient = new TcpClient();
        var connect = tcpClient.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
        var tcpServer = await listener.AcceptTcpClientAsync();
        await connect;
        listener.Stop();

        var server = WebSocket.CreateFromStream(tcpServer.GetStream(), new WebSocketCreationOptions { IsServer = true });
        var client = WebSocket.CreateFromStream(tcpClient.GetStream(), new WebSocketCreationOptions { IsServer = false });
        _resources.AddRange(new IDisposable[] { server, client, tcpServer, tcpClient });

        return (service.RunSessionAsync(server, cmd, null, CancellationToken.None), client);
    }

    private static Task SendTextAsync(WebSocket socket, string text) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    private static async Task<string> ReceiveTextAsync(WebSocket socket)
    {
        var buffer = new byte[64 * 1024];
        var message = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, CancellationToken.None).WaitAsync(Timeout);
            Assert.NotEqual(WebSocketMessageType.Close, result.MessageType);
            message.Write(buffer, 0, result.Count);
        }
        while (!result.EndOfMessage);

        return Encoding.UTF8.GetString(message.ToArray());
    }

    private static async Task<JsonElement> ReceiveJsonAsync(WebSocket socket, string type)
    {
        while (true)
        {
            var text = await ReceiveTextAsync(socket);
            if (text.StartsWith('{'))
            {
                var json = JsonDocument.Parse(text).RootElement;
                if (json.GetProperty("type").GetString() == type)
                {
                    return json;
                }
            }
        }
    }

    private static async Task<(WebSocketCloseStatus? Status, string? Description, string Output)> ReceiveUntilCloseAsync(WebSocket socket)
    {
        var buffer = new byte[64 * 1024];
        var output = new StringBuilder();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, CancellationToken.None).WaitAsync(Timeout);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return (result.CloseStatus, result.CloseStatusDescription, output.ToString());
            }

            output.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
        }
    }
}
