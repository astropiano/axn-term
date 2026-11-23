import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { echoReply, parseEchoReply, promptArg, sh, shellQuote, shellRaw, shellWord } from './shellQuote';

describe('shellQuote', () => {
  it('single-quotes, escaping embedded quotes', () => {
    expect(shellQuote("/it's/here")).toBe(`'/it'\\''s/here'`);
    expect(shellQuote('$(rm -rf ~); `x`')).toBe("'$(rm -rf ~); `x`'");
  });
});

describe('shellWord', () => {
  it('leaves plain words bare and quotes the rest', () => {
    expect(shellWord('origin/main')).toBe('origin/main');
    expect(shellWord('a b')).toBe("'a b'");
  });
});

describe('promptArg', () => {
  it('carries any text base64-encoded', () => {
    const arg = promptArg("multi\nline 'quoted' $(x)");
    expect(arg).toMatch(/^"\$\(printf %s '[A-Za-z0-9+/=]+' \| base64 -d\)"$/);
  });
});

describe('sh', () => {
  const argv = (cmd: string) =>
    execFileSync('/bin/sh', ['-c', `args() { printf '%s\\n' "$@"; }; ${cmd}`], { encoding: 'utf8' });

  it('quotes every interpolation as one word, bare when plain', () => {
    expect(sh`git -C ${'/repo'} log ${'a b'}`).toBe("git -C /repo log 'a b'");
    expect(sh`x ${''} ${42}`).toBe("x '' 42");
  });

  it('splices shellRaw fragments verbatim', () => {
    expect(sh`${shellRaw('claude --model haiku')} -p ${'hi there'}`).toBe("claude --model haiku -p 'hi there'");
  });

  it('keeps hostile values to a single inert argument', () => {
    for (const hostile of ['$(touch pwned)', '`id`', 'x;rm -rf ~', "it's", 'a\\b', '"q"', 'line\nbreak', '$HOME']) {
      expect(argv(sh`args ${hostile}`)).toBe(`${hostile}\n`);
    }
  });
});

describe('echoReply / parseEchoReply', () => {
  const run = (cmd: string, cwd: string) =>
    execFileSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', cwd });

  it('round-trips hostile payloads without expansion', () => {
    const dir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
    for (const msg of [
      '$(touch pwned)',
      '`touch pwned`',
      "it's $(touch pwned) \"quoted\"",
      'multi\nline $HOME `id`',
      'a plain message',
      '',
    ]) {
      const out = run(echoReply(msg), dir);
      expect(out).toBe(`${msg}\n`);
      expect(parseEchoReply(echoReply(msg))).toBe(msg);
    }
    const entries = execFileSync('ls', ['-a', dir], { encoding: 'utf8' });
    expect(entries.trim()).toBe('.\n..');
  });

  it('still parses the legacy JSON form external plugins emit', () => {
    expect(parseEchoReply('echo "axn-focus: no such tab: x"')).toBe('axn-focus: no such tab: x');
    expect(parseEchoReply(`echo "it's \\\"quoted\\\""`)).toBe(`it's "quoted"`);
  });

  it('rejects non-echo lines', () => {
    expect(parseEchoReply('ls -la')).toBeUndefined();
    expect(parseEchoReply(false)).toBeUndefined();
    expect(parseEchoReply(undefined)).toBeUndefined();
    expect(parseEchoReply("echo 'unclosed")).toBeUndefined();
    expect(parseEchoReply('echo ok extra')).toBeUndefined();
  });
});
