import { useCallback, useMemo } from 'react';
import { ShellApp } from '@axn-term/shell-ui';
import { tauriBackend, tauriServices, tauriFileReader } from '@axn-term/session-backend/tauri';
import { desktopPlatform } from './platform';
import { createRemoteAuthority, withAuthorityReflect } from './remoteAuthority';

export default function App() {
  // Desktop fileReader: the app shares the host filesystem, so the session
  // id is ignored — reads/writes go through the Tauri fs plugin.
  const fileReader = useCallback(() => tauriFileReader(), []);

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
