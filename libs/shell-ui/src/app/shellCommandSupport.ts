import type { SessionBackend } from '@axn-term/session-backend';
import { expandPathArg, resolvePath } from './fileService';
import { ptyIdOf, type ShellSession } from '../types';

/** Built-in hidden command tables and helpers behind ShellApp's command dispatch and Tab completion. */

export const AXN_BUILTIN_COMMANDS = [
  'axn-edit',
  'axn-browse',
  'axn-preview',
  'axn-sh',
  'axn-rename',
  'axn-install',
  'axn-session',
  'axn-session-mv',
  'axn-session-window',
  'axn-session-up',
  'axn-session-down',
  'axn-session-summary',
  'axn-workspace-up',
  'axn-workspace-down',
  'axn-focus',
];

/** Hidden commands that take an argument (get a trailing space on complete). */
export const AXN_ARG_COMMANDS = new Set([
  'axn-edit',
  'axn-browse',
  'axn-preview',
  'axn-sh',
  'axn-rename',
  'axn-install',
  'axn-session',
  'axn-session-mv',
  'axn-session-summary',
  'axn-focus',
]);

export const AXN_BUILTIN_RE =
  /^\s*(axn-session(?:-mv|-up|-down|-window)?|axn-workspace-up|axn-workspace-down|axn-focus)(?:\s+(.*?))?\s*$/;

/** Filesystem completion for a path argument token; returns full lines. */
export async function completePathArg(
  deps: {
    listDir: (path: string) => Promise<{ name: string; isDirectory: boolean }[]>;
    homeDir: () => Promise<string>;
  },
  cwd: string | undefined,
  linePrefix: string,
  token: string,
  includeFiles: boolean,
): Promise<string[]> {
  const unquoted = token.replace(/^["']/, '');
  const sep = unquoted.lastIndexOf('/');
  const dirPart = sep === -1 ? '' : unquoted.slice(0, sep + 1);
  const base = sep === -1 ? unquoted : unquoted.slice(sep + 1);

  let absDir: string;
  if (dirPart.startsWith('/')) {
    absDir = dirPart;
  } else if (dirPart === '~' || dirPart.startsWith('~/')) {
    const home = await deps.homeDir().catch(() => '');
    if (!home) return [];
    absDir = home.replace(/\/$/, '') + dirPart.slice(1);
  } else if (dirPart === '') {
    absDir = cwd ?? '/';
  } else {
    absDir = `${(cwd ?? '/').replace(/\/$/, '')}/${dirPart}`;
  }

  try {
    const list = await deps.listDir(absDir);
    return list
      .filter(
        (e) => e.name.startsWith(base) && e.name !== base && (includeFiles || e.isDirectory),
      )
      .sort(
        (a, b) =>
          Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
      )
      .slice(0, 50)
      .map((e) => `${linePrefix}${dirPart}${e.name}${e.isDirectory ? '/' : ''}`);
  } catch {
    return [];
  }
}

export async function resolveSessionPath(
  backend: SessionBackend,
  homeDir: () => Promise<string>,
  session: ShellSession,
  path: string,
  ptyId?: string,
): Promise<string> {
  // Typed arguments get the same unquote + `~` handling as completion.
  const home = path.trim().replace(/^["']/, '').startsWith('~')
    ? await homeDir().catch(() => undefined)
    : undefined;
  const liveCwd =
    (await backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ?? session.cwd;
  return resolvePath(liveCwd, expandPathArg(path, home));
}

export function browserTabPatch(session: ShellSession, path: string): Partial<ShellSession> {
  const editors = session.editors ?? [];
  const existing = editors.find((e) => e.path === path && e.kind === 'browser');
  const id = existing?.id ?? `br-${crypto.randomUUID()}`;
  return {
    editors: existing ? editors : [...editors, { id, path, kind: 'browser' }],
    activeTab: id,
  };
}
