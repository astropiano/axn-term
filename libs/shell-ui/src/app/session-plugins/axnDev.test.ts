import { describe, expect, it } from 'vitest';
import { countScenarios, parseAxnDevList } from './axnDev';

const LIST_OUTPUT = `Global scenarios:
  demo-mock                     \x1b[90m○ stopped\x1b[0m — Full-stack mock: API server + hardware EPD emulator
  demo-full                     \x1b[32m● running\x1b[0m — Single-port full stack with Caddy routing
    store                http://store.localhost:8091
    user-management      http://usermgmt.localhost:8091
  term-dev                 \x1b[90m○ stopped\x1b[0m

Project scenarios:
  axn-term:
    axn-term-online              \x1b[90m○ stopped\x1b[0m — axn-term online — web frontend + gateway
    axn-term-storybook           \x1b[32m● running\x1b[0m — axn-term Storybook: component catalog
      storybook            http://localhost:8098
    axn-term-online              \x1b[90m○ stopped\x1b[0m — axn-term online [worktree: feat/plugin-hook-spec @ worktrees/axn-term-feat-plugin-hook-spec]
  demo-server:
    full                         \x1b[90m○ stopped\x1b[0m — Full integration: PostgreSQL + Keycloak + API in Development mode
    mock                         \x1b[90m○ stopped\x1b[0m — API in Mock mode: in-memory storage,
      mock auth, no external dependencies
    full                         \x1b[90m○ stopped\x1b[0m — Full integration [worktree: feat/device-registry @ worktrees/demo-server-feat-device-registry]`;

describe('parseAxnDevList', () => {
  it('parses global and project sections', () => {
    const sections = parseAxnDevList(LIST_OUTPUT);
    expect(sections.map((s) => `${s.scope}:${s.label}`)).toEqual([
      'global:global',
      'project:axn-term',
      'project:demo-server',
    ]);
    expect(sections[0].scenarios.map((s) => s.name)).toEqual([
      'demo-mock',
      'demo-full',
      'term-dev',
    ]);
    expect(sections[1].scenarios.map((s) => s.name)).toEqual([
      'axn-term-online',
      'axn-term-storybook',
      'axn-term-online',
    ]);
  });

  it('marks running scenarios and collects their endpoints', () => {
    const sections = parseAxnDevList(LIST_OUTPUT);
    const demoFull = sections[0].scenarios[1];
    expect(demoFull.running).toBe(true);
    expect(demoFull.endpoints).toEqual([
      { label: 'store', url: 'http://store.localhost:8091' },
      { label: 'user-management', url: 'http://usermgmt.localhost:8091' },
    ]);
    const storybook = sections[1].scenarios[1];
    expect(storybook.running).toBe(true);
    expect(storybook.endpoints).toEqual([
      { label: 'storybook', url: 'http://localhost:8098' },
    ]);
    expect(sections[0].scenarios[0].running).toBe(false);
    expect(sections[0].scenarios[0].endpoints).toEqual([]);
  });

  it('extracts worktree info and keeps it out of the description', () => {
    const sections = parseAxnDevList(LIST_OUTPUT);
    const wt = sections[1].scenarios[2];
    expect(wt.worktree).toEqual({
      branch: 'feat/plugin-hook-spec',
      path: 'worktrees/axn-term-feat-plugin-hook-spec',
    });
    expect(wt.description).toBe('axn-term online');
  });

  it('carries the repo name on project scenarios and counts totals', () => {
    const sections = parseAxnDevList(LIST_OUTPUT);
    expect(sections[1].scenarios[0].repo).toBe('axn-term');
    expect(sections[0].scenarios[0].repo).toBeUndefined();
    expect(countScenarios(sections)).toEqual({ total: 9, running: 2 });
  });

  it('appends wrapped description continuations', () => {
    const sections = parseAxnDevList(LIST_OUTPUT);
    const mock = sections[2].scenarios[1];
    expect(mock.description).toBe(
      'API in Mock mode: in-memory storage, mock auth, no external dependencies',
    );
  });

  it('handles scenario names at the padding width and missing descriptions', () => {
    const sections = parseAxnDevList(LIST_OUTPUT);
    expect(sections[0].scenarios[2].name).toBe('term-dev');
    expect(sections[0].scenarios[2].description).toBe('');
  });

  it('returns no sections for empty or unrelated output', () => {
    expect(parseAxnDevList('')).toEqual([]);
    expect(parseAxnDevList('No scenarios found. Configure repos in ~/.axn-dev/config.yaml')).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// --json parsing, tag matching, tag tree
// ---------------------------------------------------------------------------

import {
  buildTagTree,
  parseAxnDevListJson,
  scenarioMatches,
  tagMatches,
} from './axnDev';
import type { AxnDevScenario } from './axnDev';

describe('parseAxnDevListJson', () => {
  const sample = JSON.stringify({
    sections: [
      {
        label: 'global',
        scope: 'global',
        scenarios: [
          {
            name: 'app1-mock',
            path: '/repos/integration/scenarios/app1-mock',
            running: true,
            description: 'Full stack',
            tags: ['myapp', 'e2e/mock'],
            endpoints: [{ label: 'devtools', url: 'http://localhost:8091' }],
          },
        ],
      },
      {
        label: 'axn-term',
        scope: 'project',
        scenarios: [
          {
            name: 'dev',
            path: '/wt/axn-term-x/scenarios/dev',
            running: false,
            description: 'Dev stack',
            tags: [],
            worktree: { branch: 'feat/x', path: '/wt/axn-term-x' },
            endpoints: [],
          },
        ],
      },
    ],
  });

  it('parses sections with tags, paths and worktrees', () => {
    const sections = parseAxnDevListJson(sample)!;
    expect(sections).toHaveLength(2);
    expect(sections[0].scope).toBe('global');
    const s = sections[0].scenarios[0];
    expect(s.tags).toEqual(['myapp', 'e2e/mock']);
    expect(s.path).toBe('/repos/integration/scenarios/app1-mock');
    expect(s.endpoints[0].url).toBe('http://localhost:8091');
    const p = sections[1].scenarios[0];
    expect(p.repo).toBe('axn-term');
    expect(p.worktree).toEqual({ branch: 'feat/x', path: '/wt/axn-term-x' });
    expect(p.key).toContain('/wt/axn-term-x');
  });

  it('returns null for non-JSON output (old CLI)', () => {
    expect(parseAxnDevListJson('Global scenarios:\n  foo ● running\n')).toBeNull();
    expect(parseAxnDevListJson('not json at all')).toBeNull();
    expect(parseAxnDevListJson('{"foo": 1}')).toBeNull();
  });
});

describe('tagMatches / scenarioMatches', () => {
  const sc = (over: Partial<AxnDevScenario>): AxnDevScenario => ({
    key: 'k',
    name: 'app1-mock',
    scope: 'global',
    running: false,
    description: 'Full stack',
    tags: [],
    endpoints: [],
    ...over,
  });

  it('matches tag prefix and path segments like axn-dev serve', () => {
    expect(tagMatches('myapp/e2e', 'myapp')).toBe(true);
    expect(tagMatches('myapp', 'myapp')).toBe(true);
    expect(tagMatches('myapp/e2e', 'e2e')).toBe(false); // prefix only, not substring
    expect(tagMatches('myapp', 'myapp/e2e')).toBe(false);
  });

  it('scenarioMatches hits name, description and tags', () => {
    expect(scenarioMatches(sc({ tags: ['myapp/e2e'] }), 'myapp')).toBe(true);
    expect(scenarioMatches(sc({}), 'app1')).toBe(true);
    expect(scenarioMatches(sc({}), 'full stack')).toBe(true);
    expect(scenarioMatches(sc({ tags: ['api'] }), 'web')).toBe(false);
    expect(scenarioMatches(sc({}), '')).toBe(true);
  });
});

describe('buildTagTree', () => {
  const sc = (key: string, tags: string[], running = false): AxnDevScenario => ({
    key,
    name: key,
    scope: 'global',
    running,
    description: '',
    tags,
    endpoints: [],
  });

  it('groups slash-separated tags into folders, untagged first', () => {
    const tree = buildTagTree([
      sc('a', ['myapp/e2e'], true),
      sc('b', ['myapp']),
      sc('c', []),
    ]);
    expect(tree.scenarios.map((s) => s.key)).toEqual(['c']); // untagged at root
    const app = tree.children.find((n) => n.segment === 'myapp')!;
    expect(app.total).toBe(2);
    expect(app.running).toBe(1);
    const e2e = app.children.find((n) => n.segment === 'e2e')!;
    expect(e2e.scenarios.map((s) => s.key)).toEqual(['a']);
    expect(e2e.total).toBe(1);
  });

  it('multi-tagged scenarios appear under each tag', () => {
    const tree = buildTagTree([sc('x', ['a', 'b/c'])]);
    expect(tree.children.map((n) => n.segment)).toEqual(['a', 'b']);
    expect(tree.children[1].children[0].scenarios[0].key).toBe('x');
  });
});
