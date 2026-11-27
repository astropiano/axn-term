import type { SessionBackend } from '@axn-term/session-backend';

/**
 * Pausing a PTY's output is one switch on the backend, but two things want to
 * flip it: the mounted terminal's xterm watermarks and the headless buffer's
 * queue. Each is a vote — the PTY runs again only when nobody wants it paused,
 * so one side resuming cannot release the other's pause.
 */
const votes = new WeakMap<object, Map<string, Set<string>>>();

export function setPtyPaused(backend: SessionBackend, ptyId: string, reason: string, paused: boolean): void {
  let perPty = votes.get(backend);
  if (!perPty) votes.set(backend, (perPty = new Map()));
  let reasons = perPty.get(ptyId);
  if (!reasons) perPty.set(ptyId, (reasons = new Set()));
  const was = reasons.size > 0;
  if (paused) reasons.add(reason);
  else reasons.delete(reason);
  const is = reasons.size > 0;
  if (!was && is) backend.pause?.(ptyId);
  else if (was && !is) backend.resume?.(ptyId);
  if (!is) perPty.delete(ptyId);
}
