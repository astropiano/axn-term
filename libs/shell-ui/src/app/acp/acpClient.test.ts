import { expect, it, vi } from 'vitest';
import { AcpClient, type AcpPipe } from './acpClient';
import { planToTasks } from './AcpSessionTab';

function fakePipe() {
  const written: Record<string, unknown>[] = [];
  let lineCb: ((line: string) => void) | undefined;
  let exitCb: ((code: number | null) => void) | undefined;
  const pipe: AcpPipe = {
    write: (line) => written.push(JSON.parse(line) as Record<string, unknown>),
    onLine: (cb) => {
      lineCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    close: vi.fn(),
  };
  return {
    pipe,
    written,
    emit: (msg: Record<string, unknown>) => lineCb?.(JSON.stringify(msg)),
    exit: (code: number | null) => exitCb?.(code),
  };
}

it('sends initialize and resolves on the matching result', async () => {
  const { pipe, written, emit } = fakePipe();
  const client = new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() });
  const p = client.initialize();
  expect(written[0]).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
  await expect(p).resolves.toEqual({ protocolVersion: 1 });
});

it('session/new stores the assigned session id; prompt references it', async () => {
  const { pipe, written, emit } = fakePipe();
  const client = new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() });
  const p = client.sessionNew('/repo');
  emit({ jsonrpc: '2.0', id: 1, result: { sessionId: 'sess-9' } });
  await expect(p).resolves.toBe('sess-9');
  expect(client.sessionId).toBe('sess-9');
  void client.prompt('hi');
  expect(written[1]).toMatchObject({
    method: 'session/prompt',
    params: { sessionId: 'sess-9', prompt: [{ type: 'text', text: 'hi' }] },
  });
});

it('routes session/update notifications to onUpdate', async () => {
  const onUpdate = vi.fn();
  const { pipe, emit } = fakePipe();
  new AcpClient(pipe, { onUpdate, onPermission: vi.fn() });
  emit({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'he' } },
    },
  });
  expect(onUpdate).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 's', sessionUpdate: 'agent_message_chunk' }),
  );
});

it('answers session/request_permission with a selected outcome under result', () => {
  const onPermission = vi.fn((_req, respond: (o: string) => void) => respond('allow'));
  const { pipe, written, emit } = fakePipe();
  new AcpClient(pipe, { onUpdate: vi.fn(), onPermission });
  emit({
    jsonrpc: '2.0',
    id: 42,
    method: 'session/request_permission',
    params: { toolCall: { title: 'write file' }, options: [{ optionId: 'allow', name: 'Allow' }] },
  });
  expect(onPermission).toHaveBeenCalled();
  expect(written[0]).toEqual({
    jsonrpc: '2.0',
    id: 42,
    result: { outcome: { outcome: 'selected', optionId: 'allow' } },
  });
});

it('declines unhandled agent requests so the agent never hangs', () => {
  const { pipe, written, emit } = fakePipe();
  new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() });
  emit({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: '/x' } });
  expect(written[0]).toMatchObject({
    id: 7,
    error: { code: -32601 },
  });
});

it('session/load falls back to session/new when the agent cannot load', async () => {
  const { pipe, written, emit } = fakePipe();
  const client = new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() });
  const p = client.sessionLoad('/repo', 'old-sess');
  emit({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no loadSession' } });
  // The fallback session/new is the next request on the wire — written on
  // a microtask once the rejected load resolves into the catch.
  await new Promise((r) => setTimeout(r, 0));
  expect(written[1]).toMatchObject({ id: 2, method: 'session/new' });
  emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'fresh' } });
  await expect(p).resolves.toBe('fresh');
});

it('rejects pending requests and reports onExit when the agent dies', async () => {
  const onExit = vi.fn();
  const { pipe, exit } = fakePipe();
  const client = new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn(), onExit });
  const p = client.sessionNew('/repo');
  exit(1);
  await expect(p).rejects.toThrow('agent exited');
  expect(onExit).toHaveBeenCalledWith(1);
});

it('dispose closes the pipe', () => {
  const { pipe } = fakePipe();
  const client = new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() });
  client.dispose();
  expect(pipe.close).toHaveBeenCalled();
});

it('planToTasks maps ACP plan entries to tab tasks + progress', () => {
  const { tasks, progress } = planToTasks([
    { content: 'explore', status: 'completed', priority: 'medium' },
    { content: 'edit', status: 'in_progress', priority: 'high' },
    { content: 'test', status: 'pending', priority: 'low' },
  ]);
  expect(tasks).toEqual([
    { id: 'acp-0', title: 'explore', done: true },
    { id: 'acp-1', title: 'edit', done: false },
    { id: 'acp-2', title: 'test', done: false },
  ]);
  expect(progress).toBe(33);
});

it('serves fs/read_text_file through handlers and answers {content}', async () => {
  const { pipe, written, emit } = fakePipe();
  const fs = { readTextFile: vi.fn(async () => 'file-body'), writeTextFile: vi.fn(async () => {}) };
  new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() }, { fs });
  emit({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: { path: '/a.ts' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(fs.readTextFile).toHaveBeenCalledWith('/a.ts');
  expect(written[0]).toEqual({ jsonrpc: '2.0', id: 9, result: { content: 'file-body' } });
});

it('serves terminal/create and returns the terminalId', async () => {
  const { pipe, written, emit } = fakePipe();
  const terminal = {
    create: vi.fn(async () => 't-1'),
    output: vi.fn(async () => ({ output: 'hi', truncated: false })),
    kill: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    waitForExit: vi.fn(async () => ({ exit_code: 0 })),
  };
  new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() }, { terminal });
  emit({ jsonrpc: '2.0', id: 4, method: 'terminal/create', params: { command: 'ls', cwd: '/tmp' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(terminal.create).toHaveBeenCalledWith({ command: 'ls', cwd: '/tmp' });
  expect(written[0]).toEqual({ jsonrpc: '2.0', id: 4, result: { terminalId: 't-1' } });
});

it('still answers -32601 for a tier with no handler', async () => {
  const { pipe, written, emit } = fakePipe();
  new AcpClient(pipe, { onUpdate: vi.fn(), onPermission: vi.fn() }, {});
  emit({ jsonrpc: '2.0', id: 5, method: 'terminal/create', params: { command: 'ls' } });
  await new Promise((r) => setTimeout(r, 0));
  expect(written[0]).toMatchObject({ id: 5, error: { code: -32601 } });
});
