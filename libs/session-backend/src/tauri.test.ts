import { describe, expect, it } from 'vitest';
import { parseOutputFrame } from './tauri';

function frame(id: string, data: number[]): ArrayBuffer {
  const idBytes = new TextEncoder().encode(id);
  const out = new Uint8Array(2 + idBytes.length + data.length);
  out[0] = idBytes.length >> 8;
  out[1] = idBytes.length & 0xff;
  out.set(idBytes, 2);
  out.set(data, 2 + idBytes.length);
  return out.buffer;
}

describe('parseOutputFrame', () => {
  it('splits the session id from the raw output bytes', () => {
    const { sessionId, data } = parseOutputFrame(frame('3f2a-session', [0x1b, 0x5b, 0x41, 0xe2, 0x82]));
    expect(sessionId).toBe('3f2a-session');
    expect([...data]).toEqual([0x1b, 0x5b, 0x41, 0xe2, 0x82]);
  });

  it('handles empty output and ids longer than 255 bytes', () => {
    const id = 'x'.repeat(300);
    const { sessionId, data } = parseOutputFrame(new Uint8Array(frame(id, [])));
    expect(sessionId).toBe(id);
    expect(data.length).toBe(0);
  });
});
