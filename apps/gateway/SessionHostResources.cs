using System.Globalization;

namespace Astropiano.AxnTerm.Gateway;

/// <summary>
/// Per-container resource limits and the isolation policy for session
/// hosts, parsed from the gateway env (pure — see SessionHostContainerService).
/// </summary>
public static class SessionHostResources
{
    public const string DefaultMemory = "4g";
    public const long DefaultPids = 4096;
    public const string DefaultCpus = "2";

    /// <summary>
    /// Docker-style memory size ("512m", "4g", plain bytes); binary units.
    /// Unset → <see cref="DefaultMemory"/>, "0" → no limit.
    /// </summary>
    public static long ParseMemory(string? value)
    {
        var text = string.IsNullOrWhiteSpace(value) ? DefaultMemory : value.Trim().ToLowerInvariant();
        if (text.EndsWith('b'))
        {
            text = text[..^1];
        }

        var multiplier = text.Length > 0 ? text[^1] switch
        {
            'k' => 1L << 10,
            'm' => 1L << 20,
            'g' => 1L << 30,
            't' => 1L << 40,
            _ => 1L,
        } : 1L;
        var number = multiplier == 1L ? text : text[..^1];
        if (!decimal.TryParse(number, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var amount) || amount < 0)
        {
            throw new InvalidOperationException($"SESSION_HOST_MEMORY: invalid size '{value}'");
        }

        return (long)(amount * multiplier);
    }

    /// <summary>Unset → <see cref="DefaultPids"/>, "0" → no limit.</summary>
    public static long? ParsePids(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return DefaultPids;
        }

        if (!long.TryParse(value.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var pids))
        {
            throw new InvalidOperationException($"SESSION_HOST_PIDS: invalid count '{value}'");
        }

        return pids == 0 ? null : pids;
    }

    /// <summary>CPUs as docker NanoCPUs ("1.5" → 1.5e9). Unset → <see cref="DefaultCpus"/>, "0" → no limit.</summary>
    public static long ParseNanoCpus(string? value)
    {
        var text = string.IsNullOrWhiteSpace(value) ? DefaultCpus : value.Trim();
        if (!decimal.TryParse(text, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var cpus) || cpus < 0)
        {
            throw new InvalidOperationException($"SESSION_HOST_CPUS: invalid CPU count '{value}'");
        }

        return (long)(cpus * 1_000_000_000m);
    }

    /// <summary>
    /// DIND/privileged session hosts hand the user (near-)root on the
    /// kernel they run on. That is only contained by a VM runtime like kata;
    /// under runc it is the host kernel. Refuses the combination unless
    /// SESSION_HOST_ALLOW_UNSAFE_RUNC is set; returns a warning to log then.
    /// </summary>
    public static string? ValidateIsolation(bool dind, bool privileged, string? runtime, bool allowUnsafeRunc)
    {
        if (!dind && !privileged)
        {
            return null;
        }

        if (runtime?.Contains("kata", StringComparison.OrdinalIgnoreCase) == true)
        {
            return null;
        }

        var flags = string.Join(" + ", new[] { dind ? "SESSION_HOST_DIND" : null, privileged ? "SESSION_HOST_PRIVILEGED" : null }
            .Where(f => f is not null));
        if (!allowUnsafeRunc)
        {
            throw new InvalidOperationException(
                $"{flags} requires SESSION_HOST_RUNTIME=kata (or SESSION_HOST_ALLOW_UNSAFE_RUNC=1 to accept host-kernel exposure)");
        }

        return $"{flags} without a VM runtime: session users get root-equivalent access to the host kernel (SESSION_HOST_ALLOW_UNSAFE_RUNC=1)";
    }
}
