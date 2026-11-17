import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { ControlCommandHandler, SessionBackend } from '@axn-term/session-backend';
import type { ShellPlatform } from '../platform';
import { ptyIdOf, type ShellSession, type Workspace } from '../types';
import { axnLog } from './log';
import { runCommandChain } from './hiddenCommands';
import { controlReply, dispatchAppCommand, sessionForPty, type ControlReply } from './controlCommands';
import { AXN_VIEW_COMMANDS, completePathArg, parseSessionArgs } from './shellCommandSupport';
import {
  BUILTIN_ARG_COMMANDS,
  BUILTIN_COMMAND_NAMES,
  BUILTIN_COMMANDS,
} from './builtinCommands';
import { pluginCommands, type PluginApi, type SessionViewContext, type SessionViewPlugin } from './session-plugins';
import { pluginViewApi, registerSessionCommandDispatch } from './session-plugins/plugin';

/** What the command dispatch needs from ShellApp — read live through a ref. */
export interface SessionCommandDeps {
  backend: SessionBackend;
  platform: ShellPlatform;
  sessionsRef: MutableRefObject<ShellSession[]>;
  workspacesRef: MutableRefObject<Workspace[]>;
  enabledPluginsRef: MutableRefObject<SessionViewPlugin[]>;
  buildPluginApi: (session: ShellSession, plugin: SessionViewPlugin) => SessionViewContext & PluginApi;
  /** The window's selected session — the context of an app-level `axn-session create`. */
  selectedSessionId?: () => string | undefined;
  /** The `allowExternalCommands` setting: app-level `axn-session create --command`. */
  allowExternalCommands?: () => boolean;
  /** A plugin's settings section — the ctx of app-level (`appRun`) commands. */
  pluginSettingsOf?: (plugin: SessionViewPlugin) => unknown;
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
  /** Opens a broadcast-deck tab on the session (`axn-broadcast-deck`). */
  openBroadcastDeck?: (sessionId: string) => void;
  /**
   * 'go to session' (`axn-session select`): focus a session and make it the
   * only selection — the broadcast tile button calls the same function.
   */
  selectSession?: (sessionId: string) => void;
}

/**
 * The session command dispatch: built-in `axn-*` commands (the registry in
 * `builtinCommands.ts`), plugin-owned commands and `onCommand` hooks for a
 * submitted line, Tab completion, and the out-of-band entry points that
 * reuse them — `PluginApi.runCommand`, remote-control lines and
 * `axn-term session …` (control socket).
 */
export function useSessionCommands(input: SessionCommandDeps) {
  const deps = useRef(input);
  deps.current = input;
  const { platform, backend } = input;

  // Give plugins a chance to intercept submitted input lines ("hidden
  // commands" like axn-devin-resume) before they reach the shell. Built-in
  // commands (the BUILTIN_COMMANDS registry) are tried first: a word a
  // built-in owns never reaches the plugins, and an `undefined` outcome
  // passes the line through to the shell unchanged.
  const handleSessionCommand = useCallback(
    (
      sessionId: string,
      line: string,
      ptyId?: string,
    ): string | false | undefined | Promise<string | false | undefined> => {
      const session = deps.current.sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return undefined;
      const word = /^\s*(\S+)/.exec(line)?.[1];
      if (word) {
        const arg = line.trim().slice(word.length).trim() || undefined;
        const builtin = BUILTIN_COMMANDS.find((c) => c.name === word);
        if (builtin) {
          try {
            const result = builtin.run(
              { deps: deps.current, session, originPty: ptyId ?? ptyIdOf(session) },
              arg,
              line,
            );
            // A failed handler passes the line through unchanged — never
            // loses what the user typed.
            if (result instanceof Promise) {
              return result.catch((e) => {
                console.warn(`[builtin:${word}] failed:`, e);
                return undefined;
              });
            }
            return result;
          } catch (e) {
            console.warn(`[builtin:${word}] failed:`, e);
            return undefined;
          }
        }
        // Plugin-declared commands (e.g. axn-devin-resume): the first word
        // of the line selects the owning plugin's command; `run` decides the
        // outcome (a string replaces the line, `false` swallows it, undefined
        // passes it through to the shell).
        for (const plugin of deps.current.enabledPluginsRef.current) {
          const declared = pluginCommands(plugin).find((c) => c.name === word && (c.run || c.appRun));
          if (!declared) continue;
          try {
            // `void` collapses to `undefined` at runtime: pass-through.
            const outcome = declared.run
              ? declared.run(deps.current.buildPluginApi(session, plugin), arg, line.trim())
              : declared.appRun!(
                  { pluginSettings: deps.current.pluginSettingsOf?.(plugin), ...pluginViewApi },
                  arg,
                  line.trim(),
                );
            return outcome as
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
    [],
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

  // `axn-term command …` from any local process (desktop control socket,
  // no terminal): only commands declaring `appRun` run.
  useEffect(
    () =>
      platform.onAppCommand?.(async ({ line }) => {
        const trimmed = line.trim();
        if (/^axn-session\s/.test(trimmed) || trimmed === 'axn-session') {
          return appSessionCreate(trimmed);
        }
        return dispatchAppCommand(
          deps.current.enabledPluginsRef.current,
          trimmed,
          (plugin) => deps.current.pluginSettingsOf?.(plugin),
        );
      }),
    // appSessionCreate reads everything through deps.current
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [platform],
  );

  // Only `axn-session create` is app-level among the built-ins; a command to
  // type into the new session needs the allowExternalCommands setting.
  const appSessionCreate = async (line: string): Promise<ControlReply> => {
    const rest = line.slice('axn-session'.length).trim();
    if (!/^create(\s|$)/.test(rest)) {
      return { ok: false, error: 'only `axn-session create` is an app-level command' };
    }
    const opts = parseSessionArgs(rest.slice('create'.length));
    if (opts.error) return { ok: false, error: `axn-session: ${opts.error}` };
    if (opts.command && !deps.current.allowExternalCommands?.()) {
      return {
        ok: false,
        error: 'axn-session: starting a command from outside axn-term is off — enable allowExternalCommands in Settings → General',
      };
    }
    const sessions = deps.current.sessionsRef.current;
    const selected = deps.current.selectedSessionId?.();
    const session = sessions.find((s) => s.id === selected) ?? sessions[0];
    if (!session) return { ok: false, error: 'axn-session: open a session in this window first' };
    return controlReply(line, await handleSessionCommand(session.id, line, ptyIdOf(session)));
  };

  // Tab-completion for axn-* hidden commands: completes the command word,
  // then delegates the argument to the owning built-in's `completeArg` (or a
  // plugin command's `completeArg`/`argCompletion`). View-local commands
  // (axn-edit/browse/preview/ide) complete filesystem paths here — they are
  // not session-level built-ins but share the arg shape. Returns full
  // replacement lines.
  const handleCompleteInput = useCallback(
    async (sessionId: string, line: string, ptyId?: string): Promise<string[]> => {
      const session = deps.current.sessionsRef.current.find((s) => s.id === sessionId);
      if (!session) return [];
      const declared = deps.current.enabledPluginsRef.current.flatMap((p) =>
        pluginCommands(p).map((cmd) => ({ plugin: p, cmd })),
      );
      const commands = [
        ...BUILTIN_COMMAND_NAMES,
        ...AXN_VIEW_COMMANDS,
        ...declared.map((d) => d.cmd.name),
      ];
      const argCommands = new Set([
        ...BUILTIN_ARG_COMMANDS,
        ...AXN_VIEW_COMMANDS,
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

      const builtin = BUILTIN_COMMANDS.find((c) => c.name === word);
      if (builtin) {
        if (!builtin.completeArg) return [];
        try {
          return await builtin.completeArg(
            { deps: deps.current, session, originPty: ptyId ?? ptyIdOf(session) },
            rest,
            `${leading}${word} `,
          );
        } catch (e) {
          console.warn(`[builtin:${word}] completion failed:`, e);
          return [];
        }
      }

      if ((AXN_VIEW_COMMANDS as readonly string[]).includes(word)) {
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
      if (argCompletion === 'workspace') {
        const prefix = rest.replace(/^["']/, '');
        return deps.current.workspacesRef.current
          .map((w) => w.name)
          .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()) && n !== prefix)
          .map((n) => `${leading}${word} ${n.includes(' ') ? `"${n}"` : n}`);
      }
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
