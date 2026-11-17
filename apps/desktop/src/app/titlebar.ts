import { getCurrentWindow } from '@tauri-apps/api/window';

const isMac =
  /mac/i.test(navigator.platform ?? '') || /macintosh|mac os x/i.test(navigator.userAgent);

/**
 * macOS app windows use an overlay title bar (src-tauri/src/window.rs): the
 * webview reaches the top edge and the traffic lights sit inside the app's
 * first toolbar row. `data-titlebar="overlay"` on the document tells the
 * shared stylesheet to reserve room for them (--titlebar-h,
 * --titlebar-overhang).
 *
 * Not set for the Preferences window (it keeps a native title bar) and
 * cleared in fullscreen, where the lights are hidden.
 */
export function initTitlebar(): void {
  if (!isMac) return;
  let win: ReturnType<typeof getCurrentWindow>;
  try {
    win = getCurrentWindow();
  } catch {
    return;
  }
  if (win.label !== 'main' && !win.label.startsWith('w-')) return;

  const root = document.documentElement;
  const sync = () =>
    win
      .isFullscreen()
      .then((fullscreen) => {
        root.dataset.titlebar = fullscreen ? 'none' : 'overlay';
      })
      .catch(() => {});
  root.dataset.titlebar = 'overlay';
  void sync();
  void win.onResized(() => void sync()).catch(() => {});
}
