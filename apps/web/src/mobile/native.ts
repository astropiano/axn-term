import { Capacitor, registerPlugin } from '@capacitor/core';
import { parseAnnouncement, type AnnouncedDesktop, type KnownServer } from '@axn-term/session-backend';

/** Running inside the Capacitor app (vs. a plain browser preview). */
export const isNative = Capacitor.isNativePlatform();

interface RawService {
  name: string;
  host?: string;
  port?: number;
  txt: Record<string, string>;
}

/** apps/mobile/android/…/NsdPlugin.java */
const Nsd = registerPlugin<{ discover(options: { timeoutMs: number }): Promise<{ services: RawService[] }> }>('Nsd');

/**
 * Desktops announcing `_axn-term._tcp` on this Wi-Fi (Android NsdManager
 * through the app's Nsd plugin). One entry per desktop id —
 * a desktop seen on two interfaces is still one desktop.
 */
export async function discoverDesktops(timeoutMs = 3500): Promise<AnnouncedDesktop[]> {
  if (!isNative) return [];
  const { services } = await Nsd.discover({ timeoutMs });
  const byId = new Map<string, AnnouncedDesktop>();
  for (const s of services) {
    const desktop = parseAnnouncement(s.txt, s.host);
    if (!desktop) continue;
    byId.set(desktop.desktopId ?? `${desktop.server}|${s.name}`, { ...desktop, name: desktop.name ?? s.name });
  }
  return [...byId.values()];
}

/** Scan a pairing QR code; null when cancelled or no camera permission. */
export async function scanPairingCode(): Promise<string | null> {
  if (!isNative) return null;
  const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import(
    '@capacitor/barcode-scanner'
  );
  // The plugin asks for the camera itself; cancelling rejects.
  const result = await CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    scanInstructions: 'Scan the code from axn-term on your computer (Remote → Connect a phone)',
  }).catch(() => null);
  return result?.ScanResult || null;
}

/* ── The server this app is paired with ─────────────────────────────── */

const SERVER_KEY = 'axn-mobile:server';

export function loadServer(): KnownServer | null {
  try {
    const s = JSON.parse(localStorage.getItem(SERVER_KEY) ?? 'null') as KnownServer | null;
    return s?.id && Array.isArray(s.endpoints) ? s : null;
  } catch {
    return null;
  }
}

export function saveServer(server: KnownServer): void {
  try {
    localStorage.setItem(SERVER_KEY, JSON.stringify(server));
  } catch {
    // storage unavailable — pairing lasts for this run only
  }
}

export function forgetServer(): void {
  try {
    localStorage.removeItem(SERVER_KEY);
  } catch {
    // ignore
  }
}
