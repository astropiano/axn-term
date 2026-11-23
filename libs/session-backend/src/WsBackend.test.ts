import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_EXITED_CLOSE_CODE, WsBackend } from './WsBackend';

/** Minimal WebSocket stand-in: tests drive open/close by hand. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.serverClose(1000);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const decoder = new TextDecoder();

/** Next socket the backend constructs (it awaits getToken first). */
async function nextSocket(count: number): Promise<FakeWebSocket> {
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(count));
  return FakeWebSocket.instances[count - 1];
}

function setup() {
  const backend = new WsBackend({ url: 'ws://host/ws' });
  const exits: string[] = [];
  const subExits: string[] = [];
  const output: string[] = [];
  backend.onSessionExit((id) => exits.push(id));
  backend.onSubshellExit((id) => subExits.push(id));
  backend.onOutput('s1', (data) => output.push(decoder.decode(data)));
  return { backend, exits, subExits, output };
}

async function connect(backend: WsBackend): Promise<FakeWebSocket> {
  const created = backend.createSession('s1', { cols: 80, rows: 24 });
  const ws = await nextSocket(FakeWebSocket.instances.length + 1);
  ws.open();
  await created;
  return ws;
}

describe('WsBackend close handling', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires session exit for the pty-exited close code', async () => {
    const { backend, exits, output } = setup();
    const ws = await connect(backend);
    ws.serverClose(PTY_EXITED_CLOSE_CODE, 'pty-exited');
    expect(exits).toEqual(['s1']);
    expect(output).toEqual([]);
  });

  it('keeps the session and writes a notice on a dropped connection', async () => {
    const { backend, exits, output } = setup();
    const ws = await connect(backend);
    ws.serverClose(1006);
    expect(exits).toEqual([]);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain('connection lost');
  });

  it('treats a gateway restart (1012) or normal close as a lost connection', async () => {
    const { backend, exits, output } = setup();
    (await connect(backend)).serverClose(1012);
    (await connect(backend)).serverClose(1000);
    expect(exits).toEqual([]);
    expect(output).toHaveLength(2);
  });

  it('a failed connect does not delete the session', async () => {
    const { backend, exits, output } = setup();
    const created = backend.createSession('s1', { cols: 80, rows: 24 });
    const ws = await nextSocket(1);
    ws.onerror?.();
    ws.serverClose(1006);
    await expect(created).rejects.toThrow('WebSocket connection failed');
    expect(exits).toEqual([]);
    expect(output.join('')).toContain('connection lost');
  });

  it('a client-initiated close is neither an exit nor a lost connection', async () => {
    const { backend, exits, output } = setup();
    await connect(backend);
    backend.close('s1');
    expect(exits).toEqual([]);
    expect(output).toEqual([]);
  });

  it('sub-shells exit only on the pty-exited close code', async () => {
    const { backend, exits, subExits } = setup();
    await connect(backend);

    const lost = backend.createSubshell('t1', { parentId: 's1', cols: 80, rows: 24 });
    const lostWs = await nextSocket(2);
    lostWs.open();
    await lost;
    lostWs.serverClose(1006);
    expect(subExits).toEqual([]);

    const exited = backend.createSubshell('t2', { parentId: 's1', cols: 80, rows: 24 });
    const exitedWs = await nextSocket(3);
    exitedWs.open();
    await exited;
    exitedWs.serverClose(PTY_EXITED_CLOSE_CODE, 'pty-exited');
    expect(subExits).toEqual(['t2']);
    expect(exits).toEqual([]);
  });
});

describe('WsBackend control commands', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a forwarded `axn-term session` line on the PTY connection, keyed by our id', async () => {
    const { backend, output } = setup();
    const ws = await connect(backend);
    const seen: { ptyId: string; line: string }[] = [];
    backend.onControlCommand((cmd) => {
      seen.push(cmd);
      return Promise.resolve({ ok: true, message: 'done' });
    });
    ws.onmessage?.({
      data: JSON.stringify({ type: 'control-command', requestId: 'r1', line: 'axn-session-summary hi' }),
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(1));
    expect(seen).toEqual([{ ptyId: 's1', line: 'axn-session-summary hi' }]);
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({
      type: 'control-reply',
      requestId: 'r1',
      ok: true,
      message: 'done',
    });
    // a control frame is never terminal output
    expect(output).toEqual([]);
  });

  it('refuses when no handler owns the PTY', async () => {
    const { backend } = setup();
    const ws = await connect(backend);
    backend.onControlCommand(() => Promise.resolve(null));
    ws.onmessage?.({ data: JSON.stringify({ type: 'control-command', requestId: 'r2', line: 'axn-x' }) });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(1));
    expect(JSON.parse(ws.sent.at(-1) as string)).toMatchObject({ type: 'control-reply', requestId: 'r2', ok: false });
  });
});

describe('WsBackend connection lifecycle', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('concurrent connects for one id open a single socket', async () => {
    let releaseToken!: (token: string) => void;
    const token = new Promise<string>((resolve) => (releaseToken = resolve));
    const backend = new WsBackend({ url: 'ws://host/ws', getToken: () => token });

    const first = backend.createSession('s1', { cols: 80, rows: 24 });
    const second = backend.createSession('s1', { cols: 80, rows: 24 });
    releaseToken('t');
    const ws = await nextSocket(1);
    ws.open();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a request the host never answers times out and leaves no pending entry', async () => {
    const { backend, output } = setup();
    const ws = await connect(backend);
    vi.useFakeTimers();

    const read = backend.readFile('s1', '/etc/hosts');
    const cwd = backend.getCwd('s1');
    vi.advanceTimersByTime(5_000);
    expect(await cwd).toBeNull();
    vi.advanceTimersByTime(90_000);
    await expect(read).rejects.toThrow('fs-read timed out');

    // A late answer is ignored rather than treated as output.
    const requestId = JSON.parse(ws.sent[1] as string).requestId;
    ws.onmessage?.({ data: JSON.stringify({ type: 'fs-read-result', requestId, ok: true }) });
    expect(output).toEqual([]);
  });

  it('an answered request clears its timeout', async () => {
    const { backend } = setup();
    const ws = await connect(backend);
    vi.useFakeTimers();

    const cwd = backend.getCwd('s1');
    const requestId = JSON.parse(ws.sent.at(-1) as string).requestId;
    ws.onmessage?.({ data: JSON.stringify({ type: 'cwd-result', requestId, ok: true, cwd: '/tmp' }) });
    expect(await cwd).toBe('/tmp');
    expect(vi.getTimerCount()).toBe(0);
  });
});
