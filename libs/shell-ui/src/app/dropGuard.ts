/**
 * Reject drag payloads that come from outside this window. Webviews
 * navigate to dropped content — a dropped image replaces the app surface,
 * a dropped URL navigates the whole window, a dropped text/URL payload
 * can trigger a load. A drag is allowed only when
 *   (a) it carries an `application/x-axn-*` type — the app's own session/
 *       workspace/tab drags, including drops arriving from another window
 *       (tear-off hand-over, where no local dragstart ever fired), or
 *   (b) it started inside this document — e.g. dragging selected terminal
 *       text into an editor or input; harmless by definition.
 * Everything else — Files, text/plain, text/uri-list, text/html arriving
 * from outside — is cancelled during capture so neither the webview's
 * default handling nor any component-level drop target ever sees it.
 */
export const INTERNAL_DRAG_TYPE_PREFIX = 'application/x-axn-';

export function isInternalDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types || types.length === 0) return false;
  for (const t of Array.from(types)) {
    if (!t.startsWith(INTERNAL_DRAG_TYPE_PREFIX)) return false;
  }
  return true;
}

/** Registers capture-phase drag guards on `win`; returns an uninstall. */
export function installDropGuard(win: Window): () => void {
  // `dragstart`/`dragend` are document-level signals — a drag that began
  // here may legitimately carry text/plain (selected text) or any other
  // payload its source attached.
  let startedHere = false;
  const markStart = () => {
    startedHere = true;
  };
  const markEnd = () => {
    startedHere = false;
  };
  const block = (e: DragEvent) => {
    if (startedHere || isInternalDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const types = ['dragenter', 'dragover', 'drop'] as const;
  win.addEventListener('dragstart', markStart, true);
  win.addEventListener('dragend', markEnd, true);
  for (const t of types) win.addEventListener(t, block, true);
  return () => {
    win.removeEventListener('dragstart', markStart, true);
    win.removeEventListener('dragend', markEnd, true);
    for (const t of types) win.removeEventListener(t, block, true);
  };
}
