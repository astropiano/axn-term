import type { TokenSet } from '@axn-term/session-backend';

/**
 * The app's sign-in (device-flow token set) in its one private storage —
 * the same for every network, so LAN and tailnet are one session and the
 * desktop sees one device. Keyed by server id: pairing another server
 * never reuses these tokens.
 */

const KEY = 'axn-mobile:session';

interface Stored {
  serverId: string;
  clientId: string;
  tokens: TokenSet;
}

export function loadSession(serverId: string, clientId: string): TokenSet | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    return s && s.serverId === serverId && s.clientId === clientId && s.tokens?.accessToken ? s.tokens : null;
  } catch {
    return null;
  }
}

export function saveSession(serverId: string, clientId: string, tokens: TokenSet): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ serverId, clientId, tokens } satisfies Stored));
  } catch {
    // storage unavailable — the sign-in lasts for this run only
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Refresh token of whatever session is stored (for revoking on unpair). */
export function storedRefreshToken(): { clientId: string; refreshToken?: string } | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
    return s ? { clientId: s.clientId, refreshToken: s.tokens.refreshToken } : null;
  } catch {
    return null;
  }
}
