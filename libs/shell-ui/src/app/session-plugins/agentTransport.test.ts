import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { agentHookScript, readHookLog } from '@axn-term/plugin-sdk';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'axn-agent-hook-'));
  roots.push(root);
  const script = join(root, 'agent-hook.sh');
  writeFileSync(script, agentHookScript(), { mode: 0o700 });
  const env = { ...process.env, AXN_TERM_STATE_DIR: root, AXN_TERM_PTY_ID: 'test-session' };
  const run = (agent: string, event: unknown, name?: string) =>
    spawnSync(script, name ? [agent, name] : [agent], { input: JSON.stringify(event, null, 2), encoding: 'utf8', env });
  const log = (agent: string) => join(root, `${agent}-events/pty-test-session.jsonl`);
  const events = (agent: string) =>
    readFileSync(log(agent), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  return { root, script, env, run, log, events };
}

describe('real command-hook transport', () => {
  for (const agent of ['claude', 'codex']) {
    it(`${agent}: appends piped JSON without a controlling TTY, in order`, () => {
      const t = setup();
      const event = { hook_event_name: 'PermissionRequest', tool_name: 'Bash' };
      const result = t.run(agent, event);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      for (const name of ['Notification', 'Stop', 'SessionEnd']) {
        expect(t.run(agent, { hook_event_name: name }, name).status).toBe(0);
      }
      // pretty-printed input still lands as one line per event; SessionEnd is dropped
      expect(t.events(agent)).toEqual([event, { hook_event_name: 'Notification' }, { hook_event_name: 'Stop' }]);
    });
  }

  it('shrinks an oversized payload to the mapped fields', () => {
    const t = setup();
    t.run('claude', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'x'.repeat(20_000) });
    expect(t.events('claude')).toEqual([{ hook_event_name: 'PostToolUse', tool_name: 'Read', axn_truncated: true }]);
  });

  it('keeps concurrent appends whole', async () => {
    const t = setup();
    // 16 × ~3 KB stays under the 64 KB rotation point
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        new Promise<void>((resolve) => {
          const child = spawn(t.script, ['claude'], { env: t.env });
          child.on('close', () => resolve());
          child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', i, pad: 'y'.repeat(3000) }));
        }),
      ),
    );
    const seen = t.events('claude').map((e) => e.i);
    expect(seen.sort((a, b) => Number(a) - Number(b))).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('loses nothing when concurrent hooks cross the rotation point', async () => {
    const t = setup();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        new Promise<void>((resolve) => {
          const child = spawn(t.script, ['claude'], { env: t.env });
          child.on('close', () => resolve());
          child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', i, pad: 'y'.repeat(3000) }));
        }),
      ),
    );
    const all = [readFileSync(`${t.log('claude')}.1`, 'utf8'), readFileSync(t.log('claude'), 'utf8')]
      .join('')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { i: number }).i);
    expect(all.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('rotates past 64 KB and the reader picks up across the rotation', async () => {
    const t = setup();
    const read = async (p: string) => readFileSync(p, 'utf8');
    t.run('claude', { hook_event_name: 'SessionStart' });
    const first = await readHookLog(read, t.log('claude'), undefined);
    expect(first?.lines).toHaveLength(1);
    // ~3 KB lines: 24 of them cross the 64 KB threshold once
    for (let i = 0; i < 24; i++) t.run('claude', { hook_event_name: 'PreToolUse', i, pad: 'z'.repeat(3000) });
    const next = await readHookLog(read, t.log('claude'), first!.cursor);
    const got = next!.lines.map((l) => (JSON.parse(l) as { i?: number }).i);
    expect(got).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });
});

describe('readHookLog', () => {
  const fs = (files: Record<string, string>) => async (p: string) => {
    if (!(p in files)) throw new Error('ENOENT');
    return files[p];
  };

  it('resolves null for a missing log', async () => {
    expect(await readHookLog(fs({}), '/l', undefined)).toBeNull();
  });

  it('returns only complete new lines and holds a partial one', async () => {
    const files = { '/l': 'a\nb\nc' };
    const r1 = await readHookLog(fs(files), '/l', undefined);
    expect(r1!.lines).toEqual(['a', 'b']);
    files['/l'] = 'a\nb\nc\nd\n';
    const r2 = await readHookLog(fs(files), '/l', r1!.cursor);
    expect(r2!.lines).toEqual(['c', 'd']);
    expect((await readHookLog(fs(files), '/l', r2!.cursor))!.lines).toEqual([]);
  });

  it('reads the rotated tail before the new log', async () => {
    const files: Record<string, string> = { '/l': 'a\nb\n' };
    const r1 = await readHookLog(fs(files), '/l', undefined);
    files['/l.1'] = 'a\nb\nc\n';
    files['/l'] = 'd\n';
    expect((await readHookLog(fs(files), '/l', r1!.cursor))!.lines).toEqual(['c', 'd']);
  });
});
