// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import type { ShellSession } from '../types';
import { BroadcastDeck } from './BroadcastDeck';
import { broadcastSet } from './broadcastSet';
import { StoryShellProviders } from './storyMocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The broadcast prompt is a shell-styled line: Enter writes the buffer to
// every marked PTY, Shift+Enter builds a multi-line buffer that goes out
// wrapped as a bracketed paste, Escape clears.

let root: Root | undefined;
let container: HTMLDivElement;
let writes: [string, string][];
let backend: SessionBackend;

const SESSIONS = [
  { id: 's1', name: 'one', mainPtyId: 'pty-s1', workspaceId: 'w1', activeTab: 'shell', editors: [] },
  { id: 's2', name: 'two', mainPtyId: 'pty-s2', workspaceId: 'w1', activeTab: 'shell', editors: [] },
] as unknown as ShellSession[];

function typeText(el: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(el: HTMLElement, k: string, opts: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
}

function input(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('#axn-broadcast-input')!;
}

async function mount() {
  broadcastSet.replaceAll(SESSIONS.map((s) => s.id));
  await act(async () => {
    root = createRoot(container);
    root.render(
      <StoryShellProviders>
        <BroadcastDeck backend={backend} sessions={SESSIONS} onFocusSession={() => {}} />
      </StoryShellProviders>,
    );
  });
}

beforeEach(() => {
  writes = [];
  backend = {
    write: (ptyId: string, data: string) => {
      writes.push([ptyId, data]);
      return Promise.resolve();
    },
  } as unknown as SessionBackend;
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  broadcastSet.clear();
  if (root) {
    await act(async () => root!.unmount());
    root = undefined;
  }
  container.remove();
});

it('Enter writes the line + CR to every marked session', async () => {
  await mount();
  await act(async () => typeText(input(), 'ls -la'));
  await act(async () => key(input(), 'Enter'));
  expect(writes).toEqual([
    ['pty-s1', 'ls -la\r'],
    ['pty-s2', 'ls -la\r'],
  ]);
  expect(input().value).toBe('');
});

it('Shift+Enter builds a multi-line buffer that sends as a bracketed paste', async () => {
  await mount();
  await act(async () => typeText(input(), 'echo one'));
  await act(async () => {
    key(input(), 'Enter', { shiftKey: true });
    typeText(input(), 'echo one\necho two');
  });
  await act(async () => key(input(), 'Enter'));
  expect(writes).toEqual([
    ['pty-s1', '\x1b[200~echo one\necho two\x1b[201~\r'],
    ['pty-s2', '\x1b[200~echo one\necho two\x1b[201~\r'],
  ]);
});

it('Escape clears the buffer without writing', async () => {
  await mount();
  await act(async () => typeText(input(), 'rm -rf /'));
  await act(async () => key(input(), 'Escape'));
  expect(input().value).toBe('');
  expect(writes).toEqual([]);
});

it('dangerous buffers open the gate; confirm sends, Enter cancels', async () => {
  await mount();
  await act(async () => typeText(input(), 'rm -rf build'));
  await act(async () => key(input(), 'Enter'));
  // Nothing was written — the modal is up with the buffer still in place.
  expect(writes).toEqual([]);
  expect(input().value).toBe('rm -rf build');
  const modal = container.ownerDocument.querySelector('.fixed.inset-0');
  expect(modal?.textContent).toContain('rm -rf build');
  expect(modal?.textContent).toContain('2 sessions');

  // Plain Enter cancels — never confirms (it's the same gesture as send).
  await act(async () => key(document.body, 'Enter'));
  expect(writes).toEqual([]);
  expect(container.ownerDocument.querySelector('.fixed.inset-0')).toBeNull();

  // Re-trigger and confirm via the send button.
  await act(async () => key(input(), 'Enter'));
  const sendBtn = [...container.ownerDocument.querySelectorAll('button')].find(
    (b) => b.textContent?.includes('Send to'),
  )!;
  await act(async () => sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  expect(writes).toEqual([
    ['pty-s1', 'rm -rf build\r'],
    ['pty-s2', 'rm -rf build\r'],
  ]);
});
