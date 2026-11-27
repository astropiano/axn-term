import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellSession } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';
import {
  createTargetHost,
  registerTargetHost,
  scanTextTargets,
  textTargetActions,
  type TargetHostDeps,
  type TicketTarget,
} from './textTargets';

const ticket = (key: string, source = 'jira'): TicketTarget => ({ kind: 'ticket', key, source });

function deps(plugins: SessionViewPlugin[], over: Partial<TargetHostDeps> = {}): TargetHostDeps {
  const sessions = [{ id: 's1' }, { id: 's2' }] as ShellSession[];
  return {
    plugins: () => plugins,
    settings: () => ({ jira: { projectKeys: 'AIACC' } }),
    sessions: () => sessions,
    selectedSessionId: () => 's2',
    buildApi: (s, p) => ({ session: s, plugin: p.id }) as never,
    selectSession: vi.fn(),
    ...over,
  };
}

const plugin = (p: Partial<SessionViewPlugin>): SessionViewPlugin =>
  ({ id: 'p', title: 'p', ...p }) as SessionViewPlugin;

describe('createTargetHost', () => {
  it('merges readers leftmost first and drops overlaps (first reader wins a tie)', () => {
    const a = plugin({
      id: 'a',
      textTargets: {
        scan: (text) =>
          [...text.matchAll(/AIACC-\d+/g)].map((m) => ({
            start: m.index!,
            end: m.index! + m[0].length,
            target: ticket(m[0], 'a'),
          })),
      },
    });
    const b = plugin({
      id: 'b',
      textTargets: {
        scan: () => [
          { start: 0, end: 3, target: ticket('X-1', 'b') },
          { start: 4, end: 9, target: ticket('X-2', 'b') },
        ],
      },
    });
    const host = createTargetHost(deps([a, b]));
    const found = host.scan('foo AIACC-1 bar');
    expect(found.map((m) => `${m.target.source}:${m.target.key}`)).toEqual(['b:X-1', 'a:AIACC-1']);
  });

  it('passes each reader its own settings and survives a throwing one', () => {
    const seen: unknown[] = [];
    const broken = plugin({
      id: 'broken',
      textTargets: {
        scan: () => {
          throw new Error('boom');
        },
      },
    });
    const jira = plugin({
      id: 'jira',
      textTargets: {
        scan: (_t, settings) => {
          seen.push(settings);
          return [];
        },
        fromUrl: (url) => (url.endsWith('/1') ? ticket('AIACC-1') : undefined),
      },
    });
    const host = createTargetHost(deps([broken, jira]));
    expect(host.scan('x')).toEqual([]);
    expect(seen).toEqual([{ projectKeys: 'AIACC' }]);
    expect(host.fromUrl('https://j/browse/1')?.key).toBe('AIACC-1');
    expect(host.fromUrl('https://j/browse/2')).toBeUndefined();
  });

  it('collects actions with an api bound to the origin, else the selected session', () => {
    const calls: unknown[] = [];
    const wt = plugin({
      id: 'worktrees',
      targetActions: (target, ctx) => {
        calls.push({ origin: ctx.originSessionId, api: ctx.api(), other: ctx.api('s1') });
        return [{ id: 'start', label: `Start ${target.key}`, run: () => {} }];
      },
    });
    const host = createTargetHost(deps([wt]));
    expect(host.actions(ticket('AIACC-1')).map((a) => a.label)).toEqual(['Start AIACC-1']);
    host.actions(ticket('AIACC-1'), 's1');
    expect(calls).toEqual([
      {
        origin: 's2',
        api: { session: { id: 's2' }, plugin: 'worktrees' },
        other: { session: { id: 's1' }, plugin: 'worktrees' },
      },
      {
        origin: 's1',
        api: { session: { id: 's1' }, plugin: 'worktrees' },
        other: { session: { id: 's1' }, plugin: 'worktrees' },
      },
    ]);
  });

  it('falls back to any session when the origin is gone', () => {
    let api: unknown;
    const wt = plugin({
      targetActions: (_t, ctx) => {
        api = ctx.api();
        return [];
      },
    });
    createTargetHost(deps([wt], { selectedSessionId: () => undefined })).actions(ticket('A-1'));
    expect(api).toEqual({ session: { id: 's1' }, plugin: 'p' });
  });
});

describe('module host', () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());

  it('answers nothing without a host, and the registered host otherwise', () => {
    expect(scanTextTargets('AIACC-1')).toEqual([]);
    expect(textTargetActions(ticket('AIACC-1'))).toEqual([]);
    off = registerTargetHost({
      scan: () => [{ start: 0, end: 7, target: ticket('AIACC-1') }],
      fromUrl: () => undefined,
      actions: () => [{ id: 'x', label: 'X', run: () => {} }],
    });
    expect(scanTextTargets('AIACC-1')).toHaveLength(1);
    expect(textTargetActions(ticket('AIACC-1'))).toHaveLength(1);
    off();
    off = undefined;
    expect(scanTextTargets('AIACC-1')).toEqual([]);
  });
});
