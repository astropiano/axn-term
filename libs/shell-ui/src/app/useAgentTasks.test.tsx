// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentTasks } from './useAgentTasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sockets: string[] = [];
class FakeWebSocket {
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    sockets.push(url);
  }
  send() {}
  close() {}
}

let root: Root;
const updateSession = () => {};

async function render(
  sessionId: string,
  tasksWsUrl?: () => string | null | Promise<string | null>,
) {
  function Harness() {
    useAgentTasks(sessionId, updateSession, true, tasksWsUrl);
    return null;
  }
  await act(async () => root.render(<Harness />));
}

beforeEach(() => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('does not connect without a tasks URL resolver (desktop)', async () => {
  await render('s1');
  expect(sockets).toEqual([]);
});

it('does not connect when the resolver returns null', async () => {
  await render('s1', () => null);
  expect(sockets).toEqual([]);
});

it('resolves the URL afresh for every connect attempt', async () => {
  let n = 0;
  const resolve = vi.fn(async () => `ws://gw/tasks?access_token=t${++n}`);
  await render('s1', resolve);
  await render('s2', resolve);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(sockets).toEqual(['ws://gw/tasks?access_token=t1', 'ws://gw/tasks?access_token=t2']);
});
