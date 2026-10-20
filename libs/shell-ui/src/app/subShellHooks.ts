import { agentPtyEventFile, type AgentHookEffect } from '@axn-term/plugin-sdk';
import {
  hookPluginFor,
  nextHookAttention,
  pollHookEvents,
  type HookEventSource,
} from './session-plugins/agentHookBridge';
import type { EditorTab } from '../types';

/**
 * Hook status for agents running in a sub-shell tab. The hook bridge's
 * runtimes follow a session's main PTY; a tab's agent writes to its own
 * PTY's event log (`AXN_TERM_PTY_ID` is the tab id), which this watcher
 * polls from the tab's foreground-process tick and maps through the same
 * enabled plugin's `hookSpec` onto `tab.hookStatus`/`tab.hookAttention`.
 * The flag rolls up into the session's attention (`sessionAttention`).
 */

export type TabHookPatch = Pick<EditorTab, 'hookStatus' | 'hookAttention'>;

export interface TabHookWatcher {
  /** Call on every foreground-process poll; `process` is null at a bare prompt. */
  tick(process: string | null): Promise<void>;
}

export function createTabHookWatcher(opts: {
  tabId: string;
  read: (path: string) => Promise<string>;
  /** `$AXN_TERM_STATE_DIR` as the PTYs see it; undefined when it cannot be read. */
  stateDir: () => Promise<string | undefined>;
  getTab: () => EditorTab;
  update: (patch: TabHookPatch) => void;
}): TabHookWatcher {
  const sources = new Map<string, HookEventSource>();
  let stateDir: string | null | undefined;
  let running: { agent: string; mapEvent: (ev: Record<string, unknown>) => AgentHookEffect | null } | undefined;
  let busy = false;

  const poll = async (agent: string, mapEvent: (ev: Record<string, unknown>) => AgentHookEffect | null) => {
    if (stateDir === undefined) stateDir = (await opts.stateDir().catch(() => undefined)) ?? null;
    if (!stateDir) return;
    let src = sources.get(agent);
    if (!src) sources.set(agent, (src = {}));
    const events = await pollHookEvents(opts.read, [agentPtyEventFile(stateDir, agent, opts.tabId)], src);
    let status = opts.getTab().hookStatus;
    let attention = opts.getTab().hookAttention;
    const patch: TabHookPatch = {};
    for (const ev of events) {
      const effect = mapEvent(ev);
      if (!effect) continue;
      if (effect.status !== undefined && effect.status !== status) patch.hookStatus = status = effect.status;
      const next = nextHookAttention(attention, effect.attention);
      if (next !== undefined) patch.hookAttention = attention = next;
    }
    if (Object.keys(patch).length) opts.update(patch);
  };

  return {
    async tick(process) {
      if (busy) return;
      busy = true;
      try {
        const spec = process ? hookPluginFor(process)?.hookSpec : undefined;
        if (spec) {
          running = { agent: spec.agent, mapEvent: (ev) => spec.mapEvent(ev) };
          await poll(spec.agent, running.mapEvent);
          return;
        }
        if (!running) return;
        // The agent exited: pick up its last events (Stop may land right
        // before the exit), then keep only a completed badge.
        const ended = running;
        running = undefined;
        await poll(ended.agent, ended.mapEvent);
        const tab = opts.getTab();
        const patch: TabHookPatch = {};
        if (tab.hookStatus && tab.hookStatus !== 'completed') patch.hookStatus = undefined;
        if (tab.hookAttention) patch.hookAttention = null;
        if (Object.keys(patch).length) opts.update(patch);
      } finally {
        busy = false;
      }
    },
  };
}
