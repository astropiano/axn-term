// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionBackend } from '@axn-term/session-backend';
import { ShellTerminal } from './ShellTerminal';
import { SettingsProvider } from './SettingsProvider';
import { ShellServicesProvider } from './services';
import { storyBackend, storySessions } from './app/storyMocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stable across renders: a new services object would restart the terminal.
const services = { copyText: () => Promise.resolve(), openExternal: () => {} };
const fileReader = () => undefined;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function renderTerminal(backend: SessionBackend, isVisible: boolean) {
  await act(async () =>
    root!.render(
      <SettingsProvider>
        <ShellServicesProvider services={services} fileReader={fileReader}>
          <ShellTerminal session={storySessions[0]} backend={backend} isVisible={isVisible} />
        </ShellServicesProvider>
      </SettingsProvider>,
    ),
  );
}

it('asks a releasing backend for the stream again when the tab is shown', async () => {
  // A remote viewer releases the pty stream on hide; showing the tab at an
  // unchanged size fires no xterm onResize, so the terminal must resize
  // (re-claim) itself or output stays frozen.
  const releasePty = vi.fn();
  const resize = vi.fn();
  const backend: SessionBackend = { ...storyBackend, releasePty, resize };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await renderTerminal(backend, true);
  await renderTerminal(backend, false);
  expect(releasePty).toHaveBeenCalledWith('sess-1');

  resize.mockClear();
  await renderTerminal(backend, true);
  expect(resize).toHaveBeenCalledWith('sess-1', expect.any(Number), expect.any(Number));
});

it('leaves backends without releasePty alone on show', async () => {
  const resize = vi.fn();
  const backend: SessionBackend = { ...storyBackend, resize };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  await renderTerminal(backend, true);
  await renderTerminal(backend, false);
  resize.mockClear();
  await renderTerminal(backend, true);
  expect(resize).not.toHaveBeenCalled();
});
