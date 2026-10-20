import {
  agentEventFile,
  agentPtyEventFile,
  agentHookScript,
  agentHookScriptPath,
  mergeHookSettings,
  parseHookEvent,
  removeHookSettings,
  type AgentHookEffect,
  type AgentHookSpec,
} from '@axn-term/plugin-sdk';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import { axnLog } from '../log';
import { sessionLastSelectedAt } from '../attention';

/**
 * Runtime half of the agent-hook bridge — the pure, dependency-free pieces
 * (event file naming, install script, config merge/remove, event parsing,
 * the `AgentHookSpec` contract) live in `@axn-term/plugin-sdk` (`hooks.ts`)
 * so external plugin authors can consume them.
 *
 * A plugin declares `hookSpec` on its `SessionViewPlugin` object; the host
 * calls `maybeWireHookSpec` on output dispatch (syncs the agent's config
 * per the plugin's `installHooks` setting and starts the tty-keyed event
 * poll), `releaseHookSpec` when the bound process ends, and `dropHookSpec`
 * on session boundaries. Built-ins declare `hookSpec` too — no plugin wires
 * the bridge by hand.
 */

export {
  agentEventDir,
  agentEventFile,
  agentHookScript,
  agentHookScriptPath,
  mergeHookSettings,
  parseHookEvent,
  removeHookSettings,
} from '@axn-term/plugin-sdk';
export type { AgentHookEffect, AgentHookSpec } from '@axn-term/plugin-sdk';

/**
 * Per-session hook-bridge runtime, keyed by `${agent}:${sessionId}`.
 * `eventFile` is resolved lazily once the agent process is seen — the same
 * PTY keeps the same tty for its lifetime, so the result is cached across
 * process restarts.
 */
export interface HookRuntime {
  home?: string;
  eventFile?: string;
  ptyEventFile?: string;
  resolveTried?: boolean;
  lastRaw?: string;
  pollTimer?: ReturnType<typeof setInterval>;
  /** Once a hook event was applied, deterministic hook state owns session.status. */
  hooksOwnStatus?: boolean;
  /**
   * When the hook raised its current *warning* flag ("needs input"). Such a
   * flag is informational: selecting the session after this acknowledges it.
   * Critical flags (a pending permission) wait for the agent's next event.
   */
  warningRaisedAt?: number;
}

const runtimes = new Map<string, HookRuntime>();
/** Last hook-config state applied to the agent's config file this run. */
const configApplied = new Map<string, boolean>();
const configBusy = new Set<string>();

function runtimeKey(spec: AgentHookSpec, sessionId: string): string {
  return `${spec.agent}:${sessionId}`;
}

export function getHookRuntime(spec: AgentHookSpec, sessionId: string): HookRuntime {
  const key = runtimeKey(spec, sessionId);
  let rt = runtimes.get(key);
  if (!rt) {
    rt = {};
    runtimes.set(key, rt);
  }
  return rt;
}

/** Whether hook state currently owns session.status for this session. */
export function hookStatusOwned(spec: AgentHookSpec, sessionId: string): boolean {
  return runtimes.get(runtimeKey(spec, sessionId))?.hooksOwnStatus === true;
}

/** Forget all runtime state for a session (fresh PTY / session close). */
export function dropHookRuntime(spec: AgentHookSpec, sessionId: string): void {
  stopHookPolling(spec, sessionId);
  runtimes.delete(runtimeKey(spec, sessionId));
}

type Ctx = SessionViewContext & PluginApi;

async function resolveHome(ctx: Ctx, rt: HookRuntime): Promise<string | undefined> {
  if (rt.home) return rt.home;
  try {
    const home = (await ctx.exec('printf %s "${AXN_TERM_AGENT_CONFIG_ROOT:-$HOME}"')).trim();
    if (home) rt.home = home;
    return home || undefined;
  } catch {
    return undefined;
  }
}

/** Poll interval for the session's latest-hook-event file. */
const EVENT_POLL_MS = 1500;

function applyHookEffect(
  ctx: Ctx,
  stateKey: string,
  effect: AgentHookEffect,
  rt: HookRuntime,
): void {
  rt.hooksOwnStatus = true;
  const session = ctx.getSession();
  if (effect.status !== undefined && (session.status ?? 'idle') !== effect.status) {
    ctx.updateSession(session.id, { status: effect.status });
  }
  if (effect.attention !== undefined) {
    // Skip redundant clears — activity events (PreToolUse) fire per tool call.
    // The ctx's pluginState is a stale snapshot inside the poll loop; read the
    // live session's flag instead.
    const liveFlag = (
      session.pluginState?.[stateKey] as { attention?: unknown } | undefined
    )?.attention;
    if (effect.attention !== null || liveFlag) ctx.setAttention(effect.attention);
    rt.warningRaisedAt = effect.attention?.level === 'warning' ? Date.now() : undefined;
  }
}

/** Drop a hook-raised warning flag once the user selected the session after it. */
function acknowledgeWarning(ctx: Ctx, rt: HookRuntime): void {
  if (rt.warningRaisedAt === undefined) return;
  if (sessionLastSelectedAt(ctx.session.id) <= rt.warningRaisedAt) return;
  rt.warningRaisedAt = undefined;
  ctx.setAttention(null);
}

async function pollEventFile(ctx: Ctx, spec: AgentHookSpec, stateKey: string, final = false): Promise<void> {
  const rt = runtimes.get(runtimeKey(spec, ctx.session.id));
  if (!rt) return;
  let contents = '';
  for (const path of [rt.ptyEventFile, rt.eventFile]) {
    if (!path) continue;
    try { contents = await ctx.readFile(path); } catch { /* old hook or missing file */ }
    // A disabled plugin (or closed session) may have disposed this runtime
    // while the read was in flight. Never apply it to a replacement runtime.
    if (runtimes.get(runtimeKey(spec, ctx.session.id)) !== rt) return;
    if (contents) break;
  }
  acknowledgeWarning(ctx, rt);
  if (!contents || contents === rt.lastRaw) return;
  rt.lastRaw = contents;
  const ev = parseHookEvent(contents);
  if (!ev) return;
  const effect = spec.mapEvent(ev);
  // A short-lived CLI can emit Stop and exit between polling ticks. Only
  // reconcile completion, and never overwrite work started since that exit.
  if (final && (effect?.status !== 'completed' || ctx.getSession().process)) return;
  if (effect) applyHookEffect(ctx, stateKey, effect, rt);
}

/**
 * Resolve the session tty → event file and start polling. Cheap no-op once
 * running; gives up when the backend cannot report a tty (e.g. web backend).
 */
export function ensureHookPolling(
  ctx: Ctx,
  spec: AgentHookSpec,
  stateKey = spec.stateKey ?? spec.agent,
): void {
  const rt = getHookRuntime(spec, ctx.session.id);
  if (rt.pollTimer) return;
  if (!rt.eventFile && !rt.ptyEventFile) {
    if (rt.resolveTried) return;
    rt.resolveTried = true;
    void (async () => {
      const [home, tty, stateDir] = await Promise.all([
        resolveHome(ctx, rt),
        ctx.getTty().catch(() => null),
        ctx.exec('printf %s "${AXN_TERM_STATE_DIR:-$HOME/.axn-term}"').catch(() => ''),
      ]);
      if (home && tty) rt.eventFile = agentEventFile(home, spec.agent, tty);
      if (stateDir.trim()) rt.ptyEventFile = agentPtyEventFile(
        stateDir.trim(), spec.agent, ctx.session.mainPtyId ?? ctx.session.id,
      );
      if (!rt.eventFile && !rt.ptyEventFile) return;
      if (runtimes.get(runtimeKey(spec, ctx.session.id)) !== rt) return;
      rt.pollTimer = setInterval(
        () => void pollEventFile(ctx, spec, stateKey),
        EVENT_POLL_MS,
      );
      void pollEventFile(ctx, spec, stateKey);
    })();
    return;
  }
  rt.pollTimer = setInterval(() => void pollEventFile(ctx, spec, stateKey), EVENT_POLL_MS);
}

export function stopHookPolling(spec: AgentHookSpec, sessionId: string): void {
  const rt = runtimes.get(runtimeKey(spec, sessionId));
  if (rt?.pollTimer) {
    clearInterval(rt.pollTimer);
    rt.pollTimer = undefined;
  }
}

/**
 * Process ended: stop polling and drop the status-ownership flag while
 * keeping the resolved event file — a restarted agent reuses it.
 */
export function releaseHookRuntime(spec: AgentHookSpec, sessionId: string): void {
  stopHookPolling(spec, sessionId);
  const rt = runtimes.get(runtimeKey(spec, sessionId));
  if (rt) {
    rt.hooksOwnStatus = false;
    // Keep the last payload: a restarted agent must not replay its previous
    // Stop/PermissionRequest while waiting for its first fresh hook event.
  }
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Add or remove axn-term's hook entries in the agent's config file per the
 * plugin's `installHooks` setting. Runs at most once per desired state per
 * app run; failures are logged and retried on the next detection edge.
 */
export function syncHookConfig(ctx: Ctx, spec: AgentHookSpec, want: boolean): void {
  if (configApplied.get(spec.agent) === want || configBusy.has(spec.agent)) return;
  configBusy.add(spec.agent);
  void (async () => {
    try {
      const rt = getHookRuntime(spec, ctx.session.id);
      const home = await resolveHome(ctx, rt);
      if (!home) return;
      const scriptPath = agentHookScriptPath(home);
      const host = {
        readFile: (p: string, b?: string) => ctx.readFile(p, b),
        writeFile: (p: string, c: string, b?: string) => ctx.writeFile(p, c, b),
        mkdir: (p: string, b?: string) => ctx.mkdir(p, b),
        exec: (c: string) => ctx.exec(c),
      };
      if (want) {
        // The shared script is needed regardless of the config mechanism.
        await ctx.mkdir('.axn-term', home);
        await ctx.writeFile(scriptPath, agentHookScript(), home);
        await ctx.exec(`chmod +x ${shellQuote(scriptPath)}`).catch(() => {});
      }
      if (want && spec.install) {
        await spec.install(host, home, scriptPath);
      } else if (!want && spec.uninstall) {
        await spec.uninstall(host, home);
      } else {
        const configPath = `${home}/${spec.configPath}`;
        let raw = '';
        try {
          raw = await ctx.readFile(configPath, home);
        } catch (e) {
          // Only a missing config starts empty. Permission/I/O errors and
          // malformed JSON must not turn an existing file into a blank config.
          if (!/ENOENT|no such file|not found|os error 2/i.test(String(e))) throw e;
        }
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        const next = want
          ? mergeHookSettings(parsed, spec, scriptPath)
          : removeHookSettings(parsed);
        if (JSON.stringify(parsed) !== JSON.stringify(next)) {
          if (want) {
            const configDir = spec.configPath.split('/').slice(0, -1).join('/');
            if (configDir) await ctx.mkdir(configDir, home);
          }
          await ctx.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, home);
        }
      }
      configApplied.set(spec.agent, want);
      axnLog(
        'info',
        `${spec.agent}-hooks`,
        `${want ? 'installed' : 'removed'} axn-term hook entries`,
      );
    } catch (e) {
      axnLog('warn', `${spec.agent}-hooks`, `failed to sync hook config: ${String(e)}`);
    } finally {
      configBusy.delete(spec.agent);
    }
  })();
}

// ---------------------------------------------------------------------------
// Declarative `hookSpec` wiring — the host drives the bridge for any plugin
// (built-in or external .mjs) that declares one.
// ---------------------------------------------------------------------------

/** The plugin shape the wiring helpers need (subset of SessionViewPlugin). */
export interface HookSpecPlugin {
  id: string;
  stateKey?: string;
  processPattern?: RegExp;
  hookSpec?: AgentHookSpec;
}

/**
 * Wire the hook bridge for a plugin declaring `hookSpec` while its bound
 * process is foreground: reconcile the agent's config with the plugin's
 * `installHooks` setting and start the tty-keyed event poll. Idempotent —
 * called on every output dispatch.
 */
export function maybeWireHookSpec(plugin: HookSpecPlugin, ctx: Ctx): void {
  const spec = plugin.hookSpec;
  if (!spec) return;
  const proc = ctx.getSession().process ?? ctx.session.process ?? '';
  if (!plugin.processPattern?.test(proc)) return;
  const want = (ctx.pluginSettings as { installHooks?: boolean } | undefined)
    ?.installHooks === true;
  syncHookConfig(ctx, spec, want);
  ensureHookPolling(ctx, spec, plugin.stateKey ?? spec.stateKey ?? spec.agent);
}

/**
 * Bound process ended: release the runtime and clear the flag. For a
 * spec-only plugin (no `onProcessEnd`) also applies the default terminal
 * badge rule — 'completed' persists, anything else falls back to idle.
 */
export function releaseHookSpec(plugin: HookSpecPlugin, ctx: Ctx): void {
  const spec = plugin.hookSpec;
  if (!spec) return;
  releaseHookRuntime(spec, ctx.session.id);
  ctx.setAttention(null);
  void pollEventFile(ctx, spec, plugin.stateKey ?? spec.stateKey ?? spec.agent, true);
}

/**
 * Session boundary (open/close): forget the runtime so a fresh PTY
 * re-resolves, and clear a stale flag.
 */
export function dropHookSpec(plugin: HookSpecPlugin, ctx: Ctx): void {
  const spec = plugin.hookSpec;
  if (!spec) return;
  dropHookRuntime(spec, ctx.session.id);
  ctx.setAttention(null);
}

/** Reconcile enabled plugins without treating a settings change as process exit. */
export function syncHookSpecPlugins(
  previous: readonly SessionViewPlugin[],
  enabled: readonly SessionViewPlugin[],
  contexts: (plugin: SessionViewPlugin) => Iterable<Ctx>,
): void {
  const enabledIds = new Set(enabled.map((plugin) => plugin.id));
  const previousIds = new Set(previous.map((plugin) => plugin.id));
  for (const plugin of previous) {
    if (!plugin.hookSpec || enabledIds.has(plugin.id)) continue;
    for (const ctx of contexts(plugin)) dropHookSpec(plugin, ctx);
  }
  // A re-enabled agent may be quietly waiting for input: do not require a
  // new output chunk or a foreground-process transition to resume polling.
  for (const plugin of enabled) {
    if (!plugin.hookSpec || previousIds.has(plugin.id)) continue;
    for (const ctx of contexts(plugin)) maybeWireHookSpec(plugin, ctx);
  }
}
