import { createContext, useContext, type ReactNode } from 'react';
import type { FileReader, SessionBackend, ShellServices } from '@axn-term/session-backend';
import type { ShellPlatform } from './platform';

export interface ShellServicesContextValue {
  services: ShellServices;
  /**
   * File access for hover-card content previews. The concrete binding is
   * app-provided because reads are session-scoped (each session resolves
   * relative paths against its own live cwd).
   */
  fileReader: (sessionId?: string) => FileReader | undefined;
}

const ShellServicesContext = createContext<ShellServicesContextValue | null>(null);

export function ShellServicesProvider({
  services,
  fileReader,
  children,
}: ShellServicesContextValue & { children: ReactNode }) {
  return (
    <ShellServicesContext.Provider value={{ services, fileReader }}>
      {children}
    </ShellServicesContext.Provider>
  );
}

export function useShellServices(): ShellServicesContextValue {
  const ctx = useContext(ShellServicesContext);
  if (!ctx) throw new Error('useShellServices must be used within ShellServicesProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Backend context — every view under <ShellApp> can reach the session
// backend (PTY write/resize, fs ops, exec) without prop drilling.
// ---------------------------------------------------------------------------

const SessionBackendContext = createContext<SessionBackend | null>(null);

export function SessionBackendProvider({
  backend,
  children,
}: {
  backend: SessionBackend;
  children: ReactNode;
}) {
  return (
    <SessionBackendContext.Provider value={backend}>
      {children}
    </SessionBackendContext.Provider>
  );
}

export function useSessionBackend(): SessionBackend {
  const ctx = useContext(SessionBackendContext);
  if (!ctx) throw new Error('useSessionBackend must be used within SessionBackendProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Platform context — React access to ShellPlatform (homeDir, stores, window).
// The module-level `shellPlatform()` in platform.ts is for non-React helpers.
// ---------------------------------------------------------------------------

const ShellPlatformContext = createContext<ShellPlatform | null>(null);

export function ShellPlatformProvider({
  platform,
  children,
}: {
  platform: ShellPlatform;
  children: ReactNode;
}) {
  return (
    <ShellPlatformContext.Provider value={platform}>
      {children}
    </ShellPlatformContext.Provider>
  );
}

export function useShellPlatform(): ShellPlatform {
  const ctx = useContext(ShellPlatformContext);
  if (!ctx) throw new Error('useShellPlatform must be used within ShellPlatformProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Module-level handles for non-React code (HTML post-processors, log
// helpers). Bound once by the app at mount.
// ---------------------------------------------------------------------------

let boundServices: ShellServices | null = null;

/** Called once by ShellApp at mount. */
export function bindShellServices(services: ShellServices | null): void {
  boundServices = services;
}

export function shellServices(): ShellServices | null {
  return boundServices;
}
