// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteConsoleSnapshot } from '@axn-term/session-backend';
import type { ShellPlatform } from '../../platform';
import { registerShellPlatform } from '../../platform';
import { ShellPlatformProvider } from '../../services';
import { SettingsProvider } from '../../SettingsProvider';
import { remoteLinkPlugin } from './remoteLink';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const VIEWER_SNAPSHOT: RemoteConsoleSnapshot = {
  role: 'viewer',
  state: 'ready',
  hostName: 'axn-term-host-1',
  hostDevice: 'desktop',
  selfViewerId: 'viewer-1',
  ptys: [],
  claims: {},
  viewers: { 'viewer-1': { name: 'This device' } },
  sessionId: 'sub-123/mac',
  authorityUrl: 'wss://hub.example:18094/remote',
};

function viewerPlatform(overrides: Partial<ShellPlatform> = {}): ShellPlatform {
  return {
    remoteConsole: {
      get: () => VIEWER_SNAPSHOT,
      subscribe: () => () => {},
    },
    ...overrides,
  } as unknown as ShellPlatform;
}

function renderView(platform: ShellPlatform, configYaml?: string) {
  registerShellPlatform(platform);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const view = remoteLinkPlugin.renderView?.({} as never);
  const configStore = configYaml
    ? { load: () => Promise.resolve(configYaml), save: () => Promise.resolve() }
    : undefined;
  act(() => {
    root!.render(
      <ShellPlatformProvider platform={platform}>
        <SettingsProvider configStore={configStore}>{view}</SettingsProvider>
      </ShellPlatformProvider>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  document.body.innerHTML = '';
});

it('viewer mode: renders without remoteAuth — no infinite getSnapshot loop', () => {
  // Regression: the auth fallback `() => ({ state: 'signedOut' })` returned
  // a fresh object each call — useSyncExternalStore re-rendered forever and
  // React tore down the whole app. Reproduces the phone crash.
  const el = renderView(viewerPlatform());
  expect(el.textContent).toContain('Remote — viewing');
});

it('viewer mode: shows where it is connected to', () => {
  const el = renderView(viewerPlatform());
  expect(el.textContent).toContain('wss://hub.example:18094/remote');
  expect(el.textContent).toContain('mac'); // session id, sub-prefix stripped
  // The host config form must not render for viewers.
  expect(el.querySelector('input')).toBeNull();
});

it('viewer mode: sign-out calls the platform signOut seam', () => {
  const signOut = vi.fn();
  const el = renderView(viewerPlatform({ signOut }));
  const btn = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Sign out',
  );
  expect(btn).toBeTruthy();
  act(() => btn!.click());
  expect(signOut).toHaveBeenCalledOnce();
});

it('viewer mode: no sign-out button when the platform has none', () => {
  const el = renderView(viewerPlatform());
  const btn = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Sign out',
  );
  expect(btn).toBeUndefined();
});

it('host view renders the publish checklist with a this-bound status store', () => {
  // The desktop's store used `this` in get()/subscribe(); the checklist once
  // handed them to useSyncExternalStore detached and the panel crashed.
  const store = {
    snapshot: { state: 'failed' as const, error: 'Sign in to publish this desktop' },
    cbs: new Set<() => void>(),
    get() {
      return this.snapshot;
    },
    subscribe(cb: () => void) {
      this.cbs.add(cb);
      return () => this.cbs.delete(cb);
    },
  };
  const hostSnapshot: RemoteConsoleSnapshot = { ...VIEWER_SNAPSHOT, role: 'authority', state: 'idle', viewers: {} };
  const el = renderView({
    remoteConsole: {
      get: () => hostSnapshot,
      subscribe: () => () => {},
    },
    remoteAuthorityStatus: store,
  } as unknown as ShellPlatform);
  expect(el.textContent).toContain('Publishing');
  expect(el.textContent).toContain('Sign in to publish this desktop');
});

const STALE_CONFIG = [
  'remoteEnabled: true',
  "remoteAuthorityUrl: 'wss://stale.example:18095/remote'",
  "remoteAuthIssuer: 'https://stale.example:18096/auth/realms/axn-term'",
].join('\n');

const SIGNED_OUT = { state: 'signedOut' };
const IDLE_STATUS = { state: 'idle' };

function hostPlatform(status: (hubUrl: string) => Promise<unknown>): ShellPlatform {
  const hostSnapshot: RemoteConsoleSnapshot = { ...VIEWER_SNAPSHOT, role: 'authority', state: 'idle', viewers: {} };
  return {
    remoteConsole: { get: () => hostSnapshot, subscribe: () => () => {} },
    remoteAuthorityStatus: { get: () => IDLE_STATUS, subscribe: () => () => {} },
    remoteServer: { status, connect: vi.fn() },
    remoteAuth: {
      get: () => SIGNED_OUT,
      subscribe: () => () => {},
      signIn: vi.fn(),
      signOut: vi.fn(),
    },
  } as unknown as ShellPlatform;
}

it('host view: a saved server that does not answer gates sign-in', async () => {
  // Stale saved config (dead ports from an old deployment): the Server step
  // must not show done and Sign in must stay disabled — no login against
  // nonsense.
  const status = vi.fn().mockRejectedValue(new TypeError('unreachable'));
  const el = renderView(hostPlatform(status), STALE_CONFIG);
  await act(async () => {});
  expect(el.textContent).toContain('needs attention');
  expect(el.textContent).toContain('not answering');
  const btn = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Sign in…',
  ) as HTMLButtonElement | undefined;
  expect(btn).toBeTruthy();
  expect(btn!.disabled).toBe(true);
});

it('host view: any HTTP answer (even 401) counts as reachable', async () => {
  const status = vi.fn().mockRejectedValue(Object.assign(new Error('HTTP 401'), { status: 401 }));
  const el = renderView(hostPlatform(status), STALE_CONFIG);
  await act(async () => {});
  const btn = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Sign in…',
  ) as HTMLButtonElement | undefined;
  expect(btn).toBeTruthy();
  expect(btn!.disabled).toBe(false);
});
