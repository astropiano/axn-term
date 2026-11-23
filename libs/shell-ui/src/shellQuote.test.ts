import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promptArg, sh, shellQuote, shellRaw, shellWord } from './shellQuote';

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
