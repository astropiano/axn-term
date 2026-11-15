using System.Collections.Concurrent;

namespace AxnTerm.Gateway;

/// <summary>
/// The last hub hello attempts per account, so a client can ask "what
/// happened to my desktop?" (GET /remote/status) instead of the user
/// reading gateway logs. Keyed by the token's subject — taken unverified
/// for failed attempts, so a forged token can only add entries to the
/// account it names, which only that account can read. In memory: a
/// restart forgets, which is fine for a "why isn't it connecting" view.
/// </summary>
public sealed class RemoteDiagnostics(TimeProvider? clock = null)
{
    public const int PerAccount = 20;

    private readonly TimeProvider _clock = clock ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, LinkedList<Attempt>> _attempts = new();

    public sealed record Attempt(
        DateTimeOffset At,
        string Role,
        string? Session,
        bool Accepted,
        string? Reason);

    public void Record(string? sub, string role, string? session, bool accepted, string? reason)
    {
        if (string.IsNullOrEmpty(sub))
        {
            return; // no account to show it to
        }
        var list = _attempts.GetOrAdd(sub, _ => new LinkedList<Attempt>());
        lock (list)
        {
            list.AddFirst(new Attempt(_clock.GetUtcNow(), role, session, accepted, reason));
            while (list.Count > PerAccount)
            {
                list.RemoveLast();
            }
        }
    }

    /// <summary>Newest first.</summary>
    public IReadOnlyList<Attempt> For(string sub)
    {
        if (!_attempts.TryGetValue(sub, out var list))
        {
            return [];
        }
        lock (list)
        {
            return [.. list];
        }
    }
}
