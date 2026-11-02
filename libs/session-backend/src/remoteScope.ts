/**
 * Tenant-scoped remote sessions.
 *
 * On the axn-term gateway a mirrored session id is namespaced by the
 * publishing account: `<jwt-sub>/<id>`. The prefix makes ownership
 * self-proving — `AuthorizeHello` only checks that the caller's sub owns
 * the prefix, so isolation survives gateway restarts with no shared state
 * (no Redis, no in-memory registry on the auth path).
 */

/** Decode the `sub` claim of a JWT without verifying (the server verifies). */
export function jwtSub(token: string | undefined): string | undefined {
  if (!token) return undefined;
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as Record<string, unknown>;
    return typeof json.sub === 'string' ? json.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Namespace a session id under the token's account. Unscoped ids pass
 * through unchanged — only the AllowAnonymous dev path still accepts
 * them; authenticated hellos without the prefix are rejected.
 */
export function scopeSessionId(
  id: string | undefined,
  token: string | undefined,
): string | undefined {
  const sub = jwtSub(token);
  if (!sub || !id || id.startsWith(`${sub}/`)) return id;
  return `${sub}/${id}`;
}

/**
 * The mirrored sessions the token's account owns — the gateway's
 * `/remote/sessions` discovery endpoint, owner-scoped server-side.
 * `url` is the hub URL (`ws(s)://…/remote`); sessions list lives at
 * `<hub>/sessions` over plain HTTP.
 */
/** One mirrored session as discovery reports it. */
export interface RemoteSessionInfo {
  id: string;
  /** Authority is attached — streams/invokes can be served right now.
   * Offline mirrors stay listed (a desktop may come back), but viewers
   * should prefer online entries and show offline ones as such. */
  online: boolean;
}

export async function listRemoteSessions(
  url: string,
  token: string | undefined,
): Promise<RemoteSessionInfo[]> {
  const http = url.replace(/^ws/, 'http').replace(/\/+$/, '');
  const res = await fetch(`${http}/sessions`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok)
    // 401/403 = stale session, not 'no sessions' — callers must see the
    // real status or they'll error-search a mirror that was never asked.
    throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { sessions?: unknown; sessionDetails?: unknown };
  // sessionDetails carries authority-online state; bare `sessions` is the
  // back-compat string list older clients (and older gateways) exchange.
  const entries = Array.isArray(body.sessionDetails)
    ? body.sessionDetails
    : Array.isArray(body.sessions)
      ? body.sessions
      : [];
  return entries.map((s) =>
    typeof s === 'string'
      ? { id: s, online: true }
      : {
          id: String((s as { id?: unknown })?.id ?? ''),
          online: (s as { online?: unknown })?.online !== false,
        },
  );
}
