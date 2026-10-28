import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ShellApp,
  useSettings,
  ShellPlatformProvider,
  SessionBackendProvider,
  PluginSettingsProvider,
  SettingsModal,
  ErrorBoundary,
} from '@axn-term/shell-ui';
import { tauriBackend, tauriServices, tauriFileReader } from '@axn-term/session-backend/tauri';
import type { RemoteAuthority } from '@axn-term/session-backend/remote';
import { desktopPlatform } from './platform';
import { createRemoteAuthority, withAuthorityReflect } from './remoteAuthority';
import { listen } from '@tauri-apps/api/event';

// macOS Preferences… opens this app in a second native window with
// #axn-settings — render ONLY the settings UI: no ShellApp, so no sessions,
// PTYs, plugin runtimes or state.json window entry.
function SettingsWindow() {
  return (
    <ShellPlatformProvider platform={desktopPlatform}>
      <SessionBackendProvider backend={tauriBackend}>
        <PluginSettingsProvider store={desktopPlatform.pluginSettingsStore}>
          <ErrorBoundary kind="app" scope="axn-term-settings">
            <SettingsModal
              open
              embedded
              onClose={() => desktopPlatform.window?.close?.()}
            />
          </ErrorBoundary>
        </PluginSettingsProvider>
      </SessionBackendProvider>
    </ShellPlatformProvider>
  );
}

const isSettingsWindow = window.location.hash.includes('axn-settings');

export default function App() {
  // Desktop fileReader: the app shares the host filesystem, so the session
  // id is ignored — reads/writes go through the Tauri fs plugin.
  const fileReader = useCallback(() => tauriFileReader(), []);

  // The fs capability only covers $HOME; `fileAccessRoots` in config.yaml
  // widens it at runtime (e.g. repos on an external volume).
  const { settings, updateSettings } = useSettings();
  // macOS View-menu zoom → persist to uiZoom (native menus are macOS-only).
  const uiZoomRef = useRef(settings.uiZoom ?? 100);
  uiZoomRef.current = settings.uiZoom ?? 100;
  useEffect(() => {
    const pending = listen<string>('menu-zoom', (e) => {
      const cur = uiZoomRef.current;
      const next =
        e.payload === 'in'
          ? Math.min(200, Math.floor(cur / 10) * 10 + 10)
          : e.payload === 'out'
            ? Math.max(50, Math.ceil(cur / 10) * 10 - 10)
            : 100;
      updateSettings({ uiZoom: next });
    });
    const pendingReload = listen('menu-reload', () => {
      window.dispatchEvent(new CustomEvent('axn:menu-reload'));
    });
    return () => {
      void pending.then((un) => un());
      void pendingReload.then((un) => un());
    };
  }, [updateSettings]);
  const fileAccessRoots = (settings.fileAccessRoots ?? []).join('\n');
  useEffect(() => {
    const roots = fileAccessRoots.split('\n').filter(Boolean);
    if (roots.length === 0) return;
    invoke('allow_file_roots', { roots }).catch((e) =>
      console.error('allow_file_roots failed', e),
    );
  }, [fileAccessRoots]);

  // Opt-in remote authority (settings.remoteAuthorityUrl, or
  // VITE_REMOTE_AUTHORITY_URL for dev): publishes this window's terminals to
  // a client-authoritative hub so remote viewers can drive the desktop's
  // PTYs through the mirrored session. Live-restarts when the setting
  // changes (config.yaml watch makes external edits apply without restart).
  const [authority, setAuthority] = useState<RemoteAuthority | undefined>();
  // Sign-in state flips restart the authority so the hello carries the JWT.
  const remoteAuthState = useSyncExternalStore(
    useCallback(
      (cb: () => void) => desktopPlatform.remoteAuth?.subscribe(cb) ?? (() => {}),
      [],
    ),
    useCallback(
      () => desktopPlatform.remoteAuth?.get().state ?? 'signedOut',
      [],
    ),
  );
  // A published session needs a unique id on the shared hub — two devices
  // with the same id collide (the later hello wins the session). Generate a
  // stable random one the first time remote is enabled; the setting stays
  // editable in the remote console for an explicit name.
  useEffect(() => {
    if (settings.remoteEnabled === false) return;
    if (!settings.remoteAuthorityUrl) return;
    if (settings.remoteAuthoritySession) return;
    updateSettings({
      remoteAuthoritySession: `host-${crypto.randomUUID().slice(0, 8)}`,
    });
  }, [settings.remoteEnabled, settings.remoteAuthorityUrl,
      settings.remoteAuthoritySession, updateSettings]);
  useEffect(() => {
    if (settings.remoteEnabled === false) {
      setAuthority(undefined);
      return;
    }
    const next = createRemoteAuthority({
      url: settings.remoteAuthorityUrl,
      session: settings.remoteAuthoritySession,
      token: settings.remoteAuthorityToken,
      // Signed-in account JWT wins; the static setting/env stays a dev fallback.
      getToken: async () =>
        (await desktopPlatform.remoteAuth?.getAccessToken?.().catch(() => undefined)) ??
        settings.remoteAuthorityToken,
      webSocketOnly: true,
    });
    setAuthority(next);
    return () => {
      next?.stop().catch(() => {});
    };
  }, [settings.remoteEnabled, settings.remoteAuthorityUrl, settings.remoteAuthoritySession, settings.remoteAuthorityToken, remoteAuthState]);
  const platform = useMemo(
    () => (authority ? withAuthorityReflect(authority, desktopPlatform) : desktopPlatform),
    [authority],
  );

  if (isSettingsWindow) return <SettingsWindow />;

  return (
    <ShellApp
      backend={tauriBackend}
      services={tauriServices}
      platform={platform}
      fileReader={fileReader}
    />
  );
}
