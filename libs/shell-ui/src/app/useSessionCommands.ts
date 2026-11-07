import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ControlCommandHandler, SessionBackend } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import { ptyIdOf, type ShellSession, type Workspace } from '../types';
import { axnLog } from './log';
import { parseSessionSummary, runCommandChain, SESSION_SUMMARY_MAX } from './hiddenCommands';
import { controlReply, sessionForPty } from './controlCommands';
import {
  AXN_ARG_COMMANDS,
  AXN_BUILTIN_COMMANDS,
  AXN_BUILTIN_RE,
  AXN_SESSION_FLAGS,
  AXN_SESSION_SET_FLAGS,
  completePathArg,
  parseSessionArgs,
  parseSessionSetArgs,
  shellTokens,
} from './shellCommandSupport';
import { pluginCommands, type PluginApi, type SessionViewContext, type SessionViewPlugin } from './session-plugins';
import { registerSessionCommandDispatch } from './session-plugins/plugin';

/** What the command dispatch needs from ShellApp — read live through a ref. */
export interface SessionCommandDeps {
  backend: SessionBackend;
  platform: ShellPlatform;
  sessionsRef: MutableRefObject<ShellSession[]>;
  workspacesRef: MutableRefObject<Workspace[]>;
  enabledPluginsRef: MutableRefObject<SessionViewPlugin[]>;
  buildPluginApi: (session: ShellSession, plugin: SessionViewPlugin) => SessionViewContext & PluginApi;
  /** Returns the new session's id (undefined when no valid workspace). */
  openSession: (workspaceId: string, cwd?: string, name?: string, background?: boolean) => string | undefined;
  openSubShell: (sessionId: string, command?: string, cwd?: string) => string | undefined;
  addWorkspace: (name: string) => string;
  moveSessionToWorkspace: (sessionId: string, workspaceId: string, beforeSessionId?: string | null) => void;
  moveWorkspace: (workspaceId: string, delta: -1 | 1) => void;
  activateSessionTab: (sessionId: string, tabId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  updateSession: (sessionId: string, patch: Partial<ShellSession>) => void;
  pathDeps: Parameters<typeof completePathArg>[0];
  /**
   * Move a session into a new window of its own (`axn-session-window`);
   * resolves an error message or null. Absent where windows can't be opened.
   */
  tearOffSession?: (sessionId: string) => Promise<string | null>;
}

/**
 * The session command dispatch: built-in `axn-*` commands, plugin-owned
 * commands and `onCommand` hooks for a submitted line, Tab completion, and
 * the out-of-band entry points that reuse them — `PluginApi.runCommand`,
 * remote-control lines and `axn-term session …` (control socket).
 */
export function useSessionCommands(input: SessionCommandDeps) {
  const deps = useRef(input);
  deps.current = input;
  const { platform, backend } = input;

  const runBuiltinCommand = useCallback(
    async (
      sessionId: string,
      line: string,
      ptyId?: string,
    ): Promise<string | false | undefined> => {
      const m = AXN_BUILTIN_RE.exec(line);
      if (!m) return undefined;
      const session = deps.current.sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return false;
      const [, cmd, argRaw] = m;
      const arg = argRaw?.replace(/^["']+|["']+$/g, '');
      // Resolve paths/cwd against the PTY the command was typed into — a
      // sub-shell's cwd can differ from the session's stored cwd.
      const targetPty = ptyId ?? ptyIdOf(session);

      const wsSessions = deps.current.sessionsRef.current.filter(
        (s) => s.workspaceId === session.workspaceId,
      );
      const idx = wsSessions.findIndex((s) => s.id === sessionId);

      switch (cmd) {
        case 'axn-session': {
          const rest = (argRaw ?? '').trim();
          // `create`/`set` subcommands; a bare `axn-session …` line is an
          // implicit `create` (the pre-subcommand spelling stays valid).
          const sub = /^(create|set)(?:\s|$)/.exec(rest)?.[1];
          if (sub === 'set') {
            const opts = parseSessionSetArgs(rest.slice(3));
            if (opts.error) return `echo ${JSON.stringify(`axn-session: ${opts.error}`)}`;
            const parts: string[] = [];
            if (opts.name !== undefined) {
              deps.current.renameSession(sessionId, opts.name);
              parts.push(opts.name ? `renamed to '${opts.name}'` : 'name cleared');
            }
            if (opts.summary !== undefined) {
              const summary = opts.summary.slice(0, SESSION_SUMMARY_MAX);
              deps.current.updateSession(sessionId, { summary });
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
            const hit = deps.current.workspacesRef.current.find(
              (w) => w.name.toLowerCase() === opts.workspace!.toLowerCase(),
            );
            if (hit) workspaceId = hit.id;
            else if (opts.createWs) workspaceId = deps.current.addWorkspace(opts.workspace);
            else
              return `echo ${JSON.stringify(
                `axn-session: no such workspace: ${opts.workspace} (use --create-ws to create it)`,
              )}`;
          }
          const wsName =
            deps.current.workspacesRef.current.find((w) => w.id === workspaceId)?.name ??
            workspaceId;
          const liveCwd =
            (await deps.current.backend.getCwd?.(targetPty).catch(() => null)) ?? session.cwd;
          const opened = (where?: string) =>
            `echo ${JSON.stringify(
              `axn-session: opened '${opts.name ?? 'session'}' in workspace '${wsName}'${
                where ? ` at ${where}` : ''
              }`,
            )}`;
          if (!opts.path || opts.path === '.') {
            const id = deps.current.openSession(
              workspaceId,
              liveCwd ?? undefined,
              opts.name,
              opts.background,
            );
            if (id && opts.summary) {
              deps.current.updateSession(id, { summary: opts.summary.slice(0, SESSION_SUMMARY_MAX) });
            }
            return opened(liveCwd ?? undefined);
          }
          const stat =
            (await deps.current.backend
              .statPath?.(targetPty, liveCwd ?? '/', opts.path)
              .catch(() => null)) ?? null;
          if (stat?.isDir) {
            const id = deps.current.openSession(workspaceId, stat.path, opts.name, opts.background);
            if (id && opts.summary) {
              deps.current.updateSession(id, { summary: opts.summary.slice(0, SESSION_SUMMARY_MAX) });
            }
            return opened(stat.path);
          }
          return `echo ${JSON.stringify(
            `axn-session: not a directory: ${opts.path} (a bare word is a path — use -w for a workspace, -n for a name)`,
          )}`;
        }
        case 'axn-session-mv': {
          if (!arg) return 'echo "usage: axn-session-mv <workspace>"';
          const existing = deps.current.workspacesRef.current.find(
            (w) => w.name.toLowerCase() === arg.toLowerCase(),
          );
          deps.current.moveSessionToWorkspace(sessionId, existing?.id ?? deps.current.addWorkspace(arg));
          return `echo ${JSON.stringify(`axn-session-mv: moved session to workspace '${arg}'`)}`;
        }
        case 'axn-session-window': {
          const tearOff = deps.current.tearOffSession;
          if (!tearOff) return 'echo "axn-session-window: new windows are not available here"';
          if (deps.current.sessionsRef.current.length <= 1) {
            return 'echo "axn-session-window: this is the only session in its window"';
          }
          void tearOff(sessionId);
          return false;
        }
        case 'axn-session-up': {
          const prev = wsSessions[idx - 1];
          if (idx > 0 && prev) {
            deps.current.moveSessionToWorkspace(sessionId, session.workspaceId, prev.id);
          }
          return false;
        }
        case 'axn-session-down': {
          const next = wsSessions[idx + 1];
          if (!next) return false;
          const afterNext = wsSessions[idx + 2];
          deps.current.moveSessionToWorkspace(sessionId, session.workspaceId, afterNext?.id ?? null);
          return false;
        }
        case 'axn-workspaces': {
          // One line per workspace; the one this session belongs to is
          // marked `*` — pairs with `axn-session -w <name>`.
          const lines = deps.current.workspacesRef.current.map(
            (w) => `${w.id === session.workspaceId ? '*' : ' '} ${w.name}`,
          );
          return `echo ${JSON.stringify(lines.join('\n'))}`;
        }
        case 'axn-workspace-up':
          deps.current.moveWorkspace(session.workspaceId, -1);
          return false;
        case 'axn-workspace-down':
          deps.current.moveWorkspace(session.workspaceId, 1);
          return false;
        case 'axn-focus': {
          // Bring a session view to the front: `shell` (default) the main
          // terminal, else a sub-view tab by 1-based index, kind, id (prefix)
          // or label/path-basename text.
          const target = arg?.trim();
          if (!target || target === 'shell') {
            deps.current.activateSessionTab(sessionId, 'shell');
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
          deps.current.activateSessionTab(sessionId, hit.id);
          return false;
        }
      }
      return undefined;
    },
    [],
  );

  // Give plugins a chance to intercept submitted input lines ("hidden
  // commands" like axn-devin-resume) before they reach the shell. Built-in
  // axn-session*/axn-workspace-* commands are handled first.
  const handleSessionCommand = useCallback(
    (
      sessionId: string,
      line: string,
      ptyId?: string,
    ): string | false | undefined | Promise<string | false | undefined> => {
      const session = deps.current.sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return undefined;
      const renameMatch = /^\s*axn-rename(?:\s+(.*?))?\s*$/.exec(line);
      if (renameMatch) {
        // `axn-rename` (no arg) clears the override → process-reported name.
        deps.current.renameSession(
          sessionId,
          renameMatch[1]?.trim().replace(/^["']+|["']+$/g, '') ?? '',
        );
        return false;
      }
      const summary = parseSessionSummary(line);
      if (summary !== undefined) {
        // `axn-session-summary` (no arg) clears the summary — same convention
        // as `axn-rename`.
        deps.current.updateSession(sessionId, { summary });
        return false;
      }
      const shMatch = /^\s*axn-sh(?:\s+(.*?))?\s*$/.exec(line);
      if (shMatch) {
        return (async (): Promise<string | false | undefined> => {
          const arg = shMatch[1]?.trim().replace(/^["']+|["']+$/g, '');
          const targetPty = ptyId ?? ptyIdOf(session);
          if (arg) {
            // A single argument that resolves to a directory opens an
            // interactive sub-shell there (`axn-sh .`, `axn-sh src`); anything
            // else is a `sh -c` one-shot command.
            const liveCwd =
              (await deps.current.backend.getCwd?.(targetPty).catch(() => null)) ?? session.cwd;
            const stat =
              (await deps.current.backend.statPath?.(targetPty, liveCwd ?? '/', arg).catch(() => null)) ??
              null;
            if (stat?.isDir) {
              deps.current.openSubShell(sessionId, undefined, stat.path);
              return false;
            }
          }
          deps.current.openSubShell(sessionId, arg || undefined);
          return false;
        })();
      }
      const installMatch = /^\s*axn-install(?:\s+(.*?))?\s*$/.exec(line);
      if (installMatch) {
        // Swap for `axn-term install …` and let it run visibly in the shell.
        // Resolve the running binary so the command also works in dev builds
        // where `axn-term` is not on PATH.
        return (async (): Promise<string | false | undefined> => {
          const exe = (await deps.current.platform.exePath?.().catch(() => undefined)) ?? 'axn-term';
          const args = installMatch[1]?.trim();
          return `${JSON.stringify(exe)} install${args ? ` ${args}` : ''}`;
        })();
      }
      if (
        /^\s*(axn-session(?:-mv|-up|-down|-window)?|axn-workspace-up|axn-workspace-down)(?:\s|$)/.test(
          line,
        )
      ) {
        return runBuiltinCommand(sessionId, line, ptyId);
      }
      // Plugin-declared commands (e.g. axn-devin-resume): the first word of
      // the line selects the owning plugin's command; `run` decides the
      // outcome (a string replaces the line, `false` swallows it, undefined
      // passes it through to the shell).
      const word = /^\s*(\S+)/.exec(line)?.[1];
      if (word) {
        for (const plugin of deps.current.enabledPluginsRef.current) {
          const declared = pluginCommands(plugin).find((c) => c.name === word && c.run);
          if (!declared?.run) continue;
          const arg = line.trim().slice(word.length).trim() || undefined;
          try {
            // `void` collapses to `undefined` at runtime: pass-through.
            return declared.run(deps.current.buildPluginApi(session, plugin), arg, line.trim()) as
              | string
              | false
              | undefined
              | Promise<string | false | undefined>;
          } catch (e) {
            console.warn(`[plugin:${plugin.id}] command ${word} failed:`, e);
            return `echo ${JSON.stringify(`${word}: command failed`)}`;
          }
        }
        if (word.startsWith('axn-')) {
          axnLog(
            'warn',
            'shell',
            `no plugin claimed '${word}' — enabled: ${deps.current.enabledPluginsRef.current.map((p) => p.id).join(',')}`,
          );
        }
      }
      return runCommandChain(
        deps.current.enabledPluginsRef.current.filter((p) => p.onCommand),
        (plugin) => plugin.onCommand?.(deps.current.buildPluginApi(session, plugin), line),
        (plugin, e) => console.warn(`[plugin:${plugin.id}] onCommand failed:`, e),
      );
    },
    [runBuiltinCommand],
  );

  // `PluginApi.runCommand` — every built api (SessionPanel call sites don't
  // see this callback) dispatches through the module-level holder.
  useEffect(
    () => registerSessionCommandDispatch(handleSessionCommand),
    [handleSessionCommand],
  );

  // Remote-control command lines (desktop: POST /sessions/<id>/command → the
  // 'remote-command' event) run through the same hidden/plugin dispatch as a
  // typed line — a replacement string is written to the PTY, `false`
  // swallows, `undefined` passes the line through.
  useEffect(() => {
    const unlisten = platform.onRemoteCommand?.(({ sessionId, line }) => {
      const session = deps.current.sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return;
      const ptyId = ptyIdOf(session);
      void Promise.resolve(handleSessionCommand(sessionId, line, ptyId)).then(
        (resolved) => {
          if (resolved === false) return;
          void deps.current.backend.write(ptyId, `${typeof resolved === 'string' ? resolved : line}\r`);
        },
      );
    });
    return () => unlisten?.();
  }, [platform, backend, handleSessionCommand]);

  // `axn-term session …` from a program inside one of our terminals (control
  // socket): the line runs through the same dispatch, for the PTY it came
  // from — never typed into it (an agent owns the foreground).
  useEffect(() => {
    const answer: ControlCommandHandler = async ({ ptyId, line }) => {
      const session = sessionForPty(deps.current.sessionsRef.current, ptyId);
      if (!session) return null;
      try {
        return controlReply(line, await handleSessionCommand(session.id, line, ptyId));
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };
    // desktop: the app's control socket; web: forwarded by the session host
    const unlisten = [platform.onControlCommand?.(answer), backend.onControlCommand?.(answer)];
    return () => unlisten.forEach((u) => u?.());
  }, [platform, backend, handleSessionCommand]);

  // Tab-completion for axn-* hidden commands: completes the command word, a
  // workspace name for axn-session-mv, or a filesystem path for axn-edit /
  // axn-browse / axn-session. Returns full replacement lines.
  const handleCompleteInput = useCallback(
    async (sessionId: string, line: string, ptyId?: string): Promise<string[]> => {
      const session = deps.current.sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return [];
      const declared = deps.current.enabledPluginsRef.current.flatMap((p) =>
        pluginCommands(p).map((cmd) => ({ plugin: p, cmd })),
      );
      const commands = [...AXN_BUILTIN_COMMANDS, ...declared.map((d) => d.cmd.name)];
      const argCommands = new Set([
        ...AXN_ARG_COMMANDS,
        ...declared.filter((d) => d.cmd.takesArg).map((d) => d.cmd.name),
      ]);
      const m = /^(\s*)(\S*)(?:\s+(.*))?$/.exec(line);
      if (!m) return [];
      const [, leading, word, rest] = m;

      if (rest === undefined) {
        if (!word.startsWith('axn-')) return [];
        const candidates = commands
          .filter((c) => c.startsWith(word) && c !== word)
          .map((c) => `${leading}${c}${argCommands.has(c) ? ' ' : ''}`);
        if (argCommands.has(word)) candidates.unshift(`${leading}${word} `);
        return candidates;
      }

      const completeWorkspaceArg = () => {
        const prefix = rest.replace(/^["']/, '');
        return deps.current.workspacesRef.current
          .map((w) => w.name)
          .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix)
          .map((n) => `${leading}${word} ${n.includes(' ') ? `"${n}"` : n}`);
      };

      if (word === 'axn-session-mv') {
        return completeWorkspaceArg();
      }
      if (word === 'axn-session') {
        // Flag-aware completion: a workspace name after -w/--workspace,
        // flag names while typing a dash, otherwise a filesystem path.
        // `rawCur` is the token being completed, `head` everything before.
        const rawCur = /\s$/.test(rest) ? '' : (/\S+$/.exec(rest)?.[0] ?? '');
        const head = rest.slice(0, rest.length - rawCur.length);
        const lineHead = `${leading}${word} ${head}`;
        const prevTok = shellTokens(head).pop();
        const firstTok = shellTokens(head)[0];

        // `axn-session set` completes only its own flags — no paths.
        if (firstTok === 'set') {
          if (AXN_SESSION_SET_FLAGS.includes(prevTok as (typeof AXN_SESSION_SET_FLAGS)[number])) {
            return [];
          }
          if (rawCur === '' || rawCur.startsWith('-')) {
            return AXN_SESSION_SET_FLAGS.filter((f) => f !== rawCur).map(
              (f) => `${lineHead}${f} `,
            );
          }
          return [];
        }
        // Completing the first token: `create`/`set` are candidates next to
        // the flag names and paths of the legacy implicit-create form.
        const subCandidates =
          firstTok !== 'create'
            ? ['create', 'set']
                .filter((s) => s.startsWith(rawCur) && s !== rawCur)
                .map((s) => `${lineHead}${s} `)
            : [];
        if (prevTok === '-w' || prevTok === '--workspace') {
          const prefix = rawCur.replace(/^["']/, '');
          return deps.current.workspacesRef.current
            .map((w) => w.name)
            .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix)
            .map((n) => `${lineHead}${n.includes(' ') ? `"${n}"` : n}`);
        }
        if (prevTok === '-n' || prevTok === '--name' || prevTok === '--summary') return [];
        if (rawCur.startsWith('-')) {
          return [
            ...subCandidates,
            ...AXN_SESSION_FLAGS.filter((f) => f.startsWith(rawCur) && f !== rawCur).map(
              (f) => `${lineHead}${f} `,
            ),
          ];
        }
        const liveCwd =
          (await deps.current.backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ??
          session.cwd;
        return [
          ...subCandidates,
          ...(await completePathArg(deps.current.pathDeps, liveCwd, lineHead, rawCur, false)),
        ];
      }
      if (
        word === 'axn-browse' ||
        word === 'axn-edit' ||
        word === 'axn-preview' ||
        word === 'axn-ide' ||
        word === 'axn-sh'
      ) {
        // Complete against the originating PTY's live cwd (a sub-shell's cwd
        // can differ from the session's stored cwd).
        const liveCwd =
          (await deps.current.backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ??
          session.cwd;
        return completePathArg(
          deps.current.pathDeps,
          liveCwd,
          `${leading}${word} `,
          rest,
          word === 'axn-edit' || word === 'axn-preview',
        );
      }
      const declaredCmd = declared.find((d) => d.cmd.name === word);
      if (declaredCmd?.cmd.completeArg) {
        try {
          const candidates = await declaredCmd.cmd.completeArg(
            deps.current.buildPluginApi(session, declaredCmd.plugin),
            rest,
          );
          return candidates.map((a) => `${leading}${word} ${a}`);
        } catch (e) {
          console.warn(`[plugin:${declaredCmd.plugin.id}] completion for ${word} failed:`, e);
          return [];
        }
      }
      const argCompletion = declaredCmd?.cmd.argCompletion;
      if (argCompletion === 'workspace') return completeWorkspaceArg();
      if (argCompletion) {
        const liveCwd =
          (await deps.current.backend.getCwd?.(ptyId ?? ptyIdOf(session)).catch(() => null)) ??
          session.cwd;
        return completePathArg(deps.current.pathDeps, liveCwd, `${leading}${word} `, rest, argCompletion === 'file');
      }
      return [];
    },
    [],
  );

  return { handleSessionCommand, handleCompleteInput };
}
