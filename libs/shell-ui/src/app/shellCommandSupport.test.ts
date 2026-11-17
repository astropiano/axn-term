import { describe, expect, it } from 'vitest';
import { parseSessionArgs } from './shellCommandSupport';

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe('parseSessionArgs --command', () => {
  it('takes a quoted command line', () => {
    expect(parseSessionArgs('src -n review --command "glab mr view 7"')).toMatchObject({
      path: 'src',
      name: 'review',
      command: 'glab mr view 7',
    });
  });
  it('decodes --command-b64, so mixed quotes and unicode survive', () => {
    const line = `zsh -lic 'claude "review !7 – it’s ready"'`;
    expect(parseSessionArgs(`/tmp/x --command-b64 ${b64(line)}`)).toMatchObject({ path: '/tmp/x', command: line });
  });
  it('rejects malformed base64 and a missing value', () => {
    expect(parseSessionArgs('src --command-b64 %%%').error).toBeDefined();
    expect(parseSessionArgs('src --command').error).toBeDefined();
  });
});
