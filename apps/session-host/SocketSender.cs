using System.Net.WebSockets;
using System.Text.Json;

namespace AxnTerm.SessionHost;

/// <summary>
/// Serializes every send on one WebSocket. A WebSocket allows only one
/// outstanding send (close frames included), while the PTY output pump,
/// off-loop control replies and the task poller all write to the same
/// socket — each of them goes through here.
/// </summary>
public sealed class SocketSender
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public SocketSender(WebSocket socket)
    {
        Socket = socket;
    }

    public WebSocket Socket { get; }

    /// <summary>Open, or closed by the peer only — sends are still allowed.</summary>
    public bool CanSend => Socket.State is WebSocketState.Open or WebSocketState.CloseReceived;

    public async Task SendAsync(ReadOnlyMemory<byte> payload, WebSocketMessageType type, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await Socket.SendAsync(payload, type, true, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public Task SendJsonAsync(object payload, CancellationToken cancellationToken) =>
        SendAsync(JsonSerializer.SerializeToUtf8Bytes(payload), WebSocketMessageType.Text, cancellationToken);

    /// <summary>
    /// Sends a close frame without waiting for the answer — the receive loop
    /// (owned elsewhere) sees it. No-op once this side has closed.
    /// </summary>
    public async Task CloseOutputAsync(WebSocketCloseStatus status, string? description, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (CanSend)
            {
                await Socket.CloseOutputAsync(status, description, cancellationToken);
            }
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException)
        {
            // already gone
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Full close handshake; only valid once nothing else receives on the socket.</summary>
    public async Task CloseAsync(WebSocketCloseStatus status, string? description, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (CanSend)
            {
                await Socket.CloseAsync(status, description, cancellationToken);
            }
        }
        catch
        {
            // ignored
        }
        finally
        {
            _gate.Release();
        }
    }
}
