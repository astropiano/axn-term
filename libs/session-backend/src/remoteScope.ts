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

/* ── "Why doesn't my desktop show up?" ─────────────────────────────────
 * GET <hub>/status — the account's mirrored sessions plus its recent hub
 * hello attempts (with the reason each denied one was refused). Viewers
 * show it while they wait, desktops next to their publish state.
 */

export interface RemoteHelloAttempt {
  at: string;
  /** 'Authority' (a desktop publishing) | 'Controller' | 'Viewer'. */
  role: string;
  session?: string | null;
  accepted: boolean;
  reason?: string | null;
}

export interface RemoteStatus {
  account: { sub: string; user?: string | null };
  sessions: RemoteSessionInfo[];
  attempts: RemoteHelloAttempt[];
}

// Plain fields, no parameter properties: the e2e scripts load these
// sources with `node --experimental-strip-types`, which can't parse them.
export class RemoteStatusError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchRemoteStatus(
  url: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteStatus> {
  const http = url.replace(/^ws/, 'http').replace(/\/+$/, '');
  const res = await fetchImpl(`${http}/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  const body = (await res.json().catch(() => null)) as (Partial<RemoteStatus> & { error?: string }) | null;
  if (!res.ok) throw new RemoteStatusError(body?.error ?? `HTTP ${res.status}`, res.status);
  return {
    account: body?.account ?? { sub: '' },
    sessions: Array.isArray(body?.sessions) ? body.sessions : [],
    attempts: Array.isArray(body?.attempts) ? body.attempts : [],
  };
}

export interface RemoteStatusSummary {
  /** waiting = nothing yet; denied = the desktop tried and was refused;
   *  offline = it was here and went away; online = attachable. */
  kind: 'waiting' | 'denied' | 'offline' | 'online';
  title: string;
  detail: string;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return 'recently';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** Plain-language state for the viewer's waiting screen. */
export function describeRemoteStatus(status: RemoteStatus, now = Date.now()): RemoteStatusSummary {
  const who = status.account.user ? ` for ${status.account.user}` : '';
  if (status.sessions.some((s) => s.online))
    return { kind: 'online', title: 'Desktop online', detail: 'Connecting to it…' };
  const lastDesktop = status.attempts.find((a) => a.role.toLowerCase() === 'authority');
  if (lastDesktop && !lastDesktop.accepted)
    return {
      kind: 'denied',
      title: 'Your desktop was refused',
      detail: `It tried to connect ${ago(lastDesktop.at, now)}: ${lastDesktop.reason ?? 'refused'}. ` +
        'In axn-term on the computer, open Remote and sign in again with this same account.',
    };
  if (status.sessions.length)
    return {
      kind: 'offline',
      title: 'Your desktop is offline',
      detail: 'It was connected before. Check that axn-term is running on the computer and has network.',
    };
  return {
    kind: 'waiting',
    title: `No desktop is publishing${who} yet`,
    detail:
      'On your computer, open axn-term → Remote (globe icon) → enter this server under Server → Connect, ' +
      'then Sign in with the same account you used here.',
  };
}
