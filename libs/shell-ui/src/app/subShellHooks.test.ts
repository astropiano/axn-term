import { afterEach, describe, it, expect } from 'vitest';
import type { AgentHookSpec } from '@axn-term/plugin-sdk';
import { syncHookSpecPlugins } from './session-plugins/agentHookBridge';
import type { SessionViewPlugin } from './session-plugins/plugin';
import { createTabHookWatcher } from './subShellHooks';
import { sessionAttention } from './attention';
import type { EditorTab, ShellSession } from '../types';

const spec: AgentHookSpec = {
  agent: 'toy',
  events: [],
  configPath: '.toy.json',
  mapEvent: (ev) => {
    switch (ev.hook_event_name) {
      case 'Go':
        return { status: 'running', attention: null };
      case 'NeedYou':
        return { status: 'blocked', attention: { level: 'critical', message: 'approve?' } };
      case 'Nudge':
        return { attention: { level: 'warning', message: 'waiting' } };
      case 'Done':
        return { status: 'completed', attention: null };
      default:
        return null;
    }
  },
};
const plugin: SessionViewPlugin = { id: 'toy', title: 'toy', version: '0.0.1', processPattern: /toyagent/, hookSpec: spec };
const LOG = '/state/toy-events/pty-tab-1.jsonl';

function harness() {
  syncHookSpecPlugins([], [plugin], () => []);
  const files = new Map<string, string>();
  let tab: EditorTab = { id: 'tab-1', path: '', kind: 'shell', label: 'agent' };
  const watcher = createTabHookWatcher({
    tabId: 'tab-1',
    read: async (p) => {
      const f = files.get(p);
      if (f === undefined) throw new Error('ENOENT');
      return f;
    },
    stateDir: async () => '/state',
    getTab: () => tab,
    update: (patch) => {
      tab = { ...tab, ...patch };
    },
  });
  const append = (ev: Record<string, unknown>) => files.set(LOG, `${files.get(LOG) ?? ''}${JSON.stringify(ev)}\n`);
  return { watcher, append, tab: () => tab };
}

afterEach(() => syncHookSpecPlugins([plugin], [], () => []));

describe('sub-shell tab hook watcher', () => {
  it('maps the tab PTY log onto the tab and keeps a pending permission critical', async () => {
    const h = harness();
    h.append({ hook_event_name: 'Go' });
    await h.watcher.tick('toyagent');
    expect(h.tab().hookStatus).toBe('running');
    h.append({ hook_event_name: 'NeedYou' });
    h.append({ hook_event_name: 'Nudge' });
    await h.watcher.tick('toyagent');
    expect(h.tab().hookStatus).toBe('blocked');
    expect(h.tab().hookAttention).toEqual({ level: 'critical', message: 'approve?' });
  });

  it('ignores processes no enabled hook plugin claims', async () => {
    const h = harness();
    h.append({ hook_event_name: 'Go' });
    await h.watcher.tick('vim');
    expect(h.tab().hookStatus).toBeUndefined();
  });

  it('reads the last events on exit and keeps only a completed badge', async () => {
    const h = harness();
    h.append({ hook_event_name: 'Go' });
    await h.watcher.tick('toyagent');
    h.append({ hook_event_name: 'Done' });
    await h.watcher.tick(null);
    expect(h.tab().hookStatus).toBe('completed');

    const h2 = harness();
    h2.append({ hook_event_name: 'NeedYou' });
    await h2.watcher.tick('toyagent');
    await h2.watcher.tick(null);
    expect(h2.tab().hookStatus).toBeUndefined();
    expect(h2.tab().hookAttention).toBeNull();
  });

  it("rolls a tab's flag up into the session's attention", () => {
    const session = {
      id: 's1',
      name: 'build',
      editors: [{ id: 'tab-1', path: '', kind: 'shell', label: 'agent', hookAttention: { level: 'critical', message: 'approve?' } }],
    } as unknown as ShellSession;
    expect(sessionAttention(session, [])).toEqual({ 'tab:agent': { level: 'critical', message: 'approve?' } });
  });
});
