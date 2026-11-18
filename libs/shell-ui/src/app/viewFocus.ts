/**
 * Focus registry for non-terminal views — the counterpart of
 * `terminalInputs` in `terminalRegistry.ts` (PTY views register their
 * `focus` there). Views that can take keyboard focus register a callback
 * under their tab id so app-level navigation — session/workspace/tab
 * switching shortcuts — can hand focus to whatever the session currently
 * shows: a Monaco editor, the file browser's list, a preview.
 */
const viewFocusers = new Map<string, () => void>();

/** Register `fn` as the focus target for `id`; returns the unsubscribe. */
export function registerViewFocus(id: string, fn: () => void): () => void {
  viewFocusers.set(id, fn);
  return () => {
    if (viewFocusers.get(id) === fn) viewFocusers.delete(id);
  };
}

/** Focus the view registered under `id`. False when none is registered. */
export function focusView(id: string): boolean {
  const fn = viewFocusers.get(id);
  if (!fn) return false;
  fn();
  return true;
}

/** Test hook: drop all registrations. */
export function resetViewFocus(): void {
  viewFocusers.clear();
}
