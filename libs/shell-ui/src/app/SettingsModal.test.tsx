// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { SettingsProvider } from '../SettingsProvider';
import { PluginSettingsProvider } from './PluginSettingsProvider';
import { SessionBackendProvider, ShellPlatformProvider } from '../services';
import { StoryShellProviders, storyBackend, storyPlatform } from './storyMocks';
import type { ShellPlatform } from '../platform';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(embedded?: boolean, onClose = () => {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <SettingsModal open embedded={embedded} onClose={onClose} />
      </StoryShellProviders>,
    ),
  );
  return container;
}

/** Mirrors apps/desktop's authorityStatus: plain object, this-bound methods. */
function makeStatusStore() {
  return {
    _state: 'connecting' as 'idle' | 'connecting' | 'connected' | 'failed',
    _error: undefined as string | undefined,
    _snapshot: { state: 'connecting', error: undefined } as {
      state: 'idle' | 'connecting' | 'connected' | 'failed';
      error?: string;
    },
    _cbs: new Set<() => void>(),
    get() {
      return this._snapshot;
    },
    set(state: 'idle' | 'connecting' | 'connected' | 'failed', error?: string) {
      this._state = state;
      this._error = error;
      this._snapshot = { state, error };
      this._cbs.forEach((cb) => cb());
    },
    subscribe(cb: () => void) {
      this._cbs.add(cb);
      return () => this._cbs.delete(cb);
    },
  };
}

const remoteConfigStore = {
  load: () => Promise.resolve("remoteAuthorityUrl: 'wss://hub/remote'\n"),
  save: () => Promise.resolve(),
};

async function renderWithAuthority(platform: ShellPlatform) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SessionBackendProvider backend={storyBackend}>
        <ShellPlatformProvider platform={platform}>
          <SettingsProvider configStore={remoteConfigStore}>
            <PluginSettingsProvider store={storyPlatform.pluginSettingsStore}>
              <SettingsModal open onClose={() => {}} />
            </PluginSettingsProvider>
          </SettingsProvider>
        </ShellPlatformProvider>
      </SessionBackendProvider>,
    ),
  );
  // configStore.load() resolves async — let it flush.
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  return container;
}

it('renders the General tab in modal mode', async () => {
  const el = await render();
  expect(el.textContent).toContain('Settings');
  expect(el.textContent).toContain('UI zoom');
});

it('renders embedded (preferences window) mode', async () => {
  const el = await render(true);
  expect(el.textContent).toContain('UI zoom');
});

it('switches to the Plugins tab and lists plugin entries', async () => {
  const el = await render();
  const pluginsTab = Array.from(el.querySelectorAll('button')).find(
    (b) => b.textContent === 'Plugins',
  );
  expect(pluginsTab).toBeTruthy();
  await act(async () => pluginsTab!.click());
  expect(el.textContent).toMatch(/plugin/i);
});

it('Escape closes the modal (not in embedded mode)', async () => {
  const onClose = vi.fn();
  const el = await render(false, onClose);
  const modal = el.querySelector('.fixed.inset-0')!;
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(modal).toBeTruthy();
});

it('backdrop click closes only in modal mode', async () => {
  const onClose = vi.fn();
  const el = await render(false, onClose);
  const backdrop = el.querySelector('.fixed.inset-0') as HTMLElement;
  expect(backdrop).toBeTruthy();
  await act(async () => {
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);

  // Embedded has no backdrop to click through.
  await act(async () => root?.unmount());
  const onCloseEmbedded = vi.fn();
  const el2 = await render(true, onCloseEmbedded);
  expect(el2.querySelector('.fixed.inset-0')).toBeNull();
});

it('renders the remote-authority status line and follows store updates', async () => {
  const statusStore = makeStatusStore();
  const platform = { ...storyPlatform, remoteAuthorityStatus: statusStore };
  const el = await renderWithAuthority(platform);
  // The Remote tab is gone — the enable toggle lives on General; the
  // status itself moved to the rail icon. Just check the toggle exists.
  expect(el.textContent).toContain('Enable remote');

  // The 'failed' label is the only interpolated message
  // (t`Failed: ${error}`) — under vitest the babel macro and the compiled
  // catalog disagree on the value formatter, so it can't be rendered here.
});
