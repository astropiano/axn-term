import { useCallback, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ShellApp, useSettings } from '@axn-term/shell-ui';
import { tauriBackend, tauriServices, tauriFileReader } from '@axn-term/session-backend/tauri';
import { desktopPlatform } from './platform';
import { createRemoteAuthority, withAuthorityReflect } from './remoteAuthority';

export default function App() {
  // Desktop fileReader: the app shares the host filesystem, so the session
  // id is ignored — reads/writes go through the Tauri fs plugin.
  const fileReader = useCallback(() => tauriFileReader(), []);

  // The fs capability only covers $HOME; `fileAccessRoots` in config.yaml
  // widens it at runtime (e.g. repos on an external volume).
  const { settings } = useSettings();
  const fileAccessRoots = (settings.fileAccessRoots ?? []).join('\n');
  useEffect(() => {
    const roots = fileAccessRoots.split('\n').filter(Boolean);
    if (roots.length === 0) return;
    invoke('allow_file_roots', { roots }).catch((e) =>
      console.error('allow_file_roots failed', e),
    );
  }, [fileAccessRoots]);

  // Opt-in remote authority (VITE_REMOTE_AUTHORITY_URL): publishes this
  // window's terminals to a client-authoritative hub so remote viewers can
  // drive the desktop's PTYs through the mirrored session.
  const authority = useMemo(() => createRemoteAuthority(), []);
  const platform = useMemo(
    () => (authority ? withAuthorityReflect(authority, desktopPlatform) : desktopPlatform),
    [authority],
  );

  return (
    <ShellApp
      backend={tauriBackend}
      services={tauriServices}
      platform={platform}
      fileReader={fileReader}
    />
  );
}
