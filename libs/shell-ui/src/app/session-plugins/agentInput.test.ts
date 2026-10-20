import { afterEach, describe, it, expect } from 'vitest';
import {
  agentInputPluginFor,
  agentInputPluginForTitle,
  syncHookSpecPlugins,
} from './agentHookBridge';
import { devinPlugin } from './devinTasks';
import { claudePlugin } from './claude';
import { codexPlugin } from './codex';
import { geminiPlugin } from './gemini';

afterEach(() => syncHookSpecPlugins([], [], () => []));

describe('agentInput plugins', () => {
  it('resolve from the enabled plugins only', () => {
    expect(agentInputPluginFor('devin')).toBeUndefined();
    syncHookSpecPlugins([], [devinPlugin, claudePlugin], () => []);
    expect(agentInputPluginFor('devin')?.id).toBe('devin');
    // claude edits its input too, but declares no agentInput: interception
    // stays off while it runs, as before.
    expect(agentInputPluginFor('claude')).toBeUndefined();
    expect(agentInputPluginFor('zsh')).toBeUndefined();
  });

  it('match the terminal title independently of the process', () => {
    syncHookSpecPlugins([], [devinPlugin], () => []);
    expect(agentInputPluginForTitle('Devin — fixing tests')?.id).toBe('devin');
    expect(agentInputPluginForTitle('vim notes.md')).toBeUndefined();
  });
});

describe('agent process patterns', () => {
  it.each([
    [devinPlugin.processPattern, 'devin', 'my-devin-wrapper'],
    [claudePlugin.processPattern, 'claude', 'xclaude-monitor'],
    [codexPlugin.processPattern, 'codex', 'mycodex'],
    [geminiPlugin.processPattern, 'gemini', 'not-gemini'],
  ])('%s matches the CLI name, not names merely containing it', (re, name, other) => {
    expect(re?.test(name)).toBe(true);
    expect(re?.test(name.toUpperCase())).toBe(true);
    expect(re?.test(other)).toBe(false);
  });
});
