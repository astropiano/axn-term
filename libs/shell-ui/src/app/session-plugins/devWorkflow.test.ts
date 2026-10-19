import { describe, it, expect, vi } from 'vitest';
import type { ShellSession } from '../../types';
import type { SessionViewContext, PluginApi } from './plugin';
import { pluginCommands } from './plugin';

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

import {
  actionRunInfo,
  agentCommand,
  agentLaunchLine,
  decodeState,
  devWorkflowPlugin,
  encodeState,
  envName,
  envPrefix,
  expandVars,
  parseMrRef,
  parseStartVars,
  parseWorkflows,
  parseWorkflowVars,
  renderTemplate,
  shellLine,
  shellTokens,
  mrReviewLaunch,
  mrWorkspace,
  startMrReview,
  transitionAllowed,
  varChipFor,
  type BindingState,
  type WorkflowAction,
  type WorkflowDef,
} from './devWorkflow';
import type { MrRowEnv } from './mrActions';
import { parsePersonas, registerPersonas } from './agentRegistry';
// Side-effect imports — the agent plugins register their CLIs' launchers.
import './claude';
import './codex';
import './devinTasks';
import './gemini';

type Ctx = SessionViewContext & PluginApi;

const WORKFLOW_SETTINGS = {
  workflows: {
    speckit: {
      title: 'Speckit',
      tracking: { file: '.axn/workflow.yaml' },
      states: ['plan', 'plan-review', 'implement'],
      start: 'plan',
      transitions: { plan: ['plan-review'] },
      steps: {
        plan: {
          agent: { cli: 'devin', model: 'opus' },
          prompt: 'Plan it.',
          description: 'Draft the implementation plan.',
        },
        implement: { command: 'sh .ci/run.sh {{state}}', 'run-in': 'headless' },
      },
    },
    offices: {
      states: ['think', 'do', 'review'],
    },
    multi: {
      states: ['build', 'verify'],
      steps: {
        build: {
          // reserved key: the state's own description, not an action
          description: 'Build the change, then lint the spec.',
          draft: { agent: { cli: 'devin' }, prompt: 'Draft it.' },
          'spec-lint': {
            command: 'sh .ci/lint.sh',
            'run-in': 'headless',
            description: 'Lint the spec files.',
          },
        },
        // bare string shorthand for a command action
        verify: { 'dry-check': 'make check' },
      },
    },
  },
};

function makeSession(overrides: Partial<ShellSession> = {}): ShellSession {
  return {
    id: 's1',
    workspaceId: 'w1',
    name: 'session',
    topic: '',
    summary: '',
    tasks: [],
    progress: 0,
    output: '',
    cwd: '/repo',
    ...overrides,
  };
}

interface Harness {
  ctx: Ctx;
  stateStore: Record<string, unknown>;
  appStore: Record<string, unknown>;
  writes: string[];
  files: Record<string, string>;
  execCalls: { command: string; cwd?: string }[];
  commandCalls: string[];
  subShells: { id: string; command?: string; cwd?: string; label?: string; agent?: string }[];
  opened: { cwd?: string; name?: string }[];
  attention: unknown[];
  banners: (unknown | null)[];
}

function makeCtx(
  opts: {
    session?: ShellSession;
    settings?: unknown;
    files?: Record<string, string>;
    execImpl?: (command: string, cwd?: string) => Promise<string>;
    commandImpl?: (line: string) => Promise<string | false | undefined>;
    statImpl?: (path: string) => Promise<{ isDir: boolean } | null>;
  } = {},
): Harness {
  const stateStore: Record<string, unknown> = {};
  const appStore: Record<string, unknown> = {};
  const files = { ...(opts.files ?? {}) };
  const writes: string[] = [];
  const execCalls: { command: string; cwd?: string }[] = [];
  const commandCalls: string[] = [];
  const subShells: Harness['subShells'] = [];
  const opened: Harness['opened'] = [];
  const attention: unknown[] = [];
  const banners: (unknown | null)[] = [];
  const session = opts.session ?? makeSession();
  const ctx = {
    session,
    updateSession: () => {},
    writeToSession: async (d: string) => {
      writes.push(d);
    },
    updatePluginState: (patch: unknown) => {
      stateStore['dev-workflow'] = {
        ...(stateStore['dev-workflow'] as Record<string, unknown> | undefined),
        ...(patch as Record<string, unknown>),
      };
    },
    get pluginState() {
      return stateStore['dev-workflow'];
    },
    getSession: () => session,
    getSessionCount: () => 1,
    pluginSettings: opts.settings ?? WORKFLOW_SETTINGS,
    exec: (command: string, cwd?: string) => {
      execCalls.push({ command, cwd });
      return opts.execImpl
        ? opts.execImpl(command, cwd)
        : Promise.reject(new Error('no exec'));
    },
    waitForSessionOutput: async () => true,
    getCwd: async () => session.cwd ?? null,
    openBrowser: () => {},
    openTab: () => {},
    openSubShell: (command?: string, cwd?: string, label?: string, agent?: string) => {
      const id = `sh-test-${subShells.length + 1}`;
      subShells.push({ id, command, cwd, label, agent });
      return id;
    },
    readFile: async (path: string) => {
      if (path in files) return files[path];
      throw new Error(`not found: ${path}`);
    },
    writeFile: async (path: string, contents: string) => {
      files[path] = contents;
    },
    statPath: async (path: string) => opts.statImpl?.(path) ?? null,
    mkdir: async () => true,
    repoMenuItems: () => [],
    isProgressHandled: () => false,
    getScreenLines: () => [],
    openSession: (cwd?: string, name?: string, workspaceId?: string) => {
      opened.push({ cwd, name, workspaceId });
    },
    getWorkspace: () => undefined,
    runCommand: opts.commandImpl
      ? (line: string) => {
          commandCalls.push(line);
          return opts.commandImpl!(line);
        }
      : undefined,
    setAttention: (a: unknown) => {
      attention.push(a);
    },
    setBanner: (b: unknown | null) => {
      banners.push(b);
      stateStore['dev-workflow'] = {
        ...(stateStore['dev-workflow'] as Record<string, unknown> | undefined),
        banner: b,
      };
    },
    setRestoring: () => {},
    get appState() {
      return appStore;
    },
    updateAppState: (patch: Record<string, unknown>) => {
      Object.assign(appStore, patch);
    },
  } as unknown as Ctx;
  return { ctx, stateStore, appStore, writes, files, execCalls, commandCalls, subShells, opened, attention, banners };
}

describe('parseWorkflows', () => {
  it('parses workflows, camelizes nested keys, infers format', () => {
    const defs = parseWorkflows(WORKFLOW_SETTINGS);
    expect(defs).toHaveLength(3);
    const speckit = defs[0];
    expect(speckit.id).toBe('speckit');
    expect(speckit.title).toBe('Speckit');
    expect(speckit.trackingFile).toBe('.axn/workflow.yaml');
    expect(speckit.trackingFormat).toBe('yaml');
    expect(speckit.start).toBe('plan');
    expect(speckit.steps.implement[0].runIn).toBe('headless');
  });

  it('parses named actions per state, keeps kebab-case names, honors string sugar', () => {
    const multi = parseWorkflows(WORKFLOW_SETTINGS).find((d) => d.id === 'multi')!;
    expect(multi.steps.build).toHaveLength(2);
    expect(multi.steps.build.map((a) => a.name)).toEqual(['draft', 'spec-lint']);
    expect(multi.steps.build[0]).toMatchObject({
      agent: { cli: 'devin' },
      prompt: 'Draft it.',
    });
    expect(multi.steps.build[1]).toMatchObject({
      command: 'sh .ci/lint.sh',
      runIn: 'headless',
    });
    expect(multi.steps.verify).toEqual([{ name: 'dry-check', command: 'make check' }]);
  });

  it('collects step descriptions — flat spec and reserved named-map key', () => {
    const defs = parseWorkflows(WORKFLOW_SETTINGS);
    const speckit = defs.find((d) => d.id === 'speckit')!;
    // flat form: the action's description is the state's description
    expect(speckit.descriptions).toEqual({ plan: 'Draft the implementation plan.' });
    expect(speckit.steps.plan[0].description).toBe('Draft the implementation plan.');
    const multi = defs.find((d) => d.id === 'multi')!;
    // named-map form: `description` is reserved, never an action
    expect(multi.descriptions).toEqual({ build: 'Build the change, then lint the spec.' });
    expect(multi.steps.build.map((a) => a.name)).toEqual(['draft', 'spec-lint']);
    // a named action keeps its own description for the run tooltip
    expect(multi.steps.build[1].description).toBe('Lint the spec files.');
  });

  it('accepts a description-only step as a documented human gate', () => {
    const [def] = parseWorkflows({
      workflows: {
        w: { states: ['a'], steps: { a: { description: 'Review by hand.' } } },
      },
    });
    expect(def.descriptions).toEqual({ a: 'Review by hand.' });
    expect(def.steps.a).toBeUndefined();
  });

  it('keeps the flat step form as a single anonymous action', () => {
    const speckit = parseWorkflows(WORKFLOW_SETTINGS).find((d) => d.id === 'speckit')!;
    expect(speckit.steps.plan).toHaveLength(1);
    expect(speckit.steps.plan[0].name).toBe('default');
    expect(speckit.steps.plan[0].agent?.cli).toBe('devin');
  });

  it('skips workflows without states and non-map values', () => {
    expect(
      parseWorkflows({ workflows: { bad: { title: 'no states' }, worse: 'x' } }),
    ).toHaveLength(0);
    expect(parseWorkflows(undefined)).toHaveLength(0);
    expect(parseWorkflows({ workflows: ['not', 'a', 'map'] })).toHaveLength(0);
  });

  it('defaults start to the first state and format to json for .json files', () => {
    const [def] = parseWorkflows({
      workflows: { w: { states: ['a', 'b'], tracking: { file: 's.json' } } },
    });
    expect(def.start).toBe('a');
    expect(def.trackingFormat).toBe('json');
  });
});

describe('encode/decode state', () => {
  const rec = {
    workflow: 'speckit',
    state: 'plan',
    updated: 1000,
    history: [{ state: 'plan', at: 1000 }],
  };

  it('round-trips json', () => {
    expect(decodeState(encodeState(rec, 'json'))).toEqual(rec);
  });

  it('round-trips yaml', () => {
    expect(decodeState(encodeState(rec, 'yaml'))).toEqual(rec);
  });

  it('decodes yaml regardless of declared format', () => {
    expect(decodeState('workflow: speckit\nstate: qa\n')?.state).toBe('qa');
  });

  it('rejects garbage and missing fields', () => {
    expect(decodeState('{{{ not yaml')).toBeUndefined();
    expect(decodeState(JSON.stringify({ workflow: 'x' }))).toBeUndefined();
    expect(decodeState('[1,2]')).toBeUndefined();
  });
});

describe('agentCommand', () => {
  it('renders devin with -- separator', () => {
    const cmd = agentCommand('devin', { model: 'opus', args: '--permission-mode smart' }, 'hi "x"');
    expect(cmd).toMatch(/^devin --model opus --permission-mode smart -- "\$\(printf %s '.*' \| base64 -d\)"$/);
  });

  it('renders claude with positional prompt', () => {
    expect(agentCommand('claude', {}, 'hi')).toMatch(/^claude "\$\(printf %s '.*' \| base64 -d\)"$/);
  });

  it('omits model/prompt when absent', () => {
    expect(agentCommand('vibe', { args: '--fast' })).toBe('vibe --fast');
  });

  it('shell-quotes unusual model names', () => {
    expect(agentCommand('devin', { model: 'a b' })).toContain("--model 'a b'");
  });
});

function decodePromptArg(line: string): string | undefined {
  const m = line.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/);
  return m ? atob(m[1]) : undefined;
}

const noFs = {
  readFile: (p: string) => Promise.reject(new Error(`ENOENT ${p}`)),
  writeFile: () => Promise.resolve(),
  statPath: () => Promise.resolve(null),
};

describe('agentLaunchLine', () => {
  it('claude: instructions ride --append-system-prompt, prompt stays positional', async () => {
    const line = await agentLaunchLine('claude', { instructions: 'be terse' }, 'hi', noFs, '/r');
    expect(line).toMatch(/^claude --append-system-prompt .* "\$\(printf/);
    const parts = [...line.matchAll(/printf %s '([A-Za-z0-9+/=]+)'/g)].map((m) => atob(m[1]));
    expect(parts).toEqual(['be terse', 'hi']);
  });

  it('claude: instructions-file is handed to claude natively', async () => {
    const line = await agentLaunchLine(
      'claude',
      { instructionsFile: 'docs/AGENT.md' },
      undefined,
      noFs,
      '/r',
    );
    expect(line).toBe('claude --append-system-prompt-file docs/AGENT.md');
  });

  it('codex: instructions become a developer_instructions config override', async () => {
    const line = await agentLaunchLine('codex', { instructions: 'be terse' }, 'hi', noFs, '/r');
    expect(line).toContain('-c ');
    expect(line).toContain('developer_instructions=');
    expect(decodePromptArg(line)).toBe('hi');
  });

  it('devin: instructions fold in ahead of the seed prompt', async () => {
    const line = await agentLaunchLine('devin', { instructions: 'be terse' }, 'do it', noFs, '/r');
    expect(line).toMatch(/^devin -- /);
    expect(decodePromptArg(line)).toBe('be terse\n\ndo it');
  });

  it('unregistered clis fold instructions into the prompt generically', async () => {
    const line = await agentLaunchLine('vibe', { instructions: 'be terse' }, 'do it', noFs, '/r');
    expect(line).toMatch(/^vibe -- /);
    expect(decodePromptArg(line)).toBe('be terse\n\ndo it');
  });
});

describe('renderTemplate', () => {
  it('substitutes known placeholders, leaves unknown ones', () => {
    expect(renderTemplate('run {{state}} {{workflow}} {{nope}}', { state: 'qa', workflow: 'w' })).toBe(
      'run qa w {{nope}}',
    );
  });
});

describe('transitionAllowed', () => {
  const def = parseWorkflows(WORKFLOW_SETTINGS)[0];

  it('rejects undeclared states', () => {
    expect(transitionAllowed(def, 'plan', 'nope')).toBe(false);
  });

  it('enforces declared transitions', () => {
    expect(transitionAllowed(def, 'plan', 'plan-review')).toBe(true);
    expect(transitionAllowed(def, 'plan', 'implement')).toBe(false);
  });

  it('allows any move from a state absent from transitions', () => {
    expect(transitionAllowed(def, 'implement', 'plan')).toBe(true);
  });

  it('moves freely when no transitions are declared', () => {
    const free = parseWorkflows(WORKFLOW_SETTINGS)[1];
    expect(transitionAllowed(free, 'think', 'review')).toBe(true);
  });

  it('preserves kebab-case state names in transitions and steps keys', () => {
    const [def] = parseWorkflows({
      workflows: {
        w: {
          states: ['plan', 'plan-review', 'done'],
          transitions: { 'plan-review': ['done'] },
          steps: { 'plan-review': { command: 'echo hi', 'run-in': 'shell' } },
        },
      },
    });
    expect(transitionAllowed(def, 'plan-review', 'done')).toBe(true);
    expect(transitionAllowed(def, 'plan-review', 'plan')).toBe(false);
    expect(def.steps['plan-review']).toMatchObject([
      { name: 'default', command: 'echo hi', runIn: 'shell' },
    ]);
  });
});

describe('commands', () => {
  const cmd = (name: string) =>
    pluginCommands(devWorkflowPlugin).find((c) => c.name === name)!;

  describe('axn-workflow-start', () => {
    it('errors when no workflows are defined', async () => {
      const h = makeCtx({ settings: {} });
      const out = await cmd('axn-workflow-start').run?.(h.ctx, undefined, 'axn-workflow-start');
      expect(out).toMatch(/echo "axn-workflow-start: no workflows defined/);
    });

    it('requires an arg when several workflows exist', async () => {
      const h = makeCtx();
      const out = await cmd('axn-workflow-start').run?.(h.ctx, undefined, 'axn-workflow-start');
      expect(out).toMatch(/usage — axn-workflow-start <speckit\|offices\|multi>/);
    });

    it('starts the single workflow without an arg — no auto-launch', async () => {
      const settings = {
        workflows: {
          only: { states: ['a'], steps: { a: { agent: { cli: 'devin' } } } },
        },
      };
      const h = makeCtx({ settings });
      const out = await cmd('axn-workflow-start').run?.(h.ctx, undefined, 'axn-workflow-start');
      expect(out).toMatch(/workflow 'only' started — state 'a'/);
      expect(h.writes).toHaveLength(0); // transitions never type into the PTY
      expect((h.stateStore['dev-workflow'] as { state?: string }).state).toBe('a');
      expect(h.banners.at(-1)).toMatchObject({ level: 'info' });
    });

    it('writes the state file relative to the repo toplevel', async () => {
      const h = makeCtx({
        execImpl: async (command) =>
          command.includes('rev-parse') ? '/repo\n' : '',
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'axn-workflow-start speckit');
      const rec = decodeState(h.files['/repo/.axn/workflow.yaml'] ?? '');
      expect(rec?.state).toBe('plan');
      expect(h.appStore.instances).toMatchObject({ s1: { workflow: 'speckit', state: 'plan' } });
    });

    it('stores state in the session pluginState when no tracking.file', async () => {
      const h = makeCtx({
        settings: { workflows: { wf: { states: ['a', 'b'], start: 'a' } } },
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      expect(h.stateStore['dev-workflow']).toMatchObject({
        workflow: 'wf',
        state: 'a',
      });
      expect((h.stateStore['dev-workflow'] as { history?: unknown[] }).history).toHaveLength(1);
      expect(Object.keys(h.files)).toHaveLength(0); // no file written
    });

    it('keeps absolute tracking.file verbatim and infers json from .json', async () => {
      const h = makeCtx({
        settings: {
          workflows: { wf: { tracking: { file: '/tmp/wf.json' }, states: ['a'] } },
        },
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      const rec = decodeState(h.files['/tmp/wf.json'] ?? '');
      expect(rec?.workflow).toBe('wf');
      expect(h.files['/tmp/wf.json']).toContain('"workflow": "wf"'); // json encoding
      // session record mirrors it too
      expect(h.stateStore['dev-workflow']).toMatchObject({ workflow: 'wf', state: 'a' });
    });

    it('exposes the resolved tracking path as {{tracking}} in commands', async () => {
      const h = makeCtx({
        settings: {
          workflows: {
            wf: {
              tracking: { file: 'wf.yaml' },
              states: ['a'],
              steps: { a: { command: 'echo {{tracking}}', 'run-in': 'shell' } },
            },
          },
        },
        execImpl: async (command) => (command.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      // the launch happens via the explicit Run action, not on start
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await new Promise((r) => setTimeout(r, 0));
      // command actions carry the check-result printf trailer
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]).toContain('echo /repo/wf.yaml; rc=$?; printf ');
      expect(h.writes[0]).toContain('axn-workflow-check:');
    });

    it('dispatches axn-* commands via runCommand instead of writing to the PTY', async () => {
      const h = makeCtx({
        settings: {
          workflows: {
            wf: { states: ['a'], steps: { a: { command: 'axn-git' } } },
          },
        },
        execImpl: async (command) => (command.includes('rev-parse') ? '/repo\n' : ''),
        // a swallowed command (handled itself — no shell involvement)
        commandImpl: async () => false,
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await new Promise((r) => setTimeout(r, 0));
      expect(h.commandCalls).toEqual(['axn-git']);
      expect(h.writes).toHaveLength(0);
      expect(
        (h.stateStore['dev-workflow'] as { checks?: Record<string, { status: string }> })
          ?.checks?.['a:default']?.status,
      ).toBe('done');
    });

    it('types a replacement line (with env + trailer) when dispatch returns one', async () => {
      const h = makeCtx({
        settings: {
          workflows: {
            wf: { states: ['a'], steps: { a: { command: 'axn-install --dry' } } },
          },
        },
        execImpl: async (command) => (command.includes('rev-parse') ? '/repo\n' : ''),
        commandImpl: async () => '/usr/local/bin/axn-term install --dry',
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await new Promise((r) => setTimeout(r, 0));
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]).toContain('/usr/local/bin/axn-term install --dry; rc=$?;');
      expect(h.writes[0]).toContain('AXN_ACTION=');
    });
  });

  describe('axn-workflow-move', () => {
    it('requires a bound workflow', async () => {
      const h = makeCtx();
      const out = await cmd('axn-workflow-move').run?.(h.ctx, 'qa', 'axn-workflow-move qa');
      expect(out).toMatch(/no workflow bound/);
    });

    it('validates and moves, then echoes when the step has no shell command', async () => {
      const h = makeCtx({
        execImpl: async (command) => (command.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      const out = await cmd('axn-workflow-move').run?.(h.ctx, 'plan-review', 'x');
      expect(out).toBe('echo "workflow \'speckit\' → plan-review"');
      expect(decodeState(h.files['/repo/.axn/workflow.yaml'] ?? '')?.state).toBe('plan-review');
    });

    it('rejects a disallowed transition', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      const out = await cmd('axn-workflow-move').run?.(h.ctx, 'implement', 'axn-workflow-move implement');
      expect(out).toMatch(/not allowed/);
      expect((h.stateStore['dev-workflow'] as { state?: string }).state).toBe('plan');
    });

    it('fires the entered state\'s auto actions (on-enter)', async () => {
      const h = makeCtx({
        settings: {
          workflows: {
            wf: {
              states: ['a', 'b'],
              steps: { b: { command: 'axn-focus', auto: true } },
            },
          },
        },
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
        commandImpl: async () => false,
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      expect(h.commandCalls).toHaveLength(0); // 'a' has no auto step
      await cmd('axn-workflow-move').run?.(h.ctx, 'b', 'x');
      await new Promise((r) => setTimeout(r, 0));
      expect(h.commandCalls).toEqual(['axn-focus']);
      expect(h.writes).toHaveLength(0);
    });

    it('does not refire auto actions on a rejected transition', async () => {
      const h = makeCtx({
        settings: {
          workflows: {
            wf: {
              states: ['a', 'b'],
              transitions: { a: [] },
              steps: { b: { command: 'axn-focus', auto: true } },
            },
          },
        },
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
        commandImpl: async () => false,
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      const out = await cmd('axn-workflow-move').run?.(h.ctx, 'b', 'x');
      expect(out).toMatch(/not allowed/);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.commandCalls).toHaveLength(0);
    });
  });

  describe('completion', () => {
    it('completes workflow names for axn-workflow-start', () => {
      const h = makeCtx();
      const c = cmd('axn-workflow-start');
      expect(c.completeArg?.(h.ctx, 's')).toEqual(['speckit']);
      expect(c.completeArg?.(h.ctx, '')).toEqual(['speckit', 'offices', 'multi']);
    });

    it('completes bound workflow states for axn-workflow-move', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'offices', 'x');
      expect(cmd('axn-workflow-move').completeArg?.(h.ctx, 'r')).toEqual(['review']);
    });
  });

  describe('sessionMenuItems', () => {
    it('offers a start row per workflow when unbound', () => {
      const h = makeCtx();
      const labels = (devWorkflowPlugin.sessionMenuItems?.(h.ctx) ?? []).map((i) => i.label);
      expect(labels).toEqual(['Start workflow: Speckit', 'Start workflow: offices', 'Start workflow: multi']);
    });

    it('offers a run row per action of the current state', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      const labels = (devWorkflowPlugin.sessionMenuItems?.(h.ctx) ?? []).map((i) => i.label);
      expect(labels).toEqual([
        'Run draft',
        'Run spec-lint',
        'Workflow multi → verify',
        'Stop workflow',
      ]);
    });

    it('offers move rows and stop when bound', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'offices', 'x');
      const labels = (devWorkflowPlugin.sessionMenuItems?.(h.ctx) ?? []).map((i) => i.label);
      expect(labels).toEqual([
        'Workflow offices → do',
        'Workflow offices → review',
        'Stop workflow',
      ]);
    });
  });

  describe('axn-workflow / axn-workflow-stop', () => {
    it('reports status and clears the binding', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'offices', 'x');
      expect(await cmd('axn-workflow').run?.(h.ctx, undefined, 'axn-workflow')).toBe(
        'echo "offices: think"',
      );
      expect(await cmd('axn-workflow-stop').run?.(h.ctx, undefined, 'axn-workflow-stop')).toBe(
        'echo "workflow \'offices\' stopped"',
      );
      expect((h.stateStore['dev-workflow'] as { workflow?: string }).workflow).toBeUndefined();
      expect(h.appStore.instances).toEqual({});
    });
  });

  describe('lifecycle', () => {
    it('removes the kanban instance when the session closes', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      expect(h.appStore.instances).toMatchObject({ s1: { workflow: 'speckit' } });
      devWorkflowPlugin.onClose?.(h.ctx);
      expect(h.appStore.instances).toEqual({});
    });
  });

  describe('steps', () => {
    it('run-in: headless dispatches via ctx.exec and echoes', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      const out = await cmd('axn-workflow-move').run?.(h.ctx, 'plan-review', 'x');
      // plan-review has no step → plain echo
      expect(out).toMatch(/→ plan-review/);
    });
  });

  describe('axn-workflow-state output marker', () => {
    // NOTE: the marker's per-session tail buffer is module state — each test
    // uses a distinct session id so a partial-line leftover can't leak over.
    it('adopts a declared state from a whole-line marker', async () => {
      const h = makeCtx({
        session: makeSession({ id: 's-m1' }),
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'agent work…\naxn-workflow-state: implement\nmore');
      expect(h.stateStore['dev-workflow']).toMatchObject({
        workflow: 'speckit',
        state: 'implement',
      });
    });

    it('mirrors the adopted state to tracking.file when configured', async () => {
      const h = makeCtx({
        session: makeSession({ id: 's-m2' }),
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-state: implement\n');
      await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget writeRecord land
      expect(decodeState(h.files['/repo/.axn/workflow.yaml'] ?? '')?.state).toBe('implement');
    });

    it('ignores prose mentions, undeclared states, and the current state', async () => {
      const h = makeCtx({
        session: makeSession({ id: 's-m3' }),
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'now I emit axn-workflow-state: implement\n');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-state: nope\n');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-state: plan\n'); // already there
      expect(h.stateStore['dev-workflow']).toMatchObject({ state: 'plan' });
    });

    it('assembles a marker split across output chunks', async () => {
      const h = makeCtx({
        session: makeSession({ id: 's-m4' }),
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-st');
      devWorkflowPlugin.onOutput?.(h.ctx, 'ate: implement\n');
      expect(h.stateStore['dev-workflow']).toMatchObject({ state: 'implement' });
    });
  });

  describe('banner', () => {
    interface BannerShape {
      dismissible?: boolean;
      detail?: string;
      actions?: { id: string; disabled?: boolean }[];
      trailingActions?: { id: string; label?: string }[];
    }
    const lastBanner = (h: Harness) => h.banners.at(-1) as BannerShape;

    it('renders both chevrons leading, prev disabled at the start state, run trailing', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      const banner = lastBanner(h);
      expect(banner.dismissible).toBe(false);
      expect(banner.actions?.map((a) => a.id)).toEqual(['prev', 'next']);
      expect(banner.actions?.[0].disabled).toBe(true); // 'plan' is the first state
      expect(banner.actions?.[1].disabled).toBe(false); // plan → plan-review allowed
      expect(banner.trailingActions?.[0]).toMatchObject({ id: 'run:default', label: 'Run devin' });
    });

    it('shows the state description as the banner detail', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      expect(lastBanner(h).detail).toBe('Draft the implementation plan.');
      // states without a description leave the detail unset
      await cmd('axn-workflow-move').run?.(h.ctx, 'plan-review', 'x');
      expect(lastBanner(h).detail).toBeUndefined();
    });

    it('disables next at the last state and omits run without a step', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'offices', 'x'); // think
      await cmd('axn-workflow-move').run?.(h.ctx, 'review', 'x'); // last state
      const banner = lastBanner(h);
      expect(banner.actions?.map((a) => a.id)).toEqual(['prev', 'next']);
      expect(banner.actions?.[0].disabled).toBe(false);
      expect(banner.actions?.[1].disabled).toBe(true);
      expect(banner.trailingActions).toBeUndefined();
    });

    it('onBannerAction next moves the workflow', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'next');
      await vi.waitFor(() =>
        expect((h.stateStore['dev-workflow'] as { state?: string }).state).toBe('plan-review'),
      );
    });

    it('onBannerAction prev at the first state is a no-op', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'prev');
      await Promise.resolve();
      expect((h.stateStore['dev-workflow'] as { state?: string }).state).toBe('plan');
    });

    it('onBannerAction run launches the current step', async () => {
      const h = makeCtx({
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      // offices 'do' has no step in WORKFLOW_SETTINGS — use speckit's
      // implement (run-in: headless → dispatches via ctx.exec).
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      await cmd('axn-workflow-move').run?.(h.ctx, 'plan-review', 'x');
      await cmd('axn-workflow-move').run?.(h.ctx, 'implement', 'x');
      const baseline = h.execCalls.length;
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await vi.waitFor(() => expect(h.execCalls.length).toBeGreaterThan(baseline));
      expect(h.execCalls.at(-1)?.command).toBe(
        'AXN_WORKFLOW=speckit AXN_STATE=implement AXN_ACTION=default sh .ci/run.sh implement',
      );
    });

    it('disables run with a reason while a foreign process owns the terminal', async () => {
      const h = makeCtx({
        session: makeSession({ process: 'claude' }),
        execImpl: async (c) => (c.includes('rev-parse') ? '/repo\n' : ''),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      const run = lastBanner(h).trailingActions?.[0] as
        | { disabled?: boolean; title?: string }
        | undefined;
      expect(run?.disabled).toBe(true);
      expect(run?.title).toContain('claude');
    });
  });

  describe('run eligibility', () => {
    const shellAction: WorkflowAction = {
      name: 'default',
      agent: { cli: 'devin' },
      prompt: 'Do it.',
    };

    it('launches at a free prompt', () => {
      expect(actionRunInfo(shellAction, undefined, 'plan').kind).toBe('launch');
    });

    it('leads the run tooltip with the step description', () => {
      const info = actionRunInfo(
        { name: 'lint', command: 'make lint', description: 'Lint the spec files.' },
        undefined,
        'build',
      );
      expect(info.tip).toBe("Lint the spec files.\nrun 'lint' in state 'build'");
      expect(actionRunInfo(shellAction, undefined, 'plan').tip).toBe(
        "run 'default' in state 'plan'",
      );
    });

    it('sends the prompt when the action agent already owns the terminal', () => {
      const info = actionRunInfo(shellAction, 'devin', 'plan');
      expect(info).toMatchObject({ kind: 'prompt', label: 'Run devin' });
    });

    it('blocks with a reason while another process runs', () => {
      const info = actionRunInfo(shellAction, 'claude', 'plan');
      expect(info.kind).toBe('blocked');
      expect(info.tip).toContain('claude');
    });

    it('blocks non-agent shell actions while a process runs', () => {
      expect(
        actionRunInfo({ name: 'x', command: 'make' }, 'devin', 'x').kind,
      ).toBe('blocked');
    });

    it('non-shell actions stay launchable with a running process', () => {
      expect(
        actionRunInfo({ name: 'x', command: 'make', runIn: 'headless' }, 'devin', 'x').kind,
      ).toBe('launch');
    });

    it('blocks a running agent when the action has no prompt', () => {
      expect(
        actionRunInfo({ name: 'x', agent: { cli: 'devin' } }, 'devin', 'x').kind,
      ).toBe('blocked');
    });

    it('labels named actions by name, anonymous ones generically', () => {
      expect(
        actionRunInfo({ name: 'dry-check', command: 'make check' }, undefined, 'x').label,
      ).toBe('dry-check');
      expect(
        actionRunInfo({ name: 'default', command: 'make check' }, undefined, 'x').label,
      ).toBe('Run step');
      expect(
        actionRunInfo({ name: 'default', agent: { cli: 'devin' } }, undefined, 'x').label,
      ).toBe('Run devin');
      expect(
        actionRunInfo({ name: 'default', agent: { cli: 'claude', profile: 'analyzer' } }, undefined, 'x').label,
      ).toBe('Run analyzer');
    });
  });

  describe('run prompt injection', () => {
    const gitExec = async (c: string) => (c.includes('rev-parse') ? '/repo\n' : '');

    it('injects the prompt into the running agent via bracketed paste', async () => {
      const h = makeCtx({ session: makeSession({ process: 'devin' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await vi.waitFor(() => expect(h.writes.length).toBeGreaterThan(0));
      expect(h.writes.at(-1)).toBe('\x1b[200~Plan it.\x1b[201~\r');
    });

    it('refuses to type into a foreign process', async () => {
      const h = makeCtx({ session: makeSession({ process: 'vim' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await Promise.resolve();
      await Promise.resolve();
      expect(h.writes).toEqual([]);
    });

    it('types the launch command at a free prompt', async () => {
      const h = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'speckit', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:default');
      await vi.waitFor(() => expect(h.writes.length).toBeGreaterThan(0));
      expect(h.writes.at(-1)).toContain('devin --model opus --');
    });
  });

  describe('check results', () => {
    const gitExec = async (c: string) => (c.includes('rev-parse') ? '/repo\n' : '');
    const checksOf = (h: Harness) =>
      (h.stateStore['dev-workflow'] as BindingState).checks ?? {};

    it('records a failing headless command action with its error', async () => {
      const h = makeCtx({
        execImpl: async (c) =>
          c.includes('rev-parse') ? '/repo\n' : Promise.reject(new Error('lint exploded')),
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:spec-lint');
      await vi.waitFor(() =>
        expect(checksOf(h)['build:spec-lint']?.status).toBe('failed'),
      );
      expect(checksOf(h)['build:spec-lint']?.message).toContain('lint exploded');
    });

    it('records a passing headless command action', async () => {
      const h = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:spec-lint');
      await vi.waitFor(() => expect(checksOf(h)['build:spec-lint']?.status).toBe('ok'));
      expect(checksOf(h)['build:spec-lint']?.rc).toBe(0);
    });

    it('adopts the rc from a whole-line axn-workflow-check marker', async () => {
      const h = makeCtx({ session: makeSession({ id: 's-c1' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-check: spec-lint 2\n');
      expect(checksOf(h)['build:spec-lint']).toMatchObject({ status: 'failed', rc: 2 });
    });

    it('adopts the explicit <state>:<name> marker form', async () => {
      const h = makeCtx({ session: makeSession({ id: 's-c2' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-check: verify:dry-check 0\n');
      // reports for another state are stored under that state, not the current one
      expect(checksOf(h)['verify:dry-check']?.status).toBe('ok');
      expect(checksOf(h)['build:dry-check']).toBeUndefined();
    });

    it('appends the check trailer to shell command lines', async () => {
      const h = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      await cmd('axn-workflow-move').run?.(h.ctx, 'verify', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:dry-check');
      await vi.waitFor(() => expect(h.writes.length).toBeGreaterThan(0));
      expect(h.writes.at(-1)).toBe(
        `AXN_WORKFLOW=multi AXN_STATE=verify AXN_ACTION=dry-check make check; rc=$?; printf '\\naxn-workflow-check: %s:%s %d\\n' verify dry-check "$rc"\r`,
      );
      expect(checksOf(h)['verify:dry-check']?.status).toBe('running');
    });

    it('clears a state\'s checks when it is re-entered', async () => {
      const h = makeCtx({ session: makeSession({ id: 's-c3' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-check: spec-lint 1\n');
      expect(checksOf(h)['build:spec-lint']?.status).toBe('failed');
      await cmd('axn-workflow-move').run?.(h.ctx, 'verify', 'x');
      await cmd('axn-workflow-move').run?.(h.ctx, 'build', 'x');
      expect(checksOf(h)['build:spec-lint']).toBeUndefined();
    });

    it('shellLine leaves agent actions untracked', () => {
      expect(
        shellLine({ name: 'x', agent: { cli: 'devin' } }, 's', 'devin -- hi'),
      ).toBe('devin -- hi');
    });
  });

  describe('axn-workflow-run command + marker', () => {
    const gitExec = async (c: string) => (c.includes('rev-parse') ? '/repo\n' : '');

    it('errors without a binding or with an unknown action', async () => {
      const h = makeCtx();
      expect(await cmd('axn-workflow-run').run?.(h.ctx, 'x', 'x')).toMatch(/no workflow bound/);
      const h2 = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h2.ctx, 'multi', 'x');
      expect(await cmd('axn-workflow-run').run?.(h2.ctx, 'nope', 'x')).toMatch(/usage/);
    });

    it('returns the rendered shell line for a shell command action', async () => {
      const h = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      await cmd('axn-workflow-move').run?.(h.ctx, 'verify', 'x');
      const out = await cmd('axn-workflow-run').run?.(h.ctx, 'dry-check', 'x');
      expect(out).toBe(
        `AXN_WORKFLOW=multi AXN_STATE=verify AXN_ACTION=dry-check make check; rc=$?; printf '\\naxn-workflow-check: %s:%s %d\\n' verify dry-check "$rc"`,
      );
      expect(
        ((h.stateStore['dev-workflow'] as BindingState).checks ?? {})['verify:dry-check']
          ?.status,
      ).toBe('running');
    });

    it('runs a sole action without a name argument', async () => {
      const h = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      await cmd('axn-workflow-move').run?.(h.ctx, 'verify', 'x');
      const out = await cmd('axn-workflow-run').run?.(h.ctx, undefined, 'x');
      expect(out).toContain('make check');
    });

    it('completes action names of the current state', async () => {
      const h = makeCtx({ execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      expect(cmd('axn-workflow-run').completeArg?.(h.ctx, '')).toEqual([
        'draft',
        'spec-lint',
      ]);
      expect(cmd('axn-workflow-run').completeArg?.(h.ctx, 'd')).toEqual(['draft']);
    });

    it('fires a named action on a whole-line axn-workflow-run marker', async () => {
      const h = makeCtx({ session: makeSession({ id: 's-r1' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      const baseline = h.execCalls.length;
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-run: spec-lint\n');
      await vi.waitFor(() => expect(h.execCalls.length).toBeGreaterThan(baseline));
      expect(h.execCalls.at(-1)?.command).toBe(
        'AXN_WORKFLOW=multi AXN_STATE=build AXN_ACTION=spec-lint sh .ci/lint.sh',
      );
    });

    it('ignores a marker naming an unknown action', async () => {
      const h = makeCtx({ session: makeSession({ id: 's-r2' }), execImpl: gitExec });
      await cmd('axn-workflow-start').run?.(h.ctx, 'multi', 'x');
      const baseline = h.execCalls.length;
      devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-run: nope\n');
      await new Promise((r) => setTimeout(r, 0));
      expect(h.execCalls.length).toBe(baseline);
    });
  });

  describe('sub-shell checks', () => {
    const gitExec = async (c: string) => (c.includes('rev-parse') ? '/repo\n' : '');
    const settings = {
      workflows: {
        wf: {
          states: ['a'],
          steps: { a: { 'dry-check': { command: 'make check', 'run-in': 'sub-shell' } } },
        },
      },
    };
    const checksOf = (h: Harness) =>
      (h.stateStore['dev-workflow'] as BindingState).checks ?? {};

    it('runs the command one-shot so the tab exit code is the check result', async () => {
      const h = makeCtx({ execImpl: gitExec, settings });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:dry-check');
      await vi.waitFor(() => expect(h.subShells.length).toBe(1));
      // no `exec $SHELL -l` continuation — the PTY exits with the check's rc
      expect(h.subShells[0].command).toBe(
        'AXN_WORKFLOW=wf AXN_STATE=a AXN_ACTION=dry-check make check',
      );
      expect(checksOf(h)['a:dry-check']?.status).toBe('running');
      devWorkflowPlugin.onSubShellExit?.(h.ctx, h.subShells[0].id, 3);
      expect(checksOf(h)['a:dry-check']).toMatchObject({ status: 'failed', rc: 3 });
      devWorkflowPlugin.onSubShellExit?.(h.ctx, h.subShells[0].id, 0);
      expect(checksOf(h)['a:dry-check']?.status).toBe('ok');
    });

    it('ignores exits of tabs it did not open', async () => {
      const h = makeCtx({ execImpl: gitExec, settings });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onSubShellExit?.(h.ctx, 'sh-unrelated', 1);
      expect(Object.keys(checksOf(h))).toHaveLength(0);
    });

    it('records done when the backend reports no exit code', async () => {
      const h = makeCtx({ execImpl: gitExec, settings });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:dry-check');
      await vi.waitFor(() => expect(h.subShells.length).toBe(1));
      devWorkflowPlugin.onSubShellExit?.(h.ctx, h.subShells[0].id, null);
      expect(checksOf(h)['a:dry-check']?.status).toBe('done');
    });

    it('marks agent tabs with the persona-resolved cli so re-spawns resume', async () => {
      registerPersonas(
        parsePersonas({ personas: { rev: { cli: 'claude', model: 'sonnet' } } }),
      );
      const h = makeCtx({
        execImpl: gitExec,
        settings: {
          workflows: {
            wf: {
              states: ['a'],
              steps: { a: { 'agent-step': { agent: 'rev', 'run-in': 'sub-shell' } } },
            },
          },
        },
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:agent-step');
      await vi.waitFor(() => expect(h.subShells.length).toBe(1));
      expect(h.subShells[0].agent).toBe('claude');
      // the seed keeps the shell after the agent exits
      expect(h.subShells[0].command).toContain('exec "${SHELL:-sh}" -l');
    });

    it('marks inline gemini/codex agent steps too; unknown clis stay unmarked', async () => {
      const h = makeCtx({
        execImpl: gitExec,
        settings: {
          workflows: {
            wf: {
              states: ['a', 'b', 'c'],
              steps: {
                a: { g: { agent: { cli: 'gemini' }, 'run-in': 'sub-shell' } },
                b: { c: { agent: { cli: 'codex' }, 'run-in': 'sub-shell' } },
                c: { v: { agent: { cli: 'vibe' }, 'run-in': 'sub-shell' } },
              },
            },
          },
        },
      });
      await cmd('axn-workflow-start').run?.(h.ctx, 'wf', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:g');
      await vi.waitFor(() => expect(h.subShells.length).toBe(1));
      expect(h.subShells[0].agent).toBe('gemini');
      await cmd('axn-workflow-move').run?.(h.ctx, 'b', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:c');
      await vi.waitFor(() => expect(h.subShells.length).toBe(2));
      expect(h.subShells[1].agent).toBe('codex');
      await cmd('axn-workflow-move').run?.(h.ctx, 'c', 'x');
      devWorkflowPlugin.onBannerAction?.(h.ctx, 'run:v');
      await vi.waitFor(() => expect(h.subShells.length).toBe(3));
      expect(h.subShells[2].agent).toBeUndefined();
    });
  });
});

describe('workflow vars', () => {
  const cmd = (name: string) => devWorkflowPlugin.commands?.find(
    (c) => typeof c === 'object' && c.name === name,
  ) as { run: (ctx: Ctx, arg?: string, line?: string) => unknown } | undefined;

  it('parses vars map, string shorthand, and list form', () => {
    expect(
      parseWorkflowVars({
        mr: { kind: 'mr', required: true, label: 'Merge request' },
        'out-dir': 'Output directory',
      }),
    ).toEqual([
      { key: 'mr', label: 'Merge request', required: true, kind: 'mr', hint: undefined },
      { key: 'outDir', label: 'Output directory', required: undefined, kind: undefined, hint: undefined },
    ]);
    expect(parseWorkflowVars([{ key: 'mr', kind: 'mr' }])).toEqual([
      { key: 'mr', label: undefined, hint: undefined, required: undefined, kind: 'mr' },
    ]);
    expect(parseWorkflowVars('nope')).toEqual([]);
    expect(
      parseWorkflows({
        workflows: {
          w: { states: ['a'], vars: { mr: { kind: 'mr' } } },
        },
      })[0].vars?.[0],
    ).toMatchObject({ key: 'mr', kind: 'mr' });
  });

  it('parses GitLab, GitHub and bare MR refs', () => {
    expect(
      parseMrRef('https://gitlab.com/group/proj/-/merge_requests/114'),
    ).toMatchObject({
      iid: '114',
      project: 'group/proj',
      host: 'gitlab.com',
      fetchRef: 'merge-requests/114/head',
    });
    expect(parseMrRef('https://github.com/acme/ui/pull/45')).toMatchObject({
      iid: '45',
      project: 'acme/ui',
      fetchRef: 'pull/45/head',
    });
    expect(parseMrRef('!12')).toMatchObject({ iid: '12' });
    expect(parseMrRef('group/proj!77')).toMatchObject({ iid: '77', project: 'group/proj' });
    expect(parseMrRef('not an mr')).toBeUndefined();
  });

  it('expands kind:mr vars into <key>_* companions', () => {
    const def = parseWorkflows({
      workflows: { w: { states: ['a'], vars: { mr: { kind: 'mr' } } } },
    })[0];
    expect(
      expandVars(def, { mr: 'https://gitlab.com/g/p/-/merge_requests/5' }, { branch: 'wt/x' }),
    ).toEqual({
      mr: 'https://gitlab.com/g/p/-/merge_requests/5',
      mr_iid: '5',
      mr_url: 'https://gitlab.com/g/p/-/merge_requests/5',
      mr_project: 'g/p',
      mr_host: 'gitlab.com',
      branch: 'wt/x',
    });
    // non-mr values stay verbatim, undeclared keys pass through
    expect(expandVars(def, { mr: 'plain', stray: 'v' })).toEqual({ mr: 'plain', stray: 'v' });
  });

  it('derives SNAKE env names and shell-quotes values', () => {
    expect(envName('mrUrl')).toBe('MR_URL');
    expect(envName('mr-url')).toBe('MR_URL');
    expect(envName('mr_iid')).toBe('MR_IID');
    expect(envPrefix({ mr: 'a b', n: '1' })).toBe("MR='a b' N=1 ");
  });

  it('tokenizes quoted args', () => {
    expect(shellTokens(`a "b c" 'd e' k=v`)).toEqual(['a', 'b c', 'd e', 'k=v']);
  });

  it('fills positional args into declared vars, k=v by name', () => {
    const def = parseWorkflows({
      workflows: {
        w: { states: ['a'], vars: { mr: {}, extra: {} } },
      },
    })[0];
    expect(parseStartVars(def, 'https://x/-/merge_requests/1')).toEqual({
      vars: { mr: 'https://x/-/merge_requests/1' },
    });
    expect(parseStartVars(def, 'u extra=v')).toEqual({ vars: { mr: 'u', extra: 'v' } });
    expect(parseStartVars(def, 'a b c').error).toMatch(/unexpected argument/);
  });

  it('collapses MR/PR urls to chips, leaves plain text alone', () => {
    expect(varChipFor('https://gitlab.com/g/p/-/merge_requests/9')).toMatchObject({
      label: '!9',
      href: 'https://gitlab.com/g/p/-/merge_requests/9',
    });
    expect(varChipFor('https://github.com/a/b/pull/9')).toMatchObject({ label: '#9' });
    expect(varChipFor('!9')).toMatchObject({ label: '!9', href: undefined });
    expect(varChipFor('https://example.com/some/path')).toMatchObject({
      label: 'example.com/some/path',
    });
    expect(varChipFor('plain value')).toBeUndefined();
  });
});

describe('workflow vars — start args, set command, marker, env', () => {
  const cmd = (name: string) => devWorkflowPlugin.commands?.find(
    (c) => typeof c === 'object' && c.name === name,
  ) as { run: (ctx: Ctx, arg?: string, line?: string) => unknown; completeArg?: (ctx: Ctx, p?: string) => string[] } | undefined;
  const gitExec = async (c: string) => (c.includes('rev-parse') ? '/repo\n' : '');
  const MR_SETTINGS = {
    workflows: {
      'mr-review': {
        title: 'MR review',
        states: ['fetch', 'review', 'done'],
        vars: { mr: { kind: 'mr', required: true } },
        steps: {
          fetch: { command: 'echo fetching {{mr_iid}} {{mr_title}}' },
          review: { agent: { cli: 'claude' }, prompt: 'Review {{mr}}' },
        },
      },
    },
  };
  const varsOf = (h: Harness) =>
    ((h.stateStore['dev-workflow'] as BindingState | undefined)?.vars ?? {});

  it('axn-workflow-start takes a positional var and derives companions', async () => {
    const h = makeCtx({ execImpl: gitExec, settings: MR_SETTINGS });
    const url = 'https://gitlab.com/g/p/-/merge_requests/114';
    const out = await cmd('axn-workflow-start')?.run(h.ctx, `mr-review ${url}`, 'x');
    expect(String(out)).toContain("started — state 'fetch'");
    expect(varsOf(h)).toMatchObject({
      mr: url,
      mr_iid: '114',
      mr_project: 'g/p',
      mr_url: url,
    });
  });

  it('refuses to start when a required var is missing', async () => {
    const h = makeCtx({ execImpl: gitExec, settings: MR_SETTINGS });
    const out = await cmd('axn-workflow-start')?.run(h.ctx, 'mr-review', 'x');
    expect(String(out)).toContain("requires <mr>");
    expect(varsOf(h)).toEqual({});
    expect((h.stateStore['dev-workflow'] as BindingState | undefined)?.state).toBeUndefined();
  });

  it('substitutes vars into commands and exports them to the env', async () => {
    const h = makeCtx({ execImpl: gitExec, settings: MR_SETTINGS });
    const url = 'https://gitlab.com/g/p/-/merge_requests/114';
    await cmd('axn-workflow-start')?.run(h.ctx, `mr-review ${url} mr_title=Worktrees`, 'x');
    const out = await cmd('axn-workflow-run')?.run(h.ctx, undefined, 'x');
    const line = String(out);
    expect(line).toContain('MR=https://gitlab.com/g/p/-/merge_requests/114');
    expect(line).toContain('MR_IID=114');
    expect(line).toContain('MR_TITLE=Worktrees');
    expect(line).toContain('AXN_WORKFLOW=mr-review AXN_STATE=fetch AXN_ACTION=default');
    expect(line).toContain('echo fetching 114 Worktrees');
  });

  it('axn-workflow-set updates a var (with derivation) and the card mirror', async () => {
    const h = makeCtx({ execImpl: gitExec, settings: MR_SETTINGS });
    const url = 'https://gitlab.com/g/p/-/merge_requests/7';
    await cmd('axn-workflow-start')?.run(h.ctx, `mr-review ${url}`, 'x');
    const url2 = 'https://gitlab.com/g/q/-/merge_requests/9';
    const out = await cmd('axn-workflow-set')?.run(h.ctx, `mr ${url2}`, 'x');
    expect(String(out)).toContain('mr set');
    expect(varsOf(h)).toMatchObject({ mr: url2, mr_iid: '9', mr_project: 'g/q' });
    const inst = (h.appStore['instances'] as Record<string, { vars?: Record<string, string> }>)['s1'];
    expect(inst?.vars?.mr_iid).toBe('9');
  });

  it('the axn-workflow-var marker writes vars from output', async () => {
    const h = makeCtx({ execImpl: gitExec, settings: MR_SETTINGS });
    const url = 'https://gitlab.com/g/p/-/merge_requests/7';
    await cmd('axn-workflow-start')?.run(h.ctx, `mr-review ${url}`, 'x');
    devWorkflowPlugin.onOutput?.(h.ctx, 'axn-workflow-var: verdict approved\n');
    expect(varsOf(h).verdict).toBe('approved');
  });

  it('built-in AXN_* env vars survive a same-named user var', async () => {
    const h = makeCtx({ execImpl: gitExec, settings: MR_SETTINGS });
    const url = 'https://gitlab.com/g/p/-/merge_requests/7';
    await cmd('axn-workflow-start')?.run(h.ctx, `mr-review ${url} axn_state=spoof`, 'x');
    const out = await cmd('axn-workflow-run')?.run(h.ctx, undefined, 'x');
    expect(String(out)).toContain('AXN_STATE=fetch');
    expect(String(out)).not.toContain('AXN_STATE=spoof');
  });
});

describe('startMrReview', () => {
  const MR = {
    key: 'g/p!114',
    iid: 114,
    reference: '!114',
    title: 'opt-in worktree sessions',
    url: 'https://gitlab.com/g/p/-/merge_requests/114',
    project: 'g/p',
    sourceBranch: 'feat/agent-worktrees',
    targetBranch: 'develop',
    draft: false,
    conflicts: false,
    mergeStatus: 'mergeable',
    pipeline: null,
    approved: false,
    approvedBy: [],
    author: 'me',
    assignees: [],
    reviewers: [],
    updatedAt: 'x',
    discussions: [],
  };
  const settings = {
    workflows: {
      'mr-review': {
        states: ['fetch', 'review'],
        vars: { mr: { kind: 'mr', required: true } },
        steps: { fetch: { command: 'echo {{mr_iid}}' } },
      },
    },
  };
  const repoSession = () =>
    makeSession({
      id: 'repo-1',
      repo: {
        name: 'p',
        branch: 'develop',
        ahead: 0,
        behind: 0,
        dirty: false,
        untracked: 0,
        remoteBranchMissing: false,
        root: '/repo',
        remote: 'git@gitlab.com:g/p.git',
      },
    });
  const envFor = (h: Harness): MrRowEnv => ({
    sessions: [h.ctx.session],
    apiFor: (id) => (id === h.ctx.session.id ? h.ctx : undefined),
    selectSession: () => {},
  });
  const def = () =>
    parseWorkflows(settings).find((d) => d.id === 'mr-review')!;

  it('fetches the MR head, creates a worktree, opens a bound session', async () => {
    const h = makeCtx({ session: repoSession(), settings, execImpl: async () => '' });
    await startMrReview(MR, def(), envFor(h));

    const calls = h.execCalls.map((c) => c.command);
    expect(calls.some((c) => c.includes("fetch origin 'merge-requests/114/head'"))).toBe(true);
    expect(calls.at(-1)).toContain(
      "worktree add '/worktrees/repo-mr-114' -B 'wt/mr-114' FETCH_HEAD",
    );
    expect(h.opened).toEqual([{ cwd: '/worktrees/repo-mr-114', name: '!114 opt-in worktree sessions' }]);

    // the session that opens in the worktree picks up the staged binding
    const h2 = makeCtx({
      session: makeSession({ id: 's-wt', cwd: '/worktrees/repo-mr-114' }),
      settings,
      execImpl: async () => '',
    });
    devWorkflowPlugin.onSessionOpen?.(h2.ctx);
    await vi.waitFor(() =>
      expect(
        (h2.stateStore['dev-workflow'] as BindingState).state,
      ).toBe('fetch'),
    );
    expect((h2.stateStore['dev-workflow'] as BindingState).vars).toMatchObject({
      mr: MR.url,
      mr_iid: '114',
      mr_project: 'g/p',
      mr_title: MR.title,
      mr_branch: 'feat/agent-worktrees',
      mr_target: 'develop',
      worktree: '/worktrees/repo-mr-114',
      branch: 'wt/mr-114',
    });
  });

  it('uses pull/N/head for GitHub urls', async () => {
    const h = makeCtx({ session: repoSession(), settings, execImpl: async () => '' });
    const gh = { ...MR, url: 'https://github.com/g/p/pull/114', reference: '#114' };
    await startMrReview(gh, def(), envFor(h));
    expect(
      h.execCalls.some((c) => c.command.includes("fetch origin 'pull/114/head'")),
    ).toBe(true);
  });

  it('reuses an existing review worktree and fast-forwards it', async () => {
    const h = makeCtx({
      session: repoSession(),
      settings,
      execImpl: async () => '',
      statImpl: async () => ({ isDir: true }),
    });
    const err = await startMrReview(MR, def(), envFor(h));

    expect(err).toBeUndefined();
    const calls = h.execCalls.map((c) => c.command);
    // No `worktree add` — the existing tree is re-checked and ff'd instead.
    expect(calls.some((c) => c.includes('worktree add'))).toBe(false);
    expect(calls.some((c) => c.includes('rev-parse --is-inside-work-tree'))).toBe(true);
    expect(calls.some((c) => c.includes('merge --ff-only FETCH_HEAD'))).toBe(true);
    expect(h.opened).toEqual([
      { cwd: '/worktrees/repo-mr-114', name: '!114 opt-in worktree sessions' },
    ]);
  });

  it('targets the workspace hosting the MR repo, else the picked one', async () => {
    const h = makeCtx({ session: repoSession(), settings, execImpl: async () => '' });
    const ws = [
      { id: 'ws-a', name: 'other' },
      { id: 'ws-b', name: 'p repo' },
    ];
    // workspace ws-b hosts the repo session → review session opens there
    const env: MrRowEnv = {
      ...envFor(h),
      sessions: [{ ...h.ctx.session, workspaceId: 'ws-b' }],
      workspaces: ws,
    };
    expect(mrWorkspace(env, MR)?.id).toBe('ws-b');
    await startMrReview(MR, def(), env, 'ws-b');
    expect(h.opened.at(-1)).toMatchObject({ workspaceId: 'ws-b' });

    // no matching workspace → undefined (the UI then shows the picker)
    const none: MrRowEnv = {
      sessions: [{ ...h.ctx.session, workspaceId: 'ws-x', repo: undefined }],
      workspaces: ws,
      apiFor: () => h.ctx,
      selectSession: () => {},
    };
    expect(mrWorkspace(none, MR)).toBeUndefined();
  });

  it('flags attention instead of touching a session when no repo matches', async () => {
    const sess = makeSession({ id: 'other' });
    const h = makeCtx({ session: sess, settings });
    const other = makeCtx({ session: makeSession({ id: 'other-2' }), settings });
    const env: MrRowEnv = {
      sessions: [sess, other.ctx.session],
      apiFor: (id) => (id === 'other' ? h.ctx : id === 'other-2' ? other.ctx : undefined),
      selectSession: () => {},
    };
    await startMrReview(MR, def(), env);
    // no session has repo.root → falls back flag on the first available api
    expect(h.opened).toHaveLength(0);
    expect(h.execCalls).toHaveLength(0);
    expect(h.attention.length + other.attention.length).toBe(1);
  });

  it('surfaces a failed fetch/worktree as attention', async () => {
    const h = makeCtx({
      session: repoSession(),
      settings,
      execImpl: async () => {
        throw new Error('fatal: could not fetch ref');
      },
    });
    const err = await startMrReview(MR, def(), envFor(h));
    expect(err).toContain('worktree failed');
    expect(err).toContain('could not fetch ref');
    expect(h.opened).toHaveLength(0);
    expect(h.attention.at(-1)).toMatchObject({ level: 'warning' });
  });

  it('fails when the matched repo session has no api', async () => {
    const h = makeCtx({ session: repoSession(), settings, execImpl: async () => '' });
    const env: MrRowEnv = { ...envFor(h), apiFor: () => undefined };
    const err = await startMrReview(MR, def(), env);
    expect(err).toContain('no session inside');
    expect(h.opened).toHaveLength(0);
    expect(h.execCalls).toHaveLength(0);
  });

  it('fails when the worktree dir exists but is not a git worktree', async () => {
    const h = makeCtx({
      session: repoSession(),
      settings,
      statImpl: async () => ({ isDir: true }),
      execImpl: async (command) => {
        if (command.includes('rev-parse --is-inside-work-tree')) {
          throw new Error('fatal: not a git repository');
        }
        return '';
      },
    });
    const err = await startMrReview(MR, def(), envFor(h));
    expect(err).toContain('exists but is not a git worktree');
    expect(h.opened).toHaveLength(0);
  });

  it('fails when worktree add errors (e.g. missing parent dir)', async () => {
    const h = makeCtx({
      session: repoSession(),
      settings,
      execImpl: async (command) => {
        if (command.includes('worktree add')) {
          throw new Error('fatal: could not create directory');
        }
        return '';
      },
    });
    const err = await startMrReview(MR, def(), envFor(h));
    expect(err).toContain('worktree failed');
    expect(h.opened).toHaveLength(0);
    expect(h.attention.at(-1)).toMatchObject({ level: 'warning' });
  });

  it('mrWorkspace also matches a repo workspace via defaultFolder', () => {
    const env: MrRowEnv = {
      sessions: [],
      workspaces: [
        { id: 'ws-a', name: 'other', defaultFolder: '/home/me/elsewhere' },
        { id: 'ws-b', name: 'dev', defaultFolder: '/home/me/dev/p' },
      ],
      apiFor: () => undefined,
      selectSession: () => {},
    };
    // no session carries the repo, yet ws-b is scoped to it
    expect(mrWorkspace(env, MR)?.id).toBe('ws-b');
    expect(mrReviewLaunch(env, MR)).toEqual({ kind: 'launch', workspaceId: 'ws-b' });
  });

  it('mrReviewLaunch picks a workspace only when none matches', () => {
    const env: MrRowEnv = {
      sessions: [],
      workspaces: [{ id: 'ws-a', name: 'a' }],
      apiFor: () => undefined,
      selectSession: () => {},
    };
    expect(mrReviewLaunch(env, MR)).toEqual({ kind: 'pick' });
    expect(mrReviewLaunch({ ...env, workspaces: [] }, MR)).toEqual({
      kind: 'launch',
      workspaceId: undefined,
    });
    expect(mrReviewLaunch({ ...env, workspaces: undefined }, MR)).toEqual({
      kind: 'launch',
      workspaceId: undefined,
    });
  });

  it('flags the new session when the staged workflow vanished', async () => {
    const h = makeCtx({ session: repoSession(), settings, execImpl: async () => '' });
    await startMrReview(MR, def(), envFor(h));
    // 'mr-review' was removed from plugins.yaml between click and spawn —
    // the new session must flag that instead of silently opening bare.
    const h2 = makeCtx({
      session: makeSession({ id: 's-wt', cwd: '/worktrees/repo-mr-114' }),
      settings: { workflows: {} },
    });
    devWorkflowPlugin.onSessionOpen?.(h2.ctx);
    expect(h2.attention.at(-1)).toMatchObject({
      level: 'warning',
      message: expect.stringContaining('mr-review'),
    });
  });
});
