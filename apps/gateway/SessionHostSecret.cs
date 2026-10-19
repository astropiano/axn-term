using System.Buffers.Text;
using System.Security.Cryptography;

namespace Astropiano.AxnTerm.Gateway;

/// <summary>
/// Per-container shared secret between the gateway and a session host.
/// Session hosts share one docker network under predictable names, so
/// without it any user's shell could connect to another user's host.
/// </summary>
public static class SessionHostSecret
{
    /// <summary>Container env var the session host reads its secret from.</summary>
    public const string EnvName = "AXN_SESSION_HOST_SECRET";

    /// <summary>Request header the gateway presents on every call to a host.</summary>
    public const string HeaderName = "X-Axn-Session-Secret";

    /// <summary>32 random bytes, base64url — fits an env var and a header verbatim.</summary>
    public static string Generate() => Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    /// <summary>
    /// Reads the secret back from a container's `Config.Env` so it survives
    /// gateway restarts; null when the container was created without one.
    /// </summary>
    public static string? FromEnv(IEnumerable<string>? env)
    {
        const string prefix = EnvName + "=";
        var entry = env?.LastOrDefault(e => e.StartsWith(prefix, StringComparison.Ordinal));
        var value = entry?[prefix.Length..];
        return string.IsNullOrEmpty(value) ? null : value;
    }
}

/// <summary>A running session host: its container name and shared secret.</summary>
public sealed record SessionHostEndpoint(string Host, int Port, string Secret);
