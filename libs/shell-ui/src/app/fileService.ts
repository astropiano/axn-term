import type { SessionBackend } from '@axn-term/session-backend';

export interface FileService {
  readFile(path: string, cwd?: string): Promise<string>;
  writeFile(path: string, cwd: string | undefined, contents: string): Promise<void>;
}

function normalizePath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return '/' + out.join('/');
}

/**
 * Shell-style cleanup of a typed path argument (`axn-edit "my notes.md"`,
 * `axn-browse ~/src`): strips one pair of matching outer quotes and expands
 * a leading `~` / `~/` to `home`. A `~` path is left as-is without a home.
 */
export function expandPathArg(arg: string, home?: string): string {
  let path = arg.trim();
  const quoted = /^(["'])(.*)\1$/.exec(path);
  if (quoted) path = quoted[2];
  if (home && (path === '~' || path.startsWith('~/'))) {
    path = home.replace(/\/+$/, '') + path.slice(1);
  }
  return path;
}

export function resolvePath(cwd: string | undefined, path: string): string {
  if (path.startsWith('/')) return normalizePath(path);
  const base = cwd && cwd.length > 0 ? cwd : '/';
  return normalizePath(`${base.replace(/\/+$/, '')}/${path}`);
}

/**
 * FileService over a SessionBackend's fs ops. Session-scoped: remote
 * backends route reads through that session's connection; host-local
 * backends ignore the session id and hit the local fs.
 */
export function backendFileService(backend: SessionBackend, sessionId: string): FileService {
  return {
    async readFile(path, cwd) {
      if (!backend.readFile) throw new Error('file reads are not supported in this environment');
      const resolved = resolvePath(cwd, path);
      const res = await backend.readFile(sessionId, resolved);
      if (!res.ok) throw new Error(res.error ?? `cannot read ${resolved}`);
      return res.contents ?? '';
    },
    async writeFile(path, cwd, contents) {
      if (!backend.writeFile) throw new Error('file writes are not supported in this environment');
      const resolved = resolvePath(cwd, path);
      const res = await backend.writeFile(sessionId, resolved, contents);
      if (!res.ok) throw new Error(res.error ?? `cannot write ${resolved}`);
    },
  };
}
