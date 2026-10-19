import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agentsPlugin } from './agents';
import {
  clearPersonas,
  listPersonas,
  parsePersonas,
  registerPersonas,
  resolvePersona,
} from './agentRegistry';
import {
  actionPrompt,
  parseWorkflows,
  resolveAgentSpec,
} from './devWorkflow';
import { pluginCommands } from './plugin';
import type { ShellSession } from '../../types';
import type { PluginApi, SessionViewContext } from './plugin';

type Ctx = SessionViewContext & PluginApi;

const session = (over: Partial<ShellSession> = {}): ShellSession =>
  ({
    id: 's1',
    workspaceId: 'w1',
    name: 's1',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    cwd: '/repo',
    ...over,
  }) as ShellSession;

function makeCtx(over: Partial<Ctx> = {}): Ctx {
  const pluginState: Record<string, unknown> = {};
  return {
    session: session(),
    pluginSettings: {},
    pluginState,
    updatePluginState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(pluginState, patch),
    ),
    readFile: vi.fn(async () => ''),
    writeToSession: vi.fn(async () => {}),
    waitForSessionOutput: vi.fn(async () => true),
    openSession: vi.fn(),
    getCwd: async () => '/repo',
    getSession: () => session(),
    exec: vi.fn(async () => { throw new Error('no exec'); }),
    setBanner: vi.fn(),
    ...over,
  } as unknown as Ctx;
}

const personasSettings = {
  enabled: true,
  personas: {
    reviewer: {
      cli: 'devin',
      model: 'opus',
      args: '--flag',
      'prompt-file': '.axn/review.md',
      description: 'reviews code',
    },
    impl: { cli: 'claude', model: 'sonnet', prompt: 'Implement it.' },
    quickfix: 'codex',
  },
};

beforeEach(() => clearPersonas());

describe('parsePersonas', () => {
  it('parses the agents settings section', () => {
    const p = parsePersonas(personasSettings);
    expect(p.map((x) => x.name)).toEqual(['reviewer', 'impl', 'quickfix']);
    expect(p[0]).toMatchObject({
      cli: 'devin',
      model: 'opus',
      args: '--flag',
      promptFile: '.axn/review.md',
      description: 'reviews code',
    });
    expect(p[2]).toMatchObject({ name: 'quickfix', cli: 'codex' });
  });

  it('accepts the personas map directly and string shorthand', () => {
    const p = parsePersonas({ solo: 'gemini', named: { model: 'flash' } });
    expect(p[0]).toMatchObject({ name: 'solo', cli: 'gemini' });
    // an object's cli defaults to the persona name
    expect(p[1]).toMatchObject({ name: 'named', cli: 'named', model: 'flash' });
  });

  it('skips non-spec entries and handles empty input', () => {
    expect(parsePersonas(undefined)).toEqual([]);
    expect(parsePersonas({ enabled: true, note: 5 })).toEqual([]);
  });
});

describe('persona registry', () => {
  it('registerPersonas replaces the set; resolvePersona looks up by name', () => {
    registerPersonas(parsePersonas(personasSettings));
    expect(resolvePersona('reviewer')).toMatchObject({ cli: 'devin' });
    expect(resolvePersona('nope')).toBeUndefined();
    registerPersonas([]);
    expect(listPersonas()).toEqual([]);
  });

  it('returns a defensive copy', () => {
    registerPersonas(parsePersonas(personasSettings));
    const list = listPersonas();
    list[0].cli = 'mutated';
    expect(resolvePersona('reviewer')?.cli).toBe('devin');
  });
});

describe('resolveAgentSpec', () => {
  it('fills unset fields from the persona', () => {
    registerPersonas(parsePersonas(personasSettings));
    expect(resolveAgentSpec({ profile: 'reviewer' })).toEqual({
      cli: 'devin',
      model: 'opus',
      args: '--flag',
      profile: 'reviewer',
    });
  });

  it('inline fields override the persona', () => {
    registerPersonas(parsePersonas(personasSettings));
    expect(resolveAgentSpec({ profile: 'reviewer', cli: 'claude' }).cli).toBe('claude');
    expect(resolveAgentSpec({ profile: 'reviewer', model: 'sonnet' }).model).toBe('sonnet');
  });

  it('unresolved profiles fall back to the name as cli', () => {
    expect(resolveAgentSpec({ profile: 'claude' })).toMatchObject({ cli: 'claude' });
    expect(resolveAgentSpec(undefined)).toEqual({});
  });
});

describe('dev-workflow persona references', () => {
  const wfWith = (steps: Record<string, unknown>) =>
    parseWorkflows({ workflows: { flow: { states: Object.keys(steps), steps } } })[0];

  it('parses `agent: <name>` as a profile reference', () => {
    const wf = wfWith({ review: { agent: 'reviewer', prompt: 'Review this.' } });
    expect(wf.steps['review']).toHaveLength(1);
    expect(wf.steps['review'][0].agent).toEqual({ profile: 'reviewer' });
  });

  it('persona prompt-file feeds actionPrompt when the action has none', async () => {
    registerPersonas(parsePersonas(personasSettings));
    const wf = wfWith({ review: { agent: 'reviewer' } });
    const ctx = makeCtx({ readFile: vi.fn(async () => 'Review the diff.') });
    await expect(actionPrompt(ctx, wf.steps['review'][0], {})).resolves.toBe(
      'Review the diff.',
    );
    expect(ctx.readFile).toHaveBeenCalledWith('.axn/review.md', '/repo');
  });

  it('action-local prompt wins over the persona prompt', async () => {
    registerPersonas(parsePersonas(personasSettings));
    const wf = wfWith({ impl: { agent: 'impl', prompt: 'Direct.' } });
    const ctx = makeCtx();
    await expect(actionPrompt(ctx, wf.steps['impl'][0], {})).resolves.toBe('Direct.');
    expect(ctx.readFile).not.toHaveBeenCalled();
  });

  it('action-local prompt still applies over a persona prompt', async () => {
    registerPersonas(parsePersonas(personasSettings));
    const wf = wfWith({ impl: { agent: 'impl' } });
    const ctx = makeCtx();
    await expect(actionPrompt(ctx, wf.steps['impl'][0], {})).resolves.toBe('Implement it.');
  });
});

describe('agents plugin', () => {
  const cmd = (name: string) => pluginCommands(agentsPlugin).find((c) => c.name === name)!;

  it('axn-agent types the persona launch line and stamps the session', async () => {
    const ctx = makeCtx({ pluginSettings: personasSettings });
    const line = await cmd('axn-agent').run!(ctx, 'impl', 'axn-agent impl');
    expect(line).toBe('claude --model sonnet "$(printf %s \'SW1wbGVtZW50IGl0Lg==\' | base64 -d)"');
    expect(ctx.updatePluginState).toHaveBeenCalledWith({ persona: 'impl' });
    expect(ctx.readFile).not.toHaveBeenCalled();
  });

  it('axn-agent resolves the persona prompt-file when no inline prompt', async () => {
    const ctx = makeCtx({
      pluginSettings: personasSettings,
      readFile: vi.fn(async () => 'Review the diff.'),
    });
    const line = await cmd('axn-agent').run!(ctx, 'reviewer', 'axn-agent reviewer');
    // devin uses ` -- ` before the prompt arg
    expect(line).toMatch(/^devin --model opus --flag -- "\$\(printf %s '.+' \| base64 -d\)"$/);
    expect(ctx.readFile).toHaveBeenCalledWith('.axn/review.md', '/repo');
  });

  it('axn-agent echoes usage/errors without launching', async () => {
    const ctx = makeCtx({ pluginSettings: personasSettings });
    expect(await cmd('axn-agent').run!(ctx, 'ghost', 'x')).toContain('unknown persona');
    expect(await cmd('axn-agent').run!(ctx, undefined, 'x')).toContain('usage: axn-agent');
    expect(ctx.updatePluginState).not.toHaveBeenCalled();
  });

  it('completes persona names for axn-agent', () => {
    const ctx = makeCtx({ pluginSettings: personasSettings });
    expect(cmd('axn-agent').completeArg!(ctx, 're')).toEqual(['reviewer']);
    expect(cmd('axn-agent').completeArg!(ctx, '')).toEqual(['reviewer', 'impl', 'quickfix']);
  });

  it('session menu offers a launcher per persona; onSessionOpen seeds it', async () => {
    const ctx = makeCtx({ pluginSettings: personasSettings });
    const items = agentsPlugin.sessionMenuItems!(ctx);
    expect(items.map((i) => i.label)).toEqual([
      'New session with reviewer',
      'New session with impl',
      'New session with quickfix',
    ]);
    items[1].onClick();
    expect(ctx.openSession).toHaveBeenCalledWith('/repo', 'impl');

    // the spawned session fires onSessionOpen → stamp + seed launch line
    const writes: string[] = [];
    const newCtx = makeCtx({
      session: session({ id: 's2', name: 'impl' }),
      pluginSettings: personasSettings,
      writeToSession: vi.fn(async (d: string) => {
        writes.push(d);
      }),
    });
    agentsPlugin.onSessionOpen!(newCtx);
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(newCtx.updatePluginState).toHaveBeenCalledWith({ persona: 'impl' });
    expect(writes[0]).toContain('claude --model sonnet');
    expect(writes[0]).toContain('| base64 -d)"\n');
  });

  it('onSessionOpen ignores sessions that were not persona launches', () => {
    const ctx = makeCtx({ session: session({ name: 'plain' }) });
    agentsPlugin.onSessionOpen!(ctx);
    expect(ctx.writeToSession).not.toHaveBeenCalled();
    expect(ctx.updatePluginState).not.toHaveBeenCalled();
  });

  it('renderRow badges persona-stamped sessions', () => {
    const stamped = makeCtx();
    stamped.session.pluginState = { agents: { persona: 'reviewer' } };
    expect(agentsPlugin.renderRow!(stamped)).not.toBeNull();
    expect(agentsPlugin.renderRow!(makeCtx())).toBeNull();
  });

  it('syncs the registry from its settings on ctx touches', () => {
    const ctx = makeCtx({ pluginSettings: personasSettings });
    agentsPlugin.onSessionOpen!(ctx);
    expect(resolvePersona('reviewer')).toMatchObject({ cli: 'devin' });
  });
});
