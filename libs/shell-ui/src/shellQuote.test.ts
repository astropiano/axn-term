import { describe, it, expect } from 'vitest';
import { promptArg, shellQuote, shellWord } from './shellQuote';

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
