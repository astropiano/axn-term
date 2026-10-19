import { describe, expect, it } from 'vitest';
import { countScenarios, parseAxnDevList } from './axnDev';

const LIST_OUTPUT = `Global scenarios:
  demo-mock                     \x1b[90m○ stopped\x1b[0m — Full-stack mock: API server + hardware emulator
  demo-full                     \x1b[32m● running\x1b[0m — Single-port full stack with Caddy routing
    app                  http://app.localhost:8091
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
      { label: 'app', url: 'http://app.localhost:8091' },
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
