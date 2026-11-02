using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using AxnTerm.Gateway;

namespace AxnTerm.Gateway.Tests;

public class WebSocketProxyTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    [Fact]
    public void ResolveCloseStatusKeepsTheReceivedClose()
    {
        Assert.Equal(
            ((WebSocketCloseStatus)4001, "pty-exited"),
            WebSocketProxy.ResolveCloseStatus((WebSocketCloseStatus)4001, "pty-exited"));
        Assert.Equal(
            (WebSocketCloseStatus.NormalClosure, "bye"),
            WebSocketProxy.ResolveCloseStatus(WebSocketCloseStatus.NormalClosure, "bye"));
        Assert.Equal(
            (WebSocketCloseStatus.Empty, (string?)null),
            WebSocketProxy.ResolveCloseStatus(WebSocketCloseStatus.Empty, ""));
    }

    [Fact]
    public void ResolveCloseStatusReportsADroppedPeer()
    {
        var (status, _) = WebSocketProxy.ResolveCloseStatus(null, null);

        Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, status);
    }

    [Fact]
    public async Task RelaysFramesBothWays()
    {
        await using var proxy = await Proxy.StartAsync();

        await SendTextAsync(proxy.Browser, "keys");
        Assert.Equal("keys", await ReceiveTextAsync(proxy.Host));

        await SendTextAsync(proxy.Host, "output");
        Assert.Equal("output", await ReceiveTextAsync(proxy.Browser));
    }

    [Fact]
    public async Task HostCloseStatusReachesTheBrowser()
    {
        await using var proxy = await Proxy.StartAsync();

        await proxy.Host.CloseOutputAsync((WebSocketCloseStatus)4001, "pty-exited", CancellationToken.None);

        var close = await proxy.Browser.ReceiveAsync(new byte[16], CancellationToken.None).WaitAsync(Timeout);
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        Assert.Equal((WebSocketCloseStatus)4001, close.CloseStatus);
        Assert.Equal("pty-exited", close.CloseStatusDescription);

        // The browser's answer completes the handshake on the host side too.
        await proxy.Browser.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        var echo = await proxy.Host.ReceiveAsync(new byte[16], CancellationToken.None).WaitAsync(Timeout);
        Assert.Equal(WebSocketMessageType.Close, echo.MessageType);
        await proxy.Bridge.WaitAsync(Timeout);
    }

    [Fact]
    public async Task BrowserCloseStatusReachesTheHost()
    {
        await using var proxy = await Proxy.StartAsync();

        await proxy.Browser.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "tab closed", CancellationToken.None);

        var close = await proxy.Host.ReceiveAsync(new byte[16], CancellationToken.None).WaitAsync(Timeout);
        Assert.Equal(WebSocketCloseStatus.NormalClosure, close.CloseStatus);
        Assert.Equal("tab closed", close.CloseStatusDescription);

        await proxy.Host.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        await proxy.Bridge.WaitAsync(Timeout);
    }

    [Fact]
    public async Task DroppedHostIsNotReportedAsAPtyExit()
    {
        await using var proxy = await Proxy.StartAsync();

        proxy.Host.Abort();
        proxy.HostTcp.Dispose();

        var close = await proxy.Browser.ReceiveAsync(new byte[16], CancellationToken.None).WaitAsync(Timeout);
        Assert.Equal(WebSocketMessageType.Close, close.MessageType);
        Assert.Equal(WebSocketCloseStatus.EndpointUnavailable, close.CloseStatus);
    }

    private static Task SendTextAsync(WebSocket socket, string text) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    private static async Task<string> ReceiveTextAsync(WebSocket socket)
    {
        var buffer = new byte[1024];
        var result = await socket.ReceiveAsync(buffer, CancellationToken.None).WaitAsync(Timeout);
        Assert.Equal(WebSocketMessageType.Text, result.MessageType);
        return Encoding.UTF8.GetString(buffer, 0, result.Count);
    }

    /// <summary>browser ⇄ [gateway server | BridgeAsync | gateway client] ⇄ session host, over loopback TCP.</summary>
    private sealed class Proxy : IAsyncDisposable
    {
        private readonly List<IDisposable> _resources = new();

        public WebSocket Browser { get; private set; } = null!;
        public WebSocket Host { get; private set; } = null!;
        public TcpClient HostTcp { get; private set; } = null!;
        public Task Bridge { get; private set; } = null!;

        public static async Task<Proxy> StartAsync()
        {
            var proxy = new Proxy();
            var (gatewayServer, browser, _) = await proxy.PairAsync();
            var (host, gatewayClient, hostTcp) = await proxy.PairAsync();
            proxy.Browser = browser;
            proxy.Host = host;
            proxy.HostTcp = hostTcp;
            proxy.Bridge = WebSocketProxy.BridgeAsync(gatewayServer, gatewayClient, CancellationToken.None);
            return proxy;
        }

        public async ValueTask DisposeAsync()
        {
            foreach (var resource in _resources)
            {
                resource.Dispose();
            }

            try
            {
                await Bridge.WaitAsync(Timeout);
            }
            catch
            {
                // assertions already ran
            }
        }

        /// <returns>(server side, client side, server TCP connection)</returns>
        private async Task<(WebSocket, WebSocket, TcpClient)> PairAsync()
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var client = new TcpClient();
            var connect = client.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
            var server = await listener.AcceptTcpClientAsync();
            await connect;
            listener.Stop();

            var serverSocket = WebSocket.CreateFromStream(server.GetStream(), new WebSocketCreationOptions { IsServer = true });
            var clientSocket = WebSocket.CreateFromStream(client.GetStream(), new WebSocketCreationOptions { IsServer = false });
            _resources.AddRange(new IDisposable[] { serverSocket, clientSocket, server, client });
            return (serverSocket, clientSocket, server);
        }
    }
}
