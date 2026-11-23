using System.Net.WebSockets;

namespace AxnTerm.Gateway;

public static class WebSocketProxy
{
    private const int BufferSize = 8192;

    /// <summary>How long the second direction may take to finish the close handshake.</summary>
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Query parameters the session host consumes — sub-shell spawns use
    /// `?cmd=`/`?cwd=` to select the PTY command/directory. Everything else
    /// (notably `access_token`) stays at the gateway.
    /// </summary>
    private static readonly string[] ForwardedQueryKeys = ["cmd", "cwd"];

    public static readonly TimeSpan KeepAliveInterval = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan KeepAliveTimeout = TimeSpan.FromSeconds(60);

    public static async Task RunAsync(
        WebSocket serverSocket,
        SessionHostEndpoint host,
        string path,
        string? queryString = null,
        CancellationToken cancellationToken = default)
    {
        var uri = new Uri($"ws://{host.Host}:{host.Port}{path}{queryString}");
        using var client = new ClientWebSocket();
        client.Options.SetRequestHeader(SessionHostSecret.HeaderName, host.Secret);
        client.Options.KeepAliveInterval = KeepAliveInterval;
        client.Options.KeepAliveTimeout = KeepAliveTimeout;
        await client.ConnectAsync(uri, cancellationToken);

        await BridgeAsync(serverSocket, client, cancellationToken);
    }

    /// <summary>The client query reduced to <see cref="ForwardedQueryKeys"/> ("" when none).</summary>
    public static string ForwardedQuery(IQueryCollection query) =>
        QueryString.Create(ForwardedQueryKeys.SelectMany(
            key => query[key].Select(value => KeyValuePair.Create(key, value)))).Value ?? "";

    /// <summary>
    /// The client query minus `access_token` ("" when nothing is left): the
    /// /cloud hub passes its other parameters through, but the JWT stays at
    /// the gateway — the session host authenticates the gateway by its
    /// shared secret, never by the user's token.
    /// </summary>
    public static string QueryWithoutToken(IQueryCollection query) =>
        QueryString.Create(query
            .Where(pair => !string.Equals(pair.Key, "access_token", StringComparison.OrdinalIgnoreCase))
            .SelectMany(pair => pair.Value.Select(value => KeyValuePair.Create(pair.Key, value)))).Value ?? "";

    /// <summary>
    /// Relays frames both ways until one side closes, then hands that close
    /// — status and description — to the other side, so session-host close
    /// codes (4001 "pty-exited") reach the browser unchanged.
    /// </summary>
    public static async Task BridgeAsync(WebSocket client, WebSocket host, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var toHost = PumpAsync(client, host, cts.Token);
        var toClient = PumpAsync(host, client, cts.Token);

        // The first direction to end has relayed its close; the other one
        // ends once the peer answers it. A peer that never answers is
        // aborted after the handshake timeout.
        var first = await Task.WhenAny(toHost, toClient);
        var other = first == toHost ? toClient : toHost;
        await Task.WhenAny(other, Task.Delay(CloseHandshakeTimeout, cts.Token));
        cts.Cancel();
        await Task.WhenAll(toHost, toClient);
    }

    /// <summary>
    /// The close to send on after <paramref name="received"/> arrived on the
    /// other side; null means that side dropped without a close frame.
    /// </summary>
    public static (WebSocketCloseStatus Status, string? Description) ResolveCloseStatus(
        WebSocketCloseStatus? received, string? description) => received switch
    {
        null => (WebSocketCloseStatus.EndpointUnavailable, "peer disconnected"),
        // A close frame without a status code carries no description either.
        WebSocketCloseStatus.Empty => (WebSocketCloseStatus.Empty, null),
        var status => (status.Value, description),
    };

    private static async Task PumpAsync(WebSocket source, WebSocket destination, CancellationToken cancellationToken)
    {
        var buffer = new byte[BufferSize];
        WebSocketCloseStatus? closeStatus = null;
        string? closeDescription = null;

        try
        {
            while (true)
            {
                var result = await source.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    closeStatus = result.CloseStatus;
                    closeDescription = result.CloseStatusDescription;
                    break;
                }

                await destination.SendAsync(
                    new ArraySegment<byte>(buffer, 0, result.Count),
                    result.MessageType,
                    result.EndOfMessage,
                    cancellationToken);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            // Dropped connection or teardown — relayed below as "peer disconnected".
        }

        if (destination.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            return;
        }

        var (status, description) = ResolveCloseStatus(closeStatus, closeDescription);
        try
        {
            // Output-only close: this pump is the destination's only sender,
            // the opposite pump keeps receiving its answer.
            await destination.CloseOutputAsync(status, description, cancellationToken);
        }
        catch
        {
            // ignored — the destination is gone too
        }
    }
}
