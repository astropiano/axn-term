import type { SessionAttention, ShellSession } from '../../types';
import type { SessionViewContext, PluginApi, SessionViewPlugin } from './plugin';
import {
  dropHookSpec,
  maybeWireHookSpec,
  releaseHookSpec,
} from './agentHookBridge';

/**
 * Shared ctx harness for agent plugin tests — in-memory file map, recorded
 * session/attention calls, live pluginState view (plugins read flags off
 * `getSession().pluginState` inside their poll loops).
 */

export type Ctx = SessionViewContext & PluginApi;

export const TEST_HOME = '/home/tester';
export const TEST_TTY = '/dev/ttys099';

export interface Harness {
  ctx: Ctx;
  session: ShellSession;
  store: Record<string, unknown>;
  updateSessionCalls: Array<{ sessionId: string; patch: Partial<ShellSession> }>;
  attentionCalls: Array<SessionAttention | null>;
  files: Map<string, string>;
  setScreen: (lines: string[]) => void;
}

export function makeHarness(
  stateKey: string,
  overrides: Partial<ShellSession> = {},
  pluginState: Record<string, unknown> = {},
  pluginSettings: Record<string, unknown> = {},
): Harness {
  const session: ShellSession = {
    id: `${stateKey}-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    process: stateKey,
    ...overrides,
  };
  const store: Record<string, unknown> = { [stateKey]: pluginState };
  const files = new Map<string, string>();
  const updateSessionCalls: Array<{ sessionId: string; patch: Partial<ShellSession> }> = [];
  const attentionCalls: Array<SessionAttention | null> = [];
  let screen: string[] = [];
  const ctx = {
    session,
    updateSession: (sessionId: string, patch: Partial<ShellSession>) => {
      updateSessionCalls.push({ sessionId, patch });
    },
    writeToSession: async () => {},
    updatePluginState: (patch: unknown) => {
      store[stateKey] = { ...(store[stateKey] as Record<string, unknown>), ...(patch as Record<string, unknown>) };
    },
    get pluginState() {
      return store[stateKey];
    },
    pluginSettings,
    getSession: () => session,
    getSessionCount: () => 1,
    exec: async (command: string) => (command.includes('$HOME') ? TEST_HOME : ''),
    waitForSessionOutput: async () => true,
    getCwd: async () => null,
    getTty: async () => TEST_TTY,
    openBrowser: () => {},
    isProgressHandled: () => false,
    getScreenLines: () => screen,
    setAttention: (a: SessionAttention | null) => {
      attentionCalls.push(a);
      store[stateKey] = { ...(store[stateKey] as Record<string, unknown>), attention: a };
    },
    setBanner: () => {},
    setRestoring: () => {},
    openTab: () => {},
    openSubShell: () => {},
    readFile: async (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error(`ENOENT: ${path}`);
      return contents;
    },
    writeFile: async (path: string, contents: string) => {
      files.set(path, contents);
    },
    statPath: async () => null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    appState: undefined,
    updateAppState: () => {},
  } as unknown as Ctx;
  // Live pluginState view on the session — plugins read flags off
  // getSession().pluginState inside their poll loops.
  Object.defineProperty(session, 'pluginState', { get: () => store });
  return {
    ctx,
    session,
    store,
    updateSessionCalls,
    attentionCalls,
    files,
    setScreen: (l) => { screen = l; },
  };
}

/**
 * Mirror the host's output dispatch (`ShellApp.handleSessionOutput`): the
 * plugin's `onOutput` runs, then the hook bridge is wired for `hookSpec`
 * declarers.
 */
export function dispatchOutput(
  plugin: SessionViewPlugin,
  ctx: Ctx,
  text = 'chunk',
): void {
  plugin.onOutput?.(ctx, text);
  if (plugin.hookSpec) maybeWireHookSpec(plugin, ctx);
}

/**
 * Mirror the host's process-end dispatch: release the hook bridge first,
 * run the plugin's handler, then apply the default terminal badge for
 * spec-only plugins ('completed' persists, anything else → idle).
 */
export function dispatchProcessEnd(plugin: SessionViewPlugin, ctx: Ctx): void {
  if (plugin.hookSpec) releaseHookSpec(plugin, ctx);
  plugin.onProcessEnd?.(ctx);
  if (plugin.hookSpec && !plugin.onProcessEnd) {
    const s = ctx.getSession();
    const status = s.status ?? 'idle';
    if (status !== 'completed' && status !== 'idle') {
      ctx.updateSession(s.id, { status: 'idle' });
    }
  }
}

/** Mirror the host's session-close dispatch. */
export function dispatchClose(plugin: SessionViewPlugin, ctx: Ctx): void {
  if (plugin.hookSpec) dropHookSpec(plugin, ctx);
  void plugin.onClose?.(ctx);
}

/** Mirror the host's session-open dispatch. */
export function dispatchSessionOpen(plugin: SessionViewPlugin, ctx: Ctx): void {
  if (plugin.hookSpec) dropHookSpec(plugin, ctx);
  void plugin.pendingRestore?.(ctx);
  plugin.onSessionOpen?.(ctx);
}
