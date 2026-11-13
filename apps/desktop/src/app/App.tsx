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
  useWindowIds,
  windowRank,
  remoteSessionName,
  resyncScrollPositions,
  isMac,
} from '@axn-term/shell-ui';
import { tauriBackend, tauriServices, tauriFileReader } from '@axn-term/session-backend/tauri';
import type { RemoteAuthority } from '@axn-term/session-backend/remote';
import { desktopPlatform } from './platform';
import { DevHmrWindow } from './DevHmr';
import { authorityStatus, createRemoteAuthority, withAuthorityReflect } from './remoteAuthority';
import { announce, refreshServer } from './remoteServer';

// Publish status is shown even while nothing publishes (not signed in,
// no server) — that is exactly when the user needs to see why.
desktopPlatform.remoteAuthorityStatus = authorityStatus;
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

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
// axn-term-hmr's control window (#axn-dev) — the dev-settings surface, not
// the terminal UI (that window loads the spawned vite server instead).
const isDevWindow = window.location.hash.includes('axn-dev');

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
    // Preferences… (⌘, / Ctrl+,): the native side picks the shell window
    // that shows the in-app settings dialog and targets only that window —
    // hence the window-scoped listener, not the global one.
    const pendingSettings = getCurrentWindow().listen('menu-settings', () => {
      window.dispatchEvent(new CustomEvent('axn:menu-settings'));
    });
    // WKWebView scrolled-layer desync (see scrollResync.ts): crossing a
    // Retina↔non-Retina screen boundary can leave hit-testing offset by
    // scrollTop. Nudge all scrollers when the scale factor flips — once now
    // and once shortly after, because the layer rebuild can land after the
    // event is delivered.
    const pendingScale = getCurrentWindow().onScaleChanged(() => {
      resyncScrollPositions();
      setTimeout(resyncScrollPositions, 300);
    });
    return () => {
      void pending.then((un) => un());
      void pendingReload.then((un) => un());
      void pendingSettings.then((un) => un());
      void pendingScale.then((un) => un());
    };
  }, [updateSettings]);

  // Linux/Windows keep the native menu bar hidden until Alt is tapped
  // (Thunderbird-style). Alt used as a modifier — Alt+key, Alt+Tab —
  // must not toggle: only a solo press-and-release of Alt does.
  useEffect(() => {
    if (isMac) return;
    let altSolo = false;
    const onKeyDown = (e: KeyboardEvent) => {
      altSolo =
        e.key === 'Alt' && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && altSolo && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        invoke('toggle_menu').catch((err) =>
          console.error('toggle_menu failed', err),
        );
      }
      if (e.key === 'Alt') altSolo = false;
    };
    const onBlur = () => {
      altSolo = false;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const fileAccessRoots = (settings.fileAccessRoots ?? []).join('\n');
  useEffect(() => {
    const roots = fileAccessRoots.split('\n').filter(Boolean);
    if (roots.length === 0) return;
    invoke('allow_file_roots', { roots }).catch((e) =>
      console.error('allow_file_roots failed', e),
    );
  }, [fileAccessRoots]);

  // Push the configured log level into the Rust file logger — the config
  // watch makes edits apply to the running app (LOG_LEVEL env wins at
  // process start; this command wins afterwards).
  useEffect(() => {
    invoke('set_log_level', { level: settings.logLevel ?? 'info' }).catch(() => {});
  }, [settings.logLevel]);

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
      () => {
        try {
          return desktopPlatform.remoteAuth?.get().state ?? 'signedOut';
        } catch {
          return 'signedOut';
        }
      },
      [],
    ),
  );
  // A published session needs a unique, stable device id on the shared
  // hub — two devices with the same id collide (the later hello wins the
  // session). This is device identity, not a user setting: a name field in
  // config.yaml invited exactly the multi-authority collision it caused,
  // so it lives in webview storage where nothing edits it.
  const [remoteDevice] = useState(() => {
    try {
      let id = localStorage.getItem('axn-remote-device');
      if (!id) {
        id = `host-${crypto.randomUUID().slice(0, 8)}`;
        localStorage.setItem('axn-remote-device', id);
      }
      return id;
    } catch {
      return `host-${crypto.randomUUID().slice(0, 8)}`;
    }
  });
  // Per-window authority session id: every window publishes its own
  // mirrored session — the shared base name alone would make all windows
  // fight over one session (the hub replaces authority on re-attach).
  // Rank = position in the live window set, so names compact when a lower
  // window closes (mac, mac-2, mac-3…).
  const windowId = desktopPlatform.window?.id ?? 'main';
  const liveWindowIds = useWindowIds(desktopPlatform.peers, windowId);
  const remoteSession = remoteSessionName(
    remoteDevice,
    windowRank(liveWindowIds, windowId),
  );

  // A server connected by address is re-resolved at startup, when the
  // network comes back and periodically: leaving the LAN for a tailnet (or
  // back) moves hub/issuer to the endpoint that answers — same server id,
  // same account, same mirrored session names. Only one window needs to do
  // it (config.yaml is shared): the lead window (rank 0) does.
  const isLeadWindow = windowRank(liveWindowIds, windowId) === 0;
  const remoteServerRef = useRef(settings);
  remoteServerRef.current = settings;
  useEffect(() => {
    if (!isLeadWindow || !settings.remoteServer || settings.remoteEnabled === false) return;
    let alive = true;
    const check = () =>
      void refreshServer(remoteServerRef.current)
        .then((patch) => {
          if (alive && patch) updateSettings(patch);
        })
        .catch(() => {});
    check();
    window.addEventListener('online', check);
    const timer = window.setInterval(check, 60_000);
    return () => {
      alive = false;
      window.removeEventListener('online', check);
      window.clearInterval(timer);
    };
  }, [isLeadWindow, settings.remoteServer?.id, settings.remoteEnabled, updateSettings]);

  // Announce this desktop on the local network while it publishes to a
  // known server, so a phone on the same Wi-Fi finds it.
  useEffect(() => {
    if (!isLeadWindow) return;
    announce(settings.remoteServer, remoteDevice, settings.remoteEnabled !== false);
  }, [isLeadWindow, settings.remoteServer, settings.remoteEnabled, remoteDevice]);
  useEffect(() => () => announce(undefined, remoteDevice, false), [remoteDevice]);

  // Sign-in-bound servers refuse an anonymous hello — connecting before
  // sign-in only produces a denied-and-retry loop. Wait for the sign-in
  // (a static dev token still publishes right away).
  const awaitingSignIn =
    Boolean(settings.remoteAuthIssuer) &&
    !settings.remoteAuthorityToken &&
    Boolean(desktopPlatform.remoteAuth) &&
    remoteAuthState !== 'signedIn';

  useEffect(() => {
    const hubConfigured = Boolean(
      settings.remoteAuthorityUrl || import.meta.env.VITE_REMOTE_AUTHORITY_URL,
    );
    if (settings.remoteEnabled === false || !hubConfigured) {
      setAuthority(undefined);
      authorityStatus.set('idle');
      return;
    }
    if (awaitingSignIn) {
      setAuthority(undefined);
      authorityStatus.set('idle', 'Sign in to publish this desktop');
      return;
    }
    // Remote publishing must never take the app down — any failure here
    // (malformed settings, connect throw, Reflect crash) degrades to
    // authority-undefined + 'failed', the shell keeps running.
    let next: RemoteAuthority | undefined;
    try {
      next = createRemoteAuthority({
        url: settings.remoteAuthorityUrl,
        session: remoteSession,
        token: settings.remoteAuthorityToken,
        // Signed-in account JWT wins; the static setting/env stays a dev fallback.
        getToken: async () =>
          (await desktopPlatform.remoteAuth?.getAccessToken?.().catch(() => undefined)) ??
          settings.remoteAuthorityToken,
        webSocketOnly: true,
        onSharedState: (key, data) => {
          // A remote viewer edited shared icons — persist into config.yaml.
          if (key !== 'app:icons') return;
          try {
            updateSettings({ customIcons: (data ? JSON.parse(data) : {}) as Record<string, string> });
          } catch {
            // opaque/invalid payload — ignore
          }
        },
      });
    } catch (e) {
      console.error('remote authority setup failed', e);
      authorityStatus.set('failed', e instanceof Error ? e.message : String(e));
    }
    setAuthority(next);
    return () => {
      next?.stop().catch(() => {});
    };
  }, [settings.remoteEnabled, settings.remoteAuthorityUrl, remoteSession, settings.remoteAuthorityToken, remoteAuthState, awaitingSignIn]);

  // Local xterm resizes join the claim set instead of writing the PTY
  // size directly — a viewer's smaller claim still wins, so the mirrored
  // geometry never flickers between the owner's size and a remote
  // claimant's ('sometimes the smallest wins' was this race).
  // The wrapper's identity MUST be stable: PTY leases are keyed on the
  // backend object (ptyLifetime WeakMap), so a swapped object makes the
  // mount effect release the lease and kill the real PTY — which is what
  // emptied the session list and auto-closed the app on every sign-in.
  const authorityRef = useRef<RemoteAuthority | undefined>(authority);
  authorityRef.current = authority;
  const arbitratedBackend = useMemo(
    () =>
      Object.assign(Object.create(Object.getPrototypeOf(tauriBackend)), tauriBackend, {
        resize: (clientId: string, cols: number, rows: number) => {
          const a = authorityRef.current;
          if (!a) {
            tauriBackend.resize(clientId, cols, rows);
            return;
          }
          try {
            a.claimOwnerSize(clientId, cols, rows);
          } catch {
            // Arbitration must never break local resizes.
            tauriBackend.resize(clientId, cols, rows);
          }
        },
      }),
    [],
  );
  const platform = useMemo(
    () => (authority ? withAuthorityReflect(authority, desktopPlatform) : desktopPlatform),
    [authority],
  );

  if (isDevWindow) return <DevHmrWindow />;
  if (isSettingsWindow) return <SettingsWindow />;

  return (
    <ShellApp
      backend={arbitratedBackend}
      services={tauriServices}
      platform={platform}
      fileReader={fileReader}
    />
  );
}
