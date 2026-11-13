// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ShellApp } from './ShellApp';
import { storyBackend, storyPlatform, storySessions } from './storyMocks';
import { dispatchSessionCommand } from './session-plugins/plugin';
import { registerSessionViewPlugin } from './session-plugins';
import { SettingsProvider } from '../SettingsProvider';
import type { ShellPlatform } from '../platform';
import type { WindowState } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

async function mountApp(platform: ShellPlatform) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SettingsProvider>
        <ShellApp
          backend={storyBackend}
          services={{ copyText: () => Promise.resolve(), openExternal: () => {} }}
          platform={platform}
          fileReader={() => undefined}
        />
      </SettingsProvider>,
    ),
  );
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
});

it('gets from "Loading sessions…" to the loaded app without a hook-order crash', async () => {
  // Hold the state load so the first render is the loading screen.
  let release!: (state: WindowState | null) => void;
  const loadGate = new Promise<WindowState | null>((r) => (release = r));
  const platform: ShellPlatform = {
    ...storyPlatform,
    stateStore: { ...storyPlatform.stateStore, load: () => loadGate },
  };
  const errors: unknown[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));

  await mountApp(platform);
  expect(container.textContent).toContain('Loading sessions…');

  await act(async () => {
    release(null);
    await loadGate;
  });

  expect(container.textContent).not.toContain('Loading sessions…');
  expect(container.textContent).not.toContain('unexpected error');
  expect(errors.map(String).join('\n')).not.toMatch(/Rendered more hooks|#310/);
});

it('toggles the settings dialog on the app menu event (Preferences…, ⌘,)', async () => {
  await mountApp(storyPlatform);
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  const dialog = () => container.ownerDocument.querySelector('.fixed.inset-0 h2');
  expect(dialog()).toBeNull();

  await act(async () => {
    window.dispatchEvent(new CustomEvent('axn:menu-settings'));
  });
  expect(dialog()?.textContent).toBe('Settings');

  // The same key closes it again — like the gear at the bottom of the rail.
  await act(async () => {
    window.dispatchEvent(new CustomEvent('axn:menu-settings'));
  });
  expect(dialog()).toBeNull();
});

it('keeps both sub-shell tabs when two are opened before a re-render', async () => {
  const session = { ...storySessions[0] };
  const platform: ShellPlatform = {
    ...storyPlatform,
    stateStore: {
      ...storyPlatform.stateStore,
      load: () =>
        Promise.resolve({
          id: 'main',
          workspaces: [{ id: 'w1', name: 'ws' }],
          sessions: [session],
          selectedWorkspaceId: 'w1',
          selectedSessionId: session.id,
        }),
    },
  };
  await mountApp(platform);
  const tabCount = () => container.querySelectorAll('button[aria-label="Close tab"]').length;
  expect(tabCount()).toBe(0);

  // `axn-sh` opens a sub-shell tab synchronously; run it twice in one tick.
  await act(async () => {
    void dispatchSessionCommand(session.id, 'axn-sh');
    void dispatchSessionCommand(session.id, 'axn-sh');
  });

  expect(tabCount()).toBe(2);
});

it('keeps both plugin-hosted tabs when two are opened before a re-render', async () => {
  registerSessionViewPlugin({
    id: 'tab-test',
    title: 'Tab test',
    hostsTabs: true,
    renderRail: ({ toggleView }) => (
      <button type="button" data-testid="tab-test-rail" onClick={toggleView} />
    ),
    renderView: ({ openTab }) => (
      <button
        type="button"
        data-testid="tab-test-open"
        onClick={() => {
          openTab?.({ path: '/tmp/a.md', kind: 'preview' });
          openTab?.({ path: '/tmp/b.md', kind: 'preview' });
        }}
      />
    ),
  });
  const session = { ...storySessions[0] };
  await mountApp({
    ...storyPlatform,
    stateStore: {
      ...storyPlatform.stateStore,
      load: () =>
        Promise.resolve({
          id: 'main',
          workspaces: [{ id: 'w1', name: 'ws' }],
          sessions: [session],
          selectedWorkspaceId: 'w1',
          selectedSessionId: session.id,
        }),
    },
  });
  const click = (id: string) =>
    act(async () =>
      (container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click(),
    );
  await click('tab-test-rail');
  await click('tab-test-open');

  const tabs = container.querySelectorAll('[data-plugin-id="tab-test"][data-tab-id]');
  expect(tabs).toHaveLength(2);
});
