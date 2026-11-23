import { it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { devinPlugin } from './app/session-plugins/devinTasks';
import type { ShellSession } from './types';

vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(async()=>{}), listen: vi.fn(async()=>()=>{}) }));

const STATE_FILE =
  process.env.AXN_STATE_FILE ?? join(homedir(), '.axn-term/state.json');

it.skipIf(!existsSync(STATE_FILE))('replay real output in 4KB chunks', () => {
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const sessions: any[] = [];
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.output && o.id) sessions.push(o);
      Object.values(o).forEach(walk);
    }
  };
  walk(s);
  for (const stored of sessions) {
    if (!(stored.output as string).includes('Updated todo list')) continue;
    const session: ShellSession = {
      id: stored.id, workspaceId: 'w', name: 'n', topic: '', summary: '',
      tasks: [], progress: 0, output: '', agentInput: 'devin', process: 'devin',
    } as ShellSession;
    const pluginState: Record<string, unknown> = {};
    const updates: any[] = [];
    const ctx: any = {
      session,
      updateSession: (_id: string, patch: any) => { Object.assign(session, patch); updates.push(patch); },
      writeToSession: async () => {},
      updatePluginState: (p: any) => Object.assign(pluginState, p),
      getSession: () => session,
      getSessionCount: () => 1,
      get pluginState() { return pluginState; },
      pluginSettings: {},
      exec: async () => '', waitForSessionOutput: async () => true,
      getCwd: async () => null, openBrowser: () => {}, openTab: () => {},
      repoMenuItems: () => [], isProgressHandled: () => false,
      getScreenLines: () => [], setAttention: () => {}, setBanner: () => {}, setRestoring: () => {},
      appState: undefined, updateAppState: () => {},
    };
    const out: string = stored.output;
    const CH = 4096;
    for (let i = 0; i < out.length; i += CH) {
      const text = out.slice(i, i + CH);
      session.output = (session.output + text).slice(-200000);
      devinPlugin.onOutput?.(ctx, text);
    }
    console.log(stored.id.slice(0,8), '→ session.tasks:', session.tasks?.length, 'progress:', session.progress, 'pluginState.tasks:', (pluginState.tasks as any[]|undefined)?.length);
  }
});
