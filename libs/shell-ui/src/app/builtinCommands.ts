import type { MutableRefObject } from 'react';
import type { SessionBackend } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import { activeTabAcceptsInput, ptyIdOf, type ShellSession, type Workspace } from '../types';
import { parseSessionSummary, SESSION_SUMMARY_MAX, type SessionCommandResult } from './hiddenCommands';
import { broadcastSet } from './broadcastSet';
import {
  AXN_BROADCAST_FLAGS,
  AXN_SESSION_FLAGS,
  AXN_SESSION_SET_FLAGS,
  completePathArg,
  completeSessionName,
  completeWorkspaceName,
  findSessionByName,
  parseSessionArgs,
  parseSessionSetArgs,
  parseTargetFlag,
  SHELL_FOREGROUND_RE,
  shellTokens,
} from './shellCommandSupport';

/**
 * The session-level built-in `axn-*` commands, one entry each. The dispatch
 * (`useSessionCommands`) matches a line's first word to `name`; `run`
 * returns the usual outcome — a string replaces the typed line (`echo "…"`
 * feeds back to the user), `false` swallows it, `undefined` passes it to
 * the shell. The same table drives word + arg Tab-completion, so a new
 * command is exactly one entry — no regex, name list or completion branch
 * elsewhere. View-local commands (axn-edit/browse/preview/ide) are NOT here:
 * they need the view's own callbacks and live in hiddenCommands.ts.
 */

/** What a built-in command may touch — the command-facing slice of SessionCommandDeps. */
export interface BuiltinDeps {
  backend: SessionBackend;
  platform: ShellPlatform;
  sessionsRef: MutableRefObject<ShellSession[]>;
  workspacesRef: MutableRefObject<Workspace[]>;
  openSession: (workspaceId: string, cwd?: string, name?: string, background?: boolean) => string | undefined;
  openSubShell: (sessionId: string, command?: string, cwd?: string) => string | undefined;
  addWorkspace: (name: string) => string;
  moveSessionToWorkspace: (sessionId: string, workspaceId: string, beforeSessionId?: string | null) => void;
  moveWorkspace: (workspaceId: string, delta: -1 | 1) => void;
  activateSessionTab: (sessionId: string, tabId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  pathDeps: Parameters<typeof completePathArg>[0];
  /** `axn-session-window`; absent where windows can't be opened. */
  tearOffSession?: (sessionId: string) => Promise<string | null>;
  /** `axn-broadcast-deck`; absent without a deck. */
  openBroadcastDeck?: (sessionId: string) => void;
  /** `axn-session select`; absent without selection control. */
  selectSession?: (sessionId: string) => void;
}

export interface BuiltinCtx {
  deps: BuiltinDeps;
  /** The session the command was issued in — the `*` in lists, the sender for axn-tell. */
  session: ShellSession;
  /** The PTY the line came from — a sub-shell's cwd can differ from the session's. */
  originPty: string;
}

export interface BuiltinCommand {
  /** The command word, e.g. 'axn-tell'. */
  name: string;
  /** Takes a non-empty argument (completion appends a trailing space). */
  takesArg?: boolean;
  run: (
    ctx: BuiltinCtx,
    arg: string | undefined,
    line: string,
  ) => SessionCommandResult | Promise<SessionCommandResult>;
  /**
   * Arg completion: `rest` is the raw text after the command word, `lineHead`
   * the line up to and including `<word> `. Returns full replacement lines.
   */
  completeArg?: (ctx: BuiltinCtx, rest: string, lineHead: string) => string[] | Promise<string[]>;
}

/** Outer quotes, as the pre-registry dispatch stripped them from `arg`. */
const unquote = (s: string) => s.replace(/^["']+|["']+$/g, '');

async function completePath(
  ctx: BuiltinCtx,
  rest: string,
  lineHead: string,
  includeFiles: boolean,
): Promise<string[]> {
  // Complete against the originating PTY's live cwd (a sub-shell's cwd can
  // differ from the session's stored cwd).
  const liveCwd =
    (await ctx.deps.backend.getCwd?.(ctx.originPty).catch(() => null)) ?? ctx.session.cwd;
  return completePathArg(ctx.deps.pathDeps, liveCwd, lineHead, rest, includeFiles);
}

/** Fan out a line to sessions — the write path both broadcast modes and axn-tell share. */
function sendLine(deps: BuiltinDeps, targets: ShellSession[], text: string): SessionCommandResult {
  const blocked = targets.filter((t) => !activeTabAcceptsInput(t));
  if (blocked.length) {
    return `echo ${JSON.stringify(`axn-broadcast: blocked — ${blocked.map((t) => t.name).join(', ')} on a view that takes no input`)}`;
  }
  for (const t of targets) {
    void deps.backend.write(ptyIdOf(t), `${text}\r`);
  }
  return undefined;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    // `axn-rename` (no arg) clears the override → process-reported name.
    name: 'axn-rename',
    takesArg: true,
    run: ({ deps, session }, arg) => {
      deps.renameSession(session.id, arg ? unquote(arg) : '');
      return false;
    },
  },
  {
    // `axn-session-summary` (no arg) clears the summary — same convention
    // as `axn-rename`.
    name: 'axn-session-summary',
    takesArg: true,
    run: ({ deps, session }, _arg, line) => {
      const summary = parseSessionSummary(line);
      if (summary === undefined) return undefined;
      deps.updateSession(session.id, { summary });
      return false;
    },
  },
  {
    name: 'axn-sh',
    takesArg: true,
    run: async ({ deps, session, originPty }, argRaw): Promise<SessionCommandResult> => {
      const arg = argRaw ? unquote(argRaw) : '';
      if (arg) {
        // A single argument that resolves to a directory opens an
        // interactive sub-shell there (`axn-sh .`, `axn-sh src`); anything
        // else is a `sh -c` one-shot command.
        const liveCwd =
          (await deps.backend.getCwd?.(originPty).catch(() => null)) ?? session.cwd;
        const stat =
          (await deps.backend.statPath?.(originPty, liveCwd ?? '/', arg).catch(() => null)) ??
          null;
        if (stat?.isDir) {
          deps.openSubShell(session.id, undefined, stat.path);
          return false;
        }
      }
      deps.openSubShell(session.id, arg || undefined);
      return false;
    },
    completeArg: (ctx, rest, lineHead) => completePath(ctx, rest, lineHead, false),
  },
  {
    name: 'axn-install',
    takesArg: true,
    run: async ({ deps }, arg) => {
      // Swap for `axn-term install …` and let it run visibly in the shell.
      // Resolve the running binary so the command also works in dev builds
      // where `axn-term` is not on PATH.
      const exe = (await deps.platform.exePath?.().catch(() => undefined)) ?? 'axn-term';
      return `${JSON.stringify(exe)} install${arg ? ` ${arg}` : ''}`;
    },
  },
  {
    name: 'axn-session',
    takesArg: true,
    run: async ({ deps, session, originPty }, argRaw) => {
      const rest = (argRaw ?? '').trim();
      // `create`/`set`/`select`/`list` subcommands; a bare `axn-session …`
      // line is an implicit `create` (the pre-subcommand spelling stays
      // valid).
      const sub = /^(create|set|select|list)(?:\s|$)/.exec(rest)?.[1];
      if (sub === 'list') {
        // One line per session in panel order; `*` on the session the
        // command ran in — the session-addressing counterpart of
        // `axn-workspaces`, so agents can discover peers for axn-tell.
        const lines = deps.sessionsRef.current.map((s) => {
          const ws =
            deps.workspacesRef.current.find((w) => w.id === s.workspaceId)?.name ??
            s.workspaceId;
          return `${s.id === session.id ? '*' : ' '} ${s.name} (${ws})`;
        });
        return `echo ${JSON.stringify(lines.join('\n'))}`;
      }
      if (sub === 'select') {
        // `axn-session select <name|id>` — 'go to session': focus the
        // target and make it the only selection (same as the tile
        // button and a plain panel click).
        const needle = unquote(rest.slice(6).trim());
        const target = needle ? findSessionByName(deps.sessionsRef.current, needle) : undefined;
        if (!target) {
          return `echo ${JSON.stringify(`axn-session: no such session: ${needle || '(missing)'}`)}`;
        }
        if (deps.selectSession) {
          deps.selectSession(target.id);
          return `echo ${JSON.stringify(`axn-session: selected '${target.name}'`)}`;
        }
        return 'echo "axn-session: session selection is not available here"';
      }
      if (sub === 'set') {
        const opts = parseSessionSetArgs(rest.slice(3));
        if (opts.error) return `echo ${JSON.stringify(`axn-session: ${opts.error}`)}`;
        const parts: string[] = [];
        if (opts.name !== undefined) {
          deps.renameSession(session.id, opts.name);
          parts.push(opts.name ? `renamed to '${opts.name}'` : 'name cleared');
        }
        if (opts.summary !== undefined) {
          const summary = opts.summary.slice(0, SESSION_SUMMARY_MAX);
          deps.updateSession(session.id, { summary });
          parts.push(summary ? 'summary updated' : 'summary cleared');
        }
        return `echo ${JSON.stringify(`axn-session: ${parts.join(', ')}`)}`;
      }
      const opts = parseSessionArgs(sub === 'create' ? rest.slice(6) : rest);
      if (opts.error) return `echo ${JSON.stringify(`axn-session: ${opts.error}`)}`;
      // `-w`/`--workspace` targets another workspace by name — it must
      // exist unless `--create-ws` opts into creating it.
      let workspaceId = session.workspaceId;
      if (opts.workspace) {
        const hit = deps.workspacesRef.current.find(
          (w) => w.name.toLowerCase() === opts.workspace!.toLowerCase(),
        );
        if (hit) workspaceId = hit.id;
        else if (opts.createWs) workspaceId = deps.addWorkspace(opts.workspace);
        else
          return `echo ${JSON.stringify(
            `axn-session: no such workspace: ${opts.workspace} (use --create-ws to create it)`,
          )}`;
      }
      const wsName =
        deps.workspacesRef.current.find((w) => w.id === workspaceId)?.name ?? workspaceId;
      const liveCwd =
        (await deps.backend.getCwd?.(originPty).catch(() => null)) ?? session.cwd;
      const opened = (where?: string) =>
        `echo ${JSON.stringify(
          `axn-session: opened '${opts.name ?? 'session'}' in workspace '${wsName}'${
            where ? ` at ${where}` : ''
          }`,
        )}`;
      if (!opts.path || opts.path === '.') {
        const id = deps.openSession(
          workspaceId,
          liveCwd ?? undefined,
          opts.name,
          opts.background,
        );
        if (id && opts.summary) {
          deps.updateSession(id, { summary: opts.summary.slice(0, SESSION_SUMMARY_MAX) });
        }
        return opened(liveCwd ?? undefined);
      }
      const stat =
        (await deps.backend
          .statPath?.(originPty, liveCwd ?? '/', opts.path)
          .catch(() => null)) ?? null;
      if (stat?.isDir) {
        const id = deps.openSession(workspaceId, stat.path, opts.name, opts.background);
        if (id && opts.summary) {
          deps.updateSession(id, { summary: opts.summary.slice(0, SESSION_SUMMARY_MAX) });
        }
        return opened(stat.path);
      }
      return `echo ${JSON.stringify(
        `axn-session: not a directory: ${opts.path} (a bare word is a path — use -w for a workspace, -n for a name)`,
      )}`;
    },
    completeArg: async (ctx, rest, lineHead) => {
      // Flag-aware completion: a workspace name after -w/--workspace,
      // flag names while typing a dash, otherwise a filesystem path.
      // `rawCur` is the token being completed, `head` everything before.
      const rawCur = /\s$/.test(rest) ? '' : (/\S+$/.exec(rest)?.[0] ?? '');
      const head = rest.slice(0, rest.length - rawCur.length);
      const argHead = `${lineHead}${head}`;
      const prevTok = shellTokens(head).pop();
      const firstTok = shellTokens(head)[0];

      // `axn-session set` completes only its own flags — no paths.
      if (firstTok === 'set') {
        if (
          AXN_SESSION_SET_FLAGS.includes(prevTok as (typeof AXN_SESSION_SET_FLAGS)[number])
        ) {
          return [];
        }
        if (rawCur === '' || rawCur.startsWith('-')) {
          return AXN_SESSION_SET_FLAGS.filter((f) => f !== rawCur).map(
            (f) => `${argHead}${f} `,
          );
        }
        return [];
      }
      // `axn-session select` completes session names; `list` takes nothing.
      if (firstTok === 'select') {
        return completeSessionName(ctx.deps.sessionsRef.current, rawCur, argHead);
      }
      if (firstTok === 'list') return [];
      // Completing the first token: subcommand candidates next to the flag
      // names and paths of the legacy implicit-create form.
      const subCandidates =
        firstTok !== 'create'
          ? ['create', 'set', 'select', 'list']
              .filter((s) => s.startsWith(rawCur) && s !== rawCur)
              .map((s) => `${argHead}${s} `)
          : [];
      if (prevTok === '-w' || prevTok === '--workspace') {
        return completeWorkspaceName(ctx.deps.workspacesRef.current, rawCur, argHead);
      }
      if (prevTok === '-n' || prevTok === '--name' || prevTok === '--summary') return [];
      if (rawCur.startsWith('-')) {
        return [
          ...subCandidates,
          ...AXN_SESSION_FLAGS.filter((f) => f.startsWith(rawCur) && f !== rawCur).map(
            (f) => `${argHead}${f} `,
          ),
        ];
      }
      return [
        ...subCandidates,
        ...(await completePath(ctx, rawCur, argHead, false)),
      ];
    },
  },
  {
    name: 'axn-session-mv',
    takesArg: true,
    run: ({ deps, session }, argRaw) => {
      const arg = argRaw ? unquote(argRaw) : '';
      if (!arg) return 'echo "usage: axn-session-mv <workspace>"';
      const existing = deps.workspacesRef.current.find(
        (w) => w.name.toLowerCase() === arg.toLowerCase(),
      );
      deps.moveSessionToWorkspace(session.id, existing?.id ?? deps.addWorkspace(arg));
      return `echo ${JSON.stringify(`axn-session-mv: moved session to workspace '${arg}'`)}`;
    },
    completeArg: ({ deps }, rest, lineHead) =>
      completeWorkspaceName(deps.workspacesRef.current, rest, lineHead),
  },
  {
    name: 'axn-session-window',
    run: ({ deps, session }) => {
      const tearOff = deps.tearOffSession;
      if (!tearOff) return 'echo "axn-session-window: new windows are not available here"';
      if (deps.sessionsRef.current.length <= 1) {
        return 'echo "axn-session-window: this is the only session in its window"';
      }
      void tearOff(session.id);
      return false;
    },
  },
  {
    name: 'axn-session-up',
    run: ({ deps, session }) => {
      const wsSessions = deps.sessionsRef.current.filter(
        (s) => s.workspaceId === session.workspaceId,
      );
      const idx = wsSessions.findIndex((s) => s.id === session.id);
      const prev = wsSessions[idx - 1];
      if (idx > 0 && prev) {
        deps.moveSessionToWorkspace(session.id, session.workspaceId, prev.id);
      }
      return false;
    },
  },
  {
    name: 'axn-session-down',
    run: ({ deps, session }) => {
      const wsSessions = deps.sessionsRef.current.filter(
        (s) => s.workspaceId === session.workspaceId,
      );
      const idx = wsSessions.findIndex((s) => s.id === session.id);
      const next = wsSessions[idx + 1];
      if (!next) return false;
      const afterNext = wsSessions[idx + 2];
      deps.moveSessionToWorkspace(session.id, session.workspaceId, afterNext?.id ?? null);
      return false;
    },
  },
  {
    name: 'axn-workspaces',
    run: ({ deps, session }) => {
      // One line per workspace; the one this session belongs to is
      // marked `*` — pairs with `axn-session -w <name>`.
      const lines = deps.workspacesRef.current.map(
        (w) => `${w.id === session.workspaceId ? '*' : ' '} ${w.name}`,
      );
      return `echo ${JSON.stringify(lines.join('\n'))}`;
    },
  },
  {
    name: 'axn-workspace-up',
    run: ({ deps, session }) => {
      deps.moveWorkspace(session.workspaceId, -1);
      return false;
    },
  },
  {
    name: 'axn-workspace-down',
    run: ({ deps, session }) => {
      deps.moveWorkspace(session.workspaceId, 1);
      return false;
    },
  },
  {
    name: 'axn-focus',
    takesArg: true,
    run: ({ deps, session }, argRaw) => {
      // Bring a session view to the front: `shell` (default) the main
      // terminal, else a sub-view tab by 1-based index, kind, id (prefix)
      // or label/path-basename text.
      const target = argRaw ? unquote(argRaw).trim() : '';
      if (!target || target === 'shell') {
        deps.activateSessionTab(session.id, 'shell');
        return false;
      }
      const editors = session.editors ?? [];
      const lower = target.toLowerCase();
      const hit =
        (/^\d+$/.test(target) ? editors[parseInt(target, 10) - 1] : undefined) ??
        editors.find((e) => e.id === target || e.id.startsWith(target)) ??
        editors.find((e) => (e.kind ?? 'editor') === lower) ??
        editors.find((e) =>
          (e.label ?? e.path.split('/').pop() ?? '').toLowerCase().includes(lower),
        );
      if (!hit) {
        return `echo ${JSON.stringify(`axn-focus: no such tab: ${target}`)}`;
      }
      deps.activateSessionTab(session.id, hit.id);
      return false;
    },
  },
  {
    /**
     * `axn-tell <session> <message>` — agent↔agent messaging over the PTY
     * input path. The delivered line names the sending session
     * (`[axn-tell from "<name>"] …`) so the receiving agent knows who sent
     * it and can reply with `axn-tell <name>`. When the target's foreground
     * is a shell (or no program at all — the web backend reports null while
     * the shell is foreground) the envelope is sent as a `#` comment: it
     * lands in scrollback/history without executing instead of surfacing
     * as `command not found`. Any other foreground gets the raw envelope —
     * typed text is the only universal way to reach a running agent TUI.
     */
    name: 'axn-tell',
    takesArg: true,
    run: async ({ deps, session }, arg) => {
      const m = /^\s*("[^"]*"|'[^']*'|\S+)\s*/.exec(arg ?? '');
      const needle = m?.[1]?.replace(/^["']|["']$/g, '');
      const message = (arg ?? '')
        .slice(m?.[0].length ?? 0)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!needle || !message) {
        return 'echo "usage: axn-tell <session> <message>"';
      }
      const target = findSessionByName(deps.sessionsRef.current, needle);
      if (!target) {
        return `echo ${JSON.stringify(`axn-tell: no such session: ${needle}`)}`;
      }
      if (!activeTabAcceptsInput(target)) {
        return `echo ${JSON.stringify(`axn-tell: '${target.name}' is on a view that takes no input`)}`;
      }
      const envelope = `[axn-tell from "${session.name.replace(/"/g, "'")}"] ${message}`;
      const comm =
        (await deps.backend
          .getForegroundProcess?.(ptyIdOf(target))
          .catch(() => null)) ?? null;
      const line = !comm || SHELL_FOREGROUND_RE.test(comm) ? `# ${envelope}` : envelope;
      void deps.backend.write(ptyIdOf(target), `${line}\r`);
      return `echo ${JSON.stringify(`axn-tell: sent to '${target.name}'`)}`;
    },
    completeArg: ({ deps }, rest, lineHead) =>
      /\s$/.test(rest) || shellTokens(rest).length !== 1
        ? []
        : completeSessionName(deps.sessionsRef.current, rest, lineHead),
  },
  {
    // Fan out a finished input line — to every broadcast-marked session,
    // or to a single one with `-t`/`--to <session>` (same name/id/prefix
    // resolution as axn-broadcast-add). The line goes verbatim: this is a
    // transport, not a message — use axn-tell for attribution.
    name: 'axn-broadcast',
    takesArg: true,
    run: ({ deps }, arg) => {
      const flagged = parseTargetFlag(arg ?? '');
      if (flagged && !flagged.target) {
        return 'echo "axn-broadcast: --to needs a session (name or id)"';
      }
      let targets: ShellSession[];
      let text: string;
      if (flagged) {
        const target = findSessionByName(deps.sessionsRef.current, flagged.target!);
        if (!target) {
          return `echo ${JSON.stringify(`axn-broadcast: no such session: ${flagged.target}`)}`;
        }
        targets = [target];
        text = flagged.rest.trim();
      } else {
        text = (arg ?? '').trim();
        targets = broadcastSet
          .list()
          .map((id) => deps.sessionsRef.current.find((s) => s.id === id))
          .filter((s): s is ShellSession => !!s);
        if (text && !targets.length) {
          return 'echo "axn-broadcast: broadcast set is empty (axn-broadcast-add marks sessions)"';
        }
      }
      if (!text) {
        return 'echo "usage: axn-broadcast [--to <session>] <line> — send the line to every broadcast-marked session"';
      }
      const result = sendLine(deps, targets, text);
      if (result !== undefined) return result;
      return `echo ${JSON.stringify(
        flagged
          ? `axn-broadcast: sent to '${targets[0].name}'`
          : `axn-broadcast: sent to ${targets.length} session${targets.length === 1 ? '' : 's'}`,
      )}`;
    },
    completeArg: ({ deps }, rest, lineHead) => {
      const rawCur = /\s$/.test(rest) ? '' : (/\S+$/.exec(rest)?.[0] ?? '');
      const head = rest.slice(0, rest.length - rawCur.length);
      const toks = shellTokens(head);
      if (toks.length === 0) {
        // First token: the -t/--to flags while typing a dash.
        return rawCur.startsWith('-')
          ? AXN_BROADCAST_FLAGS.filter((f) => f.startsWith(rawCur) && f !== rawCur).map(
              (f) => `${lineHead}${f} `,
            )
          : [];
      }
      if (toks.length === 1 && AXN_BROADCAST_FLAGS.includes(toks[0] as '-t' | '--to')) {
        return completeSessionName(deps.sessionsRef.current, rawCur, `${lineHead}${head}`);
      }
      return [];
    },
  },
  {
    name: 'axn-broadcast-add',
    takesArg: true,
    run: ({ deps, session }, argRaw) => {
      const needle = argRaw ? unquote(argRaw).trim() : '';
      const target = needle
        ? findSessionByName(deps.sessionsRef.current, needle)
        : session;
      if (!target) {
        return `echo ${JSON.stringify(`axn-broadcast-add: no such session: ${argRaw}`)}`;
      }
      broadcastSet.mark(target.id);
      return `echo ${JSON.stringify(`axn-broadcast-add: marked '${target.name}'`)}`;
    },
    completeArg: ({ deps }, rest, lineHead) =>
      completeSessionName(deps.sessionsRef.current, rest, lineHead),
  },
  {
    name: 'axn-broadcast-rm',
    takesArg: true,
    run: ({ deps, session }, argRaw) => {
      const needle = argRaw ? unquote(argRaw).trim() : '';
      const target = needle
        ? findSessionByName(deps.sessionsRef.current, needle)
        : session;
      if (!target) {
        return `echo ${JSON.stringify(`axn-broadcast-rm: no such session: ${argRaw}`)}`;
      }
      broadcastSet.unmark(target.id);
      return `echo ${JSON.stringify(`axn-broadcast-rm: unmarked '${target.name}'`)}`;
    },
    completeArg: ({ deps }, rest, lineHead) =>
      completeSessionName(deps.sessionsRef.current, rest, lineHead),
  },
  {
    name: 'axn-broadcast-deck',
    run: ({ deps, session }) => {
      if (!deps.openBroadcastDeck) return false;
      deps.openBroadcastDeck(session.id);
      return false;
    },
  },
  {
    name: 'axn-broadcast-clear',
    run: () => {
      const n = broadcastSet.size();
      broadcastSet.clear();
      return `echo ${JSON.stringify(`axn-broadcast-clear: ${n} session${n === 1 ? '' : 's'} unmarked`)}`;
    },
  },
  {
    name: 'axn-broadcasts',
    run: ({ deps, session }) => {
      const names = broadcastSet
        .list()
        .map((id) => deps.sessionsRef.current.find((s) => s.id === id))
        .filter((s): s is ShellSession => !!s)
        .map((s) => `${s.id === session.id ? '*' : ' '}${s.name}`);
      return `echo ${JSON.stringify(
        names.length ? names.join('\n') : 'axn-broadcasts: broadcast set is empty',
      )}`;
    },
  },
];

/** Command words, for Tab-completion candidates — includes view-local
 * commands via `AXN_VIEW_COMMANDS` in the caller. */
export const BUILTIN_COMMAND_NAMES = BUILTIN_COMMANDS.map((c) => c.name);

/** Built-ins taking an argument — get a trailing space on complete. */
export const BUILTIN_ARG_COMMANDS = new Set(
  BUILTIN_COMMANDS.filter((c) => c.takesArg).map((c) => c.name),
);
