import { describe, expect, it } from 'vitest';
import { stripUserHost } from './shellTitle';

describe('stripUserHost', () => {
  it('drops user@host: and keeps the folder', () => {
    expect(stripUserHost('alex@mac: ~/code/axn-term')).toBe('~/code/axn-term');
    expect(stripUserHost('alex@mac.local:~/code')).toBe('~/code');
  });
  it('leaves other titles alone', () => {
    expect(stripUserHost('devin: fix the build')).toBe('devin: fix the build');
    expect(stripUserHost('vim notes@v2.md')).toBe('vim notes@v2.md');
    expect(stripUserHost('alex@mac:')).toBe('alex@mac:');
  });
});
