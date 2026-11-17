// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, it } from 'vitest';
import type { ShellPlatform } from '../platform';
import type { WindowState } from '../types';
import { ShellApp } from './ShellApp';
import { registerSessionViewPlugin } from './session-plugins';
import { storyBackend, storyPlatform, storySessions } from './storyMocks';
import { SettingsProvider } from '../SettingsProvider';
import { activeView, selectView } from './viewHost';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;
let pushSettings: ((yaml: string | null) => void) | undefined;

beforeAll(() => {
  registerSessionViewPlugin({
    id: 'test-views',
    title: 'Test views',
    keepViewMounted: true,
    railEntries: () => [
      { id: 'a', title: 'View A' },
      { id: 'b', title: 'View B' },
    ],
    renderView: ({ entryId, active }) => (
      <span data-view={entryId} data-active={String(active)} />
    ),
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

async function mountApp() {
  const state = {
    id: 'main',
    workspaces: [{ id: 'w1', name: 'one' }, { id: 'w2', name: 'two' }],
    sessions: storySessions,
    selectedWorkspaceId: 'w1',
    selectedSessionId: 'sess-1',
  } as unknown as WindowState;
  let yaml = '';
  const platform: ShellPlatform = {
    ...storyPlatform,
    stateStore: { ...storyPlatform.stateStore, load: () => Promise.resolve(state) },
    pluginSettingsStore: {
      read: () => Promise.resolve(yaml),
      write: (content) => {
        yaml = content;
        return Promise.resolve();
      },
      watch: (cb) => {
        pushSettings = (next) => {
          yaml = next ?? '';
          cb(next);
        };
        return () => {
          pushSettings = undefined;
        };
      },
    },
  };
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

const view = (id: string) => container.querySelector<HTMLElement>(`[data-view="${id}"]`);
const wrapperInert = (id: string) => view(id)!.parentElement!.hasAttribute('inert');

it('renders one rail slot per entry, keyed pluginId/entryId', async () => {
  await mountApp();
  expect(container.querySelector('[data-rail-slot="test-views/a"]')).not.toBeNull();
  expect(container.querySelector('[data-rail-slot="test-views/b"]')).not.toBeNull();
  expect(container.querySelector('[data-rail-slot="test-views"]')).toBeNull();
});

it('keeps an opened view mounted and inert while another view or the session shows', async () => {
  await mountApp();
  await act(async () => void selectView('test-views/a'));
  expect(view('a')?.dataset.active).toBe('true');
  expect(wrapperInert('a')).toBe(false);

  await act(async () => void selectView('test-views/b'));
  expect(view('a')?.dataset.active).toBe('false');
  expect(wrapperInert('a')).toBe(true);
  expect(view('b')?.dataset.active).toBe('true');

  await act(async () => void selectView(null));
  expect(view('a')).not.toBeNull();
  expect(view('b')).not.toBeNull();
  expect(wrapperInert('b')).toBe(true);
  expect(activeView()).toBeNull();
});

it('refuses an unknown entry key', async () => {
  await mountApp();
  let ok = true;
  await act(async () => {
    ok = selectView('test-views/zzz');
  });
  expect(ok).toBe(false);
  expect(activeView()).toBeNull();
});

it('falls back to the session and unmounts views when the plugin is disabled while active', async () => {
  await mountApp();
  await act(async () => void selectView('test-views/a'));
  expect(activeView()?.key).toBe('test-views/a');
  await act(async () => pushSettings?.('test-views:\n  enabled: false\n'));
  expect(activeView()).toBeNull();
  expect(view('a')).toBeNull();
});
