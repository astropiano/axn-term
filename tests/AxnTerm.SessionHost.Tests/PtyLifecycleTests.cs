using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using AxnTerm.SessionHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace AxnTerm.SessionHost.Tests;

/// <summary>PTYs registered in the host must not outlive their owner.</summary>
public sealed class PtyLifecycleTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("axn-lifecycle-test").FullName;
    private readonly PtyHost _host;
    private readonly ControlBroker _control = new();

    public PtyLifecycleTests()
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
        _host = new PtyHost(configuration, NullLogger<PtyHost>.Instance, _control);
    }

    public void Dispose()
    {
        foreach (var session in _host.Sessions.Values.ToList())
        {
            _host.Kill(session);
            _host.Remove(session.Id);
        }

        Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public async Task ClientGoneBeforeTheSessionMessageReapsThePty()
    {
        var service = new SessionHostService(
            _host, _control, NullLogger<SessionHostService>.Instance, NullLogger<WsControlRouter>.Instance);

        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        using var tcpClient = new TcpClient();
        var connect = tcpClient.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
        using var tcpServer = await listener.AcceptTcpClientAsync();
        await connect;
        listener.Stop();
        using var server = WebSocket.CreateFromStream(tcpServer.GetStream(), new WebSocketCreationOptions { IsServer = true });
        // The client aborted between upgrade and the `session` message.
        server.Abort();

        await Assert.ThrowsAnyAsync<Exception>(() => service.RunSessionAsync(server, "sleep 60", null, CancellationToken.None));

        Assert.Empty(_host.Sessions);
    }

    [Fact]
    public async Task ConcurrentCreatesOfOneIdSpawnOnce()
    {
        var spawns = 0;
        async Task<PtySession?> Spawn()
        {
            Interlocked.Increment(ref spawns);
            // Widen the window between the live check and registration.
            await Task.Delay(200);
            return await _host.SpawnAsync("same-id", "sleep 60", null, 80, 24, CancellationToken.None);
        }

        var results = await Task.WhenAll(
            AxnHostVm.LiveOrSpawnAsync(_host, "same-id", () => false, Spawn),
            AxnHostVm.LiveOrSpawnAsync(_host, "same-id", () => false, Spawn));

        Assert.Equal(1, spawns);
        Assert.Single(results, r => r.Spawned);
        Assert.Single(results, r => !r.Spawned);
        Assert.Same(results[0].Pty, results[1].Pty);
        Assert.NotNull(results[0].Pty);
    }
}
