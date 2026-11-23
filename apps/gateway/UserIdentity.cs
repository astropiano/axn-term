using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace AxnTerm.Gateway;

/// <summary>
/// Maps an authenticated principal to the user id that names its session
/// host container, home/nix volumes and in-container account.
/// </summary>
public static class UserIdentity
{
    private const int MaxHashedPrefixLength = 23;

    /// <summary>Every id the hashing branch of <see cref="ToUserId"/> can
    /// return: a letter-led prefix of at most 23 chars not ending in '-'/'_',
    /// then '-' and 8 lowercase hex.</summary>
    private static readonly Regex HashedIdShape = new(
        "^[a-z](?:[a-z0-9_-]{0,21}[a-z0-9])?-[0-9a-f]{8}$", RegexOptions.CultureInvariant);

    /// <summary>What the session-host entrypoint accepts as an account name
    /// (it falls back to "axn" otherwise, while the PTY still targets the
    /// id). Clean names already exclude a leading '_'/'-'.</summary>
    private static readonly Regex LinuxUserName = new(
        "^[a-z][a-z0-9_-]{0,31}$", RegexOptions.CultureInvariant);

    /// <summary>Accounts and groups that already exist in the session-host
    /// image: the entrypoint reuses an existing account instead of creating
    /// one, so passing e.g. "root" through would hand out a root PTY. Keep
    /// in sync with the image's /etc/passwd and /etc/group.</summary>
    private static readonly HashSet<string> ReservedNames = new(StringComparer.Ordinal)
    {
        // /etc/passwd
        "root", "daemon", "bin", "sys", "sync", "games", "man", "lp", "mail",
        "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "gnats",
        "nobody", "ubuntu", "app",
        // /etc/group
        "adm", "tty", "disk", "kmem", "dialout", "fax", "voice", "cdrom",
        "floppy", "tape", "sudo", "audio", "dip", "operator", "src", "shadow",
        "utmp", "video", "sasl", "plugdev", "staff", "users", "nogroup", "docker",
    };

    /// <summary>
    /// The token's user name (preferred_username, then sub) mapped through
    /// <see cref="ToUserId"/>; null when the token carries no identity claim —
    /// callers answer 401. There is deliberately no client-supplied or
    /// default fallback: the id selects whose shell the caller gets.
    /// </summary>
    public static string? Resolve(ClaimsPrincipal user)
    {
        var name = user.Identity?.Name;
        if (string.IsNullOrWhiteSpace(name))
        {
            name = user.FindFirst("preferred_username")?.Value;
        }

        if (string.IsNullOrWhiteSpace(name))
        {
            name = user.FindFirst(ClaimTypes.NameIdentifier)?.Value
                ?? user.FindFirst("sub")?.Value;
        }

        return string.IsNullOrWhiteSpace(name) ? null : ToUserId(name);
    }

    /// <summary>
    /// Container/volume-safe id for a raw user name. Names that are already
    /// clean — ASCII lowercase letters, digits, '-' and '_', not starting or
    /// ending with '-'/'_' — pass through unchanged, so existing users keep
    /// their container and home volume names. Any name sanitizing would
    /// alter (case, dots, non-ASCII, …) becomes
    /// "&lt;ascii-sanitized-prefix&gt;-&lt;first 8 hex of sha256(raw)&gt;": stripping
    /// characters is lossy ("john.doe" and "johndoe" would otherwise share a
    /// container and home), the hash keeps distinct raw names apart. The
    /// prefix is capped so the result stays a valid 32-char Linux user name
    /// (the entrypoint creates an account from it).
    /// A clean name that has exactly the shape of a hashed id (e.g.
    /// "johndoe-30f69670") is hashed as well — otherwise a user could pick
    /// the hashed id of someone else ("john.doe") as their name and get
    /// that user's container and home.
    /// Clean names that are not a valid Linux user name (longer than 32
    /// chars, or not starting with a letter, e.g. "2fa-tester") or that name
    /// an account/group of the session-host image ("root", "daemon", …) are
    /// hashed too: the entrypoint could not create that account, or would
    /// reuse the existing system one. Every other clean name keeps its id.
    /// </summary>
    public static string ToUserId(string rawName)
    {
        var sanitized = SanitizeAscii(rawName);
        if (sanitized == rawName
            && LinuxUserName.IsMatch(rawName)
            && !ReservedNames.Contains(rawName)
            && !HashedIdShape.IsMatch(rawName))
        {
            return rawName;
        }

        var prefix = sanitized.Length > MaxHashedPrefixLength
            ? sanitized[..MaxHashedPrefixLength].TrimEnd('-', '_')
            : sanitized;
        // Linux user names must start with a letter or '_'.
        if (prefix.Length == 0 || !char.IsAsciiLetterLower(prefix[0]))
        {
            prefix = "u" + prefix;
            if (prefix.Length > MaxHashedPrefixLength)
            {
                prefix = prefix[..MaxHashedPrefixLength].TrimEnd('-', '_');
            }
        }

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(rawName));
        return $"{prefix}-{Convert.ToHexStringLower(hash)[..8]}";
    }

    private static string SanitizeAscii(string name)
    {
        var builder = new StringBuilder(name.Length);
        foreach (var c in name)
        {
            // ASCII-only folding: Unicode case mapping would turn e.g. the
            // Kelvin sign into a plain 'k'.
            var lower = char.IsAsciiLetterUpper(c) ? (char)(c + ('a' - 'A')) : c;
            if (char.IsAsciiLetterLower(lower) || char.IsAsciiDigit(lower) || lower is '-' or '_')
            {
                builder.Append(lower);
            }
        }

        return builder.ToString().Trim('-', '_');
    }
}
