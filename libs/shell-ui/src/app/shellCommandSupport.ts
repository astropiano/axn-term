import type { SessionBackend } from '@axn-term/session-backend';
import { expandPathArg, resolvePath } from './fileService';
import { ptyIdOf, type ShellSession } from '../types';

/** Helpers behind ShellApp's command dispatch and Tab completion. The
 * session-level built-ins themselves live in `builtinCommands.ts` — this
 * file holds the shared parsing/resolution/completion pieces. */

/**
 * View-local hidden commands — handled inside `hiddenCommands.ts` with the
 * view's own callbacks, never reaching the session dispatch (the control
 * socket can't open editor tabs). Listed for command-word completion.
 */
export const AXN_VIEW_COMMANDS = ['axn-edit', 'axn-browse', 'axn-preview', 'axn-ide'] as const;

/** Matches terminalRenderer's SHELL_FOREGROUND_RE — kept local so this
 * module stays free of the xterm import chain (its tests run in node). */
export const SHELL_FOREGROUND_RE = /^(ba|z|da|fi)?sh$|^fish$|^nu$|^(pwsh|powershell|cmd)(\.exe)?$/;

/** `axn-broadcast` targeting flags — `-t`/`--to` scope the send to one session. */
export const AXN_BROADCAST_FLAGS = ['-t', '--to'] as const;

/**
 * Session resolution shared by the axn-* commands that address a session:
 * id or exact name, else a case-insensitive name-prefix match.
 */
export function findSessionByName<T extends { id: string; name: string }>(
  sessions: readonly T[],
  needle: string,
): T | undefined {
  return (
    sessions.find((s) => s.id === needle || s.name === needle) ??
    sessions.find((s) => s.name.toLowerCase().startsWith(needle.toLowerCase()))
  );
}

/**
 * A leading `-t`/`--to <session>` on an axn-* command line: the (possibly
 * quoted) target token and the verbatim rest of the line. `undefined` when
 * the line does not start with the flag; `{ target: undefined }` when the
 * flag is present without a value.
 */
export function parseTargetFlag(arg: string): { target?: string; rest: string } | undefined {
  const m = /^\s*(-t|--to)(?:\s+("[^"]*"|'[^']*'|\S+))?(?:\s+|$)/.exec(arg);
  if (!m) return undefined;
  return { target: m[2]?.replace(/^["']|["']$/g, ''), rest: arg.slice(m[0].length) };
}

/**
 * Session-name completion for the session-addressing commands (axn-tell,
 * axn-broadcast --to, axn-broadcast-add/-rm, axn-session select) — full
 * replacement lines, quoting names that contain spaces.
 */
export function completeSessionName(
  sessions: readonly { name: string }[],
  rest: string,
  lineHead: string,
): string[] {
  const prefix = rest.replace(/^["']/, '');
  return sessions
    .map((s) => s.name)
    .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix)
    .map((n) => `${lineHead}${n.includes(' ') ? `"${n}"` : n}`);
}

/** Same shape as completeSessionName for workspace names (axn-session-mv). */
export function completeWorkspaceName(
  workspaces: readonly { name: string }[],
  rest: string,
  lineHead: string,
): string[] {
  const prefix = rest.replace(/^["']/, '');
  return workspaces
    .map((w) => w.name)
    .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix)
    .map((n) => `${lineHead}${n.includes(' ') ? `"${n}"` : n}`);
}

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
  '--command',
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
// `--command-b64`: shellTokens has no escapes, so a command line mixing quote
// types (what launchers build) travels encoded.
function decodeBase64Utf8(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function parseSessionArgs(arg: string): {
  workspace?: string;
  name?: string;
  background?: boolean;
  createWs?: boolean;
  summary?: string;
  path?: string;
  /** Typed into the new session once its shell has started. */
  command?: string;
  error?: string;
} {
  const opts: {
    workspace?: string;
    name?: string;
    background?: boolean;
    createWs?: boolean;
    summary?: string;
    path?: string;
    command?: string;
  } = {};
  const positional: string[] = [];
  const tokens = shellTokens(arg);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--command' || t === '--command-b64') {
      const value = tokens[++i];
      if (value === undefined) return { error: `${t} needs a value` };
      const command = t === '--command' ? value : decodeBase64Utf8(value);
      if (command === undefined) return { error: '--command-b64 is not base64' };
      opts.command = command;
    } else if (t === '-w' || t === '--workspace' || t === '-n' || t === '--name' || t === '--summary') {
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

/** Same dedupe-by-path pattern as browserTabPatch for the IDE composite tab. */
export function ideTabPatch(session: ShellSession, path: string): Partial<ShellSession> {
  const editors = session.editors ?? [];
  const existing = editors.find((e) => e.path === path && e.kind === 'ide');
  const id = existing?.id ?? `ide-${crypto.randomUUID()}`;
  return {
    editors: existing ? editors : [...editors, { id, path, kind: 'ide' }],
    activeTab: id,
  };
}
