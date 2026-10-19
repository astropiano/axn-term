import { describe, expect, it } from 'vitest';
import { expandPathArg, resolvePath } from './fileService';

describe('expandPathArg', () => {
  it('strips matching outer quotes', () => {
    expect(expandPathArg('"my notes.md"')).toBe('my notes.md');
    expect(expandPathArg("'my notes.md'")).toBe('my notes.md');
    expect(expandPathArg('"unbalanced')).toBe('"unbalanced');
    expect(expandPathArg(`"mixed'`)).toBe(`"mixed'`);
  });

  it('expands a leading ~ to the home directory', () => {
    expect(expandPathArg('~', '/home/me')).toBe('/home/me');
    expect(expandPathArg('~/src/x.ts', '/home/me/')).toBe('/home/me/src/x.ts');
    expect(expandPathArg('"~/my dir"', '/home/me')).toBe('/home/me/my dir');
  });

  it('leaves other paths alone', () => {
    expect(expandPathArg('~other/x', '/home/me')).toBe('~other/x');
    expect(expandPathArg('src/~x', '/home/me')).toBe('src/~x');
    expect(expandPathArg('~/x')).toBe('~/x');
    expect(expandPathArg('/abs/path', '/home/me')).toBe('/abs/path');
  });

  it('resolves to an absolute path instead of <cwd>/~/…', () => {
    expect(resolvePath('/work', expandPathArg('~/notes.md', '/home/me'))).toBe(
      '/home/me/notes.md',
    );
    expect(resolvePath('/work', expandPathArg('"a b/c.md"'))).toBe('/work/a b/c.md');
  });
});
