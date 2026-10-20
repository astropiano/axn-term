import type { ControlReply } from '@axn-term/session-backend';
import { ptyIdOf, type ShellSession } from '../types';

export type { ControlReply };

/**
 * `axn-term session …` requests from programs inside a terminal (desktop:
 * control socket, `src-tauri/src/control.rs`; web: the session host's
 * ControlBroker via the backend): the session a PTY belongs to,
 * and how a dispatch result becomes the CLI's answer.
 */

/** The session owning a PTY — its main shell (incl. a promoted one) or a sub-shell tab. */
export function sessionForPty(sessions: readonly ShellSession[], ptyId: string): ShellSession | undefined {
  return (
    sessions.find((s) => ptyIdOf(s) === ptyId) ??
    sessions.find((s) => (s.editors ?? []).some((e) => e.kind === 'shell' && e.id === ptyId)) ??
    sessions.find((s) => s.id === ptyId)
  );
}

/**
 * A dispatch result as the CLI's reply: swallowed = done; an `echo "<msg>"`
 * replacement (how commands report back into the shell) = its message;
 * any other replacement is a command for the shell — not run from here; no
 * handler = not a command.
 */
export function controlReply(line: string, result: string | false | undefined): ControlReply {
  if (result === false) return { ok: true };
  if (result === undefined) return { ok: false, error: `not an axn-term command: ${line.split(/\s+/)[0]}` };
  const echo = /^echo\s+("(?:[^"\\]|\\.)*")\s*$/.exec(result);
  if (echo) {
    try {
      return { ok: true, message: JSON.parse(echo[1]) as string };
    } catch {
      // not JSON-quoted — fall through
    }
  }
  return { ok: false, error: `this command has to be typed at the shell prompt: ${result}` };
}
