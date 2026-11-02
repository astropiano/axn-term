using System.Security.Cryptography;
using System.Text;

namespace AxnTerm.SessionHost;

/// <summary>
/// Shared-secret check between the gateway and this host. Session hosts
/// listen on a docker network every user's container shares, so without it
/// any shell could open another user's PTY. The gateway generates one
/// secret per container (AXN_SESSION_HOST_SECRET) and presents it as the
/// X-Axn-Session-Secret header on every request.
/// </summary>
public static class SessionHostAuth
{
    public const string SecretEnvName = "AXN_SESSION_HOST_SECRET";
    /// <summary>
    /// Path of a file holding the secret. The container entrypoint moves the
    /// gateway's env var into a root-only file so no PTY or exec child can
    /// inherit it from the process environment.
    /// </summary>
    public const string SecretFileEnvName = "AXN_SESSION_HOST_SECRET_FILE";
    public const string InsecureEnvName = "AXN_SESSION_HOST_INSECURE";
    public const string HeaderName = "X-Axn-Session-Secret";

    /// <summary>
    /// The secret every request must present; null only in the explicit
    /// AXN_SESSION_HOST_INSECURE=1 mode (local dev — browsers can't set the
    /// header when apps/web talks to a host directly). Neither set → throws:
    /// the host refuses to start rather than serve shells to anyone.
    /// </summary>
    public static string? ResolveSecret(string? secret, string? insecure)
    {
        if (!string.IsNullOrEmpty(secret))
        {
            return secret;
        }

        if (insecure == "1" || insecure?.Equals("true", StringComparison.OrdinalIgnoreCase) == true)
        {
            return null;
        }

        throw new InvalidOperationException(
            $"{SecretEnvName} is required (set {InsecureEnvName}=1 to run without authentication, local development only)");
    }

    /// <summary>
    /// The secret from <paramref name="secret"/> (env) or, when that is
    /// empty, the trimmed contents of <paramref name="secretFile"/>.
    /// </summary>
    public static string? ReadSecret(string? secret, string? secretFile)
    {
        if (!string.IsNullOrEmpty(secret))
        {
            return secret;
        }

        return string.IsNullOrEmpty(secretFile) ? null : File.ReadAllText(secretFile).Trim();
    }

    /// <summary>Constant-time comparison; a null <paramref name="expected"/> (insecure mode) admits everything.</summary>
    public static bool IsAuthorized(string? expected, string? provided)
    {
        if (expected is null)
        {
            return true;
        }

        return provided is not null
            && CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(provided));
    }
}
