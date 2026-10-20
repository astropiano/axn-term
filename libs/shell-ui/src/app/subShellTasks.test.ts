import { afterEach, describe, it, expect } from 'vitest';
import { syncHookSpecPlugins } from './session-plugins/agentHookBridge';
import { claudePlugin } from './session-plugins/claude';
import { tabTaskPatch } from './subShellTasks';
import type { EditorTab } from '../types';

const tab = (patch: Partial<EditorTab> = {}): EditorTab => ({ id: 't1', path: '', kind: 'shell', ...patch });
const SCREEN = ['Update Todos', '  ☒ write the parser', '  ☐ wire the tab', '  ☐ test it'];

describe('sub-shell tab tasks', () => {
  afterEach(() => syncHookSpecPlugins([claudePlugin], [], () => []));

  it("reads the agent's task list off the tab's screen", () => {
    syncHookSpecPlugins([], [claudePlugin], () => []);
    const patch = tabTaskPatch(tab(), 'claude', () => SCREEN);
    expect(patch?.progress).toBe(33);
    expect(patch?.tasks?.map((t) => [t.title, t.done])).toEqual([
      ['write the parser', true],
      ['wire the tab', false],
      ['test it', false],
    ]);
    // unchanged screen → no patch; a vanished block keeps the list
    expect(tabTaskPatch(tab({ tasks: patch!.tasks }), 'claude', () => SCREEN)).toBeUndefined();
    expect(tabTaskPatch(tab({ tasks: patch!.tasks }), 'claude', () => ['$ '])).toBeUndefined();
  });

  it('ignores processes no enabled plugin parses — and disabled plugins', () => {
    expect(tabTaskPatch(tab(), 'claude', () => SCREEN)).toBeUndefined();
    syncHookSpecPlugins([], [claudePlugin], () => []);
    expect(tabTaskPatch(tab(), 'vim', () => SCREEN)).toBeUndefined();
  });

  it('drops an unfinished list when the agent exits, keeps a finished one', () => {
    syncHookSpecPlugins([], [claudePlugin], () => []);
    const open = [{ id: 'a', title: 'x', done: false }];
    expect(tabTaskPatch(tab({ tasks: open, progress: 0 }), null, () => [])).toEqual({ tasks: undefined, progress: undefined });
    const done = [{ id: 'a', title: 'x', done: true }];
    expect(tabTaskPatch(tab({ tasks: done, progress: 100 }), null, () => [])).toBeUndefined();
  });
});
