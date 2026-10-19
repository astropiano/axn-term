import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentHookScript } from '@axn-term/plugin-sdk';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('real command-hook transport', () => {
  for (const agent of ['claude', 'codex']) {
    it(`${agent}: receives piped JSON without a controlling TTY`, () => {
      const root = mkdtempSync(join(tmpdir(), 'axn-agent-hook-'));
      roots.push(root);
      const script = join(root, 'agent-hook.sh');
      writeFileSync(script, agentHookScript(), { mode: 0o700 });
      const event = { hook_event_name: 'PermissionRequest', tool_name: 'Bash' };
      const result = spawnSync(script, [agent], {
        input: JSON.stringify(event), encoding: 'utf8',
        env: { ...process.env, AXN_TERM_STATE_DIR: root, AXN_TERM_PTY_ID: 'test-session' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(JSON.parse(readFileSync(join(root, `${agent}-events/pty-test-session.json`), 'utf8'))).toEqual(event);
      for (const name of ['Stop', 'SessionEnd']) {
        expect(spawnSync(script, [agent, name], {
          input: JSON.stringify({ hook_event_name: name }), encoding: 'utf8',
          env: { ...process.env, AXN_TERM_STATE_DIR: root, AXN_TERM_PTY_ID: 'test-session' },
        }).status).toBe(0);
      }
      expect(JSON.parse(readFileSync(join(root, `${agent}-events/pty-test-session.json`), 'utf8'))).toEqual({ hook_event_name: 'Stop' });
    });
  }
});
