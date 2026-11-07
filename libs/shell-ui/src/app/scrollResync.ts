/**
 * WKWebView/WebKitGTK scrolled-layer desync workaround.
 *
 * Overflow areas scroll asynchronously on the compositor. When the window's
 * backing scale factor changes (moving it between a Retina and a non-Retina
 * screen), the scrolled layer can keep painting at its offset while the web
 * process's scroll offset goes stale — clicks then hit-test ~scrollTop
 * above the pointer (WebKit bug 262287), and only re-scrolling repairs it.
 *
 * The painted position is not readable from JS — `scrollTop` and
 * `getBoundingClientRect` both report the web process's (stale) view — so
 * we cannot detect or restore the desynced position. What we can do is
 * issue real scroll requests, which rebuild the scroll state on both sides;
 * a desynced container settles at the top, same as the user's manual fix.
 */
const SCROLLER_SELECTOR =
  '.overflow-y-auto, .overflow-y-scroll, .overflow-auto, .overflow-scroll, .xterm-viewport';

export function resyncScrollPositions(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR)) {
    if (el.scrollHeight <= el.clientHeight) continue;
    const top = el.scrollTop;
    // Two writes in separate frames: same-task writes can collapse into a
    // single scroll request carrying the final value, which the scroll
    // machinery drops as a no-op — and a no-op never re-syncs anything.
    el.scrollTop = top > 0 ? top - 1 : 1;
    requestAnimationFrame(() => {
      el.scrollTop = top;
    });
  }
}
