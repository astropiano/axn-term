import type { SessionBackend } from '@axn-term/session-backend';
import { ptyIdOf, type ShellSession } from '../../types';
import type { AcpHandlers } from './acpClient';

/** Cap the retained terminal output per agent terminal (~1 MB). */
const MAX_TERM_BUFFER = 1_000_000;

/**
 * ACP agent→client `terminal/*` methods over real backend PTYs: each
 * `terminal/create` spawns an invisible `createSubshell` PTY (no UI tab),
 * `output` drains the accumulated text, `wait_for_exit` resolves on the
 * PTY's exit. The terminal id is the PTY id.
 */
export function acpTerminalHandlers(
  session: ShellSession,
  backend: SessionBackend,
): NonNullable<AcpHandlers['terminal']> {
  interface Term {
    buf: string;
    exit?: number | null;
    waiters: ((code: number | null) => void)[];
    un?: () => void;
  }
  const terms = new Map<string, Term>();
  let next = 0;
  const decoder = new TextDecoder();
  backend.onSubshellExit?.((ptyId, code) => {
    const t = terms.get(ptyId);
    if (!t) return;
    t.exit = code;
    for (const w of t.waiters) w(code);
    t.waiters = [];
  });
  const need = (id: string): Term => {
    const t = terms.get(id);
    if (!t) throw new Error(`no such terminal: ${id}`);
    return t;
  };
  return {
    async create({ command, cwd }) {
      const ptyId = `acp-term-${++next}-${crypto.randomUUID().slice(0, 8)}`;
      const t: Term = { buf: '', waiters: [] };
      terms.set(ptyId, t);
      t.un = backend.onOutput(ptyId, (data) => {
        t.buf += decoder.decode(data, { stream: true });
        if (t.buf.length > MAX_TERM_BUFFER) t.buf = t.buf.slice(-MAX_TERM_BUFFER);
      });
      const ok = await backend.createSubshell!(ptyId, {
        parentId: ptyIdOf(session),
        command,
        cwd: cwd ?? session.cwd,
        cols: 80,
        rows: 24,
      });
      if (!ok) {
        t.un?.();
        terms.delete(ptyId);
        throw new Error('terminal spawn failed');
      }
      return ptyId;
    },
    async output(terminalId) {
      const t = need(terminalId);
      return {
        output: t.buf,
        truncated: false,
        ...(t.exit !== undefined ? { exit_status: { exit_code: t.exit } } : {}),
      };
    },
    async kill(terminalId) {
      need(terminalId);
      backend.close(terminalId);
    },
    async release(terminalId) {
      const t = need(terminalId);
      t.un?.();
      terms.delete(terminalId);
      backend.close(terminalId);
    },
    async waitForExit(terminalId) {
      const t = need(terminalId);
      if (t.exit !== undefined) return { exit_code: t.exit };
      const code = await new Promise<number | null>((r) => t.waiters.push(r));
      return { exit_code: code };
    },
  };
}

/**
 * The full `AcpHandlers` for a session: `fs/*` over the backend file port,
 * `terminal/*` over invisible PTYs. Each tier is absent when the backend
 * can't serve it — the client then answers -32601 for those methods.
 */
export function acpHandlers(session: ShellSession, backend: SessionBackend): AcpHandlers {
  return {
    fs:
      backend.readFile && backend.writeFile
        ? {
            readTextFile: async (path) => {
              const r = await backend.readFile!(session.id, path);
              if (!r.ok) throw new Error(r.error ?? 'read failed');
              return r.contents ?? '';
            },
            writeTextFile: async (path, contents) => {
              const r = await backend.writeFile!(session.id, path, contents);
              if (!r.ok) throw new Error(r.error ?? 'write failed');
            },
          }
        : undefined,
    terminal: backend.createSubshell ? acpTerminalHandlers(session, backend) : undefined,
  };
}
