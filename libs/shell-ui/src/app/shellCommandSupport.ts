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
  'axn-workspaces',
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
  /^\s*(axn-session(?:-mv|-up|-down|-window)?|axn-workspaces|axn-workspace-up|axn-workspace-down|axn-focus)(?:\s+(.*?))?\s*$/;

/** Shell-ish tokenizer for command args — honours single/double quotes. */
export function shellTokens(arg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(arg))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `axn-session`/`axn-session create` options — `-w`/`--workspace`, `-n`/`--name`, `--background`, `--create-ws`, `--summary`. */
export const AXN_SESSION_FLAGS = [
  '-w',
  '--workspace',
  '-n',
  '--name',
  '--background',
  '--create-ws',
  '--summary',
] as const;

/** `axn-session set` options — every flag carries a value. */
export const AXN_SESSION_SET_FLAGS = [
  '--summary',
  '--name',
  '--title',
  '-n',
] as const;

/**
 * Parse `axn-session [create] [-w|--workspace <name>] [-n|--name <name>]
 * [--background] [--summary <text>] [path]` arguments. Remaining positional
 * tokens join back into the path, so an unquoted `axn-session my dir` still
 * addresses `my dir`.
 */
export function parseSessionArgs(arg: string): {
  workspace?: string;
  name?: string;
  background?: boolean;
  createWs?: boolean;
  summary?: string;
  path?: string;
  error?: string;
} {
  const opts: {
    workspace?: string;
    name?: string;
    background?: boolean;
    createWs?: boolean;
    summary?: string;
    path?: string;
  } = {};
  const positional: string[] = [];
  const tokens = shellTokens(arg);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-w' || t === '--workspace' || t === '-n' || t === '--name' || t === '--summary') {
      const value = tokens[++i];
      if (value === undefined) return { error: `${t} needs a value` };
      if (t === '-w' || t === '--workspace') opts.workspace = value;
      else if (t === '--summary') opts.summary = value;
      else opts.name = value;
    } else if (t === '--background') {
      opts.background = true;
    } else if (t === '--create-ws') {
      opts.createWs = true;
    } else {
      positional.push(t);
    }
  }
  if (positional.length) opts.path = positional.join(' ');
  return opts;
}

/**
 * Parse `axn-session set --summary <text> [--name|--title <name>]` — every
 * flag takes a value (an empty quoted value clears the field, matching the
 * bare `axn-session-summary`/`axn-rename` convention). At least one flag is
 * required; positionals are an error.
 */
export function parseSessionSetArgs(arg: string): {
  name?: string;
  summary?: string;
  error?: string;
} {
  const opts: { name?: string; summary?: string } = {};
  const tokens = shellTokens(arg);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--summary' || t === '--name' || t === '--title' || t === '-n') {
      const value = tokens[++i];
      if (value === undefined) return { error: `${t} needs a value` };
      if (t === '--summary') opts.summary = value;
      else opts.name = value;
    } else {
      return { error: `unexpected argument: ${t}` };
    }
  }
  if (opts.name === undefined && opts.summary === undefined) {
    return { error: 'usage: axn-session set [--summary <text>] [--name|--title <name>]' };
  }
  return opts;
}

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
