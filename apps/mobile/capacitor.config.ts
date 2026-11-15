import type { CapacitorConfig } from '@capacitor/cli';

/**
 * axn-term mobile: the web viewer (apps/web, `vite build --mode mobile`) in a
 * Capacitor shell, plus a native plugin that finds desktops on the Wi-Fi
 * (android/…/NsdPlugin.java). Build in a container: build/android/build.sh.
 */
const config: CapacitorConfig = {
  appId: 'dev.axnterm.mobile',
  appName: 'axn-term',
  webDir: '../../dist/apps/mobile',
  server: {
    // https://localhost — a secure context (PKCE needs crypto.subtle) and
    // the origin the server's Keycloak client allows for the app.
    androidScheme: 'https',
    // Sign-in is a full-page Keycloak redirect inside the webview; the
    // server's address is only known at runtime (typed, scanned, found on
    // the Wi-Fi), so no host list can be fixed here.
    allowNavigation: ['*'],
  },
  plugins: {
    // fetch/XHR over the native HTTP stack: no CORS between the app's
    // origin and the server, and the phone's trust settings (user CAs) apply.
    CapacitorHttp: { enabled: true },
  },
};

export default config;
