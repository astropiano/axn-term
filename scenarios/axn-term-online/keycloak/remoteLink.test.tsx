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

function renderView(platform: ShellPlatform) {
  registerShellPlatform(platform);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const view = remoteLinkPlugin.renderView?.({} as never);
  act(() => {
    root!.render(
      <ShellPlatformProvider platform={platform}>
        <SettingsProvider>{view}</SettingsProvider>
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
