import { describe, expect, it } from 'vitest';
import { compileDangerRules, dangerCheck } from './broadcastDanger';

describe('dangerCheck builtins', () => {
  const hits: [string, string][] = [
    ['rm -rf /tmp/x', 'rm-rf'],
    ['rm -fr node_modules', 'rm-rf'],
    ['sudo rm -r /var/log/old', 'rm-rf'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'disk-write'],
    ['mkfs.ext4 /dev/sdb1', 'disk-write'],
    ['sudo reboot now', 'power'],
    ['shutdown -h now', 'power'],
    ['git push --force origin main', 'git-force'],
    ['git push -f', 'git-force'],
    ['git push origin --delete old-branch', 'git-force'],
    ['git reset --hard HEAD~3', 'git-destroy'],
    ['git clean -fdx', 'git-destroy'],
    ['DROP TABLE users;', 'sql-drop'],
    ['delete from sessions where stale', 'sql-drop'],
    ['kubectl delete pod api-7d9f', 'kubectl-delete'],
    ['kubectl drain node-3', 'kubectl-delete'],
    ['systemctl stop nginx', 'systemctl-stop'],
    ['chmod -R 777 /srv/app', 'perms-recursive'],
    ['chown -R root:root /etc', 'perms-recursive'],
    ['killall node', 'kill-by-name'],
    ['pkill -f webpack', 'kill-by-name'],
    [':(){ :|:& };:', 'fork-bomb'],
  ];
  it.each(hits)('gates %s (%s)', (line, id) => {
    const hit = dangerCheck(line);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(line.trim());
    expect(
      compileDangerRules().some((r) => r.id === id && r.re.test(line)),
    ).toBe(true);
  });

  const trulySafe = [
    'ls -la',
    'rm file.txt',
    'rm -i old.log',
    'git push origin main',
    'kubectl get pods',
    'systemctl status nginx',
    'chmod +x run.sh',
    'npm publish',
    'sudo apt update',
    'git checkout -b feature',
    'echo hello',
  ];
  it.each(trulySafe)('lets %s through', (line) => {
    expect(dangerCheck(line)).toBeNull();
  });

  it('checks every line of a multi-line buffer', () => {
    expect(dangerCheck('ls\necho hi')).toBeNull();
    const hit = dangerCheck('ls\nrm -rf build\npwd');
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe('rm -rf build');
  });
});

describe('user patterns (broadcastDangerPatterns)', () => {
  it('appends user regexes to the builtins', () => {
    expect(dangerCheck('terraform apply -auto-approve')).toBeNull();
    const hit = dangerCheck('terraform apply -auto-approve', ['terraform\\s+apply']);
    expect(hit).not.toBeNull();
    expect(hit!.rule).toBe('terraform\\s+apply');
  });

  it('skips invalid regexes instead of throwing', () => {
    expect(dangerCheck('anything', ['[unclosed'])).toBeNull();
    expect(dangerCheck('rm -rf x', ['[unclosed'])).not.toBeNull();
  });

  it('builtin labels win over a broader user pattern', () => {
    // Builtins run first — their reason text is more informative than the
    // raw regex when both could match.
    const hit = dangerCheck('rm -rf x', ['rm']);
    expect(hit!.rule).not.toBe('rm');
  });
});
