type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/**
 * The app-wide session/workspace/tab navigation shortcuts handled on
 * `window` by ShellApp: `Ctrl/⌘+Alt+←/→/↑/↓` (tabs, sessions) and
 * `Ctrl/⌘+Alt+Shift+↑/↓` (workspaces). xterm turns these into escape
 * sequences and stops propagation, so terminals must let them through
 * (custom key handler → false) for the shortcuts to work while focused.
 */
export function isAppNavigationShortcut(event: ShortcutKeyEvent): boolean {
  if (!event.altKey || (!event.metaKey && !event.ctrlKey)) return false;
  if (event.shiftKey) return event.key === 'ArrowUp' || event.key === 'ArrowDown';
  return (
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight'
  );
}
