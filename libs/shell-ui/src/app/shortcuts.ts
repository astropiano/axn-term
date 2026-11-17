type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> & {
  /** Physical key (`Digit1`) — optional so plain test objects still match. */
  code?: string;
};

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

/**
 * Reload the window: `⌘⇧R` (macOS) / `Ctrl+Shift+R`. Shift keeps it clear of
 * the shell's own Ctrl+R (reverse search) and of an accidental ⌘R. Like the
 * navigation shortcuts, terminals must let it through to ShellApp.
 */
export function isReloadShortcut(event: ShortcutKeyEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 'r'
  );
}

/**
 * Rail view shortcuts: `⌘1`…`⌘9` open the 1st…9th rail view (`Ctrl` instead
 * of `⌘` on Linux/Windows). Returns the 0-based position of the view, or
 * `null` when the event is not such a shortcut.
 *
 * `⌘0`/`Ctrl+0` is deliberately not part of it: the desktop app menu binds
 * it to View → Actual Size (zoom reset), so it never reaches the page.
 *
 * Only the platform's own modifier counts — on macOS `Ctrl+digit` stays with
 * the terminal — and no other modifier may be held. The digit is read from
 * the physical key first (`event.code`), so layouts whose number row needs
 * Shift (AZERTY) work too; `event.key` covers the numpad.
 *
 * Handled on `window` by ShellApp; like the navigation shortcuts, terminals
 * must let it through (custom key handler → false).
 */
export function railViewShortcutIndex(event: ShortcutKeyEvent, mac: boolean): number | null {
  const modifier = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.shiftKey) return null;
  const digit = /^Digit(\d)$/.exec(event.code ?? '')?.[1] ?? (/^\d$/.test(event.key) ? event.key : undefined);
  if (digit === undefined || digit === '0') return null;
  return Number(digit) - 1;
}

/**
 * The shortcut of the rail view at 0-based `index` as shown in tooltips
 * (`⌘3`, `Ctrl+3`), or `undefined` past the ninth view.
 */
export function railViewShortcutLabel(index: number, mac: boolean): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 8) return undefined;
  return mac ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

/** `aria-keyshortcuts` value for the rail view at `index`. */
export function railViewAriaShortcut(index: number, mac: boolean): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 8) return undefined;
  return `${mac ? 'Meta' : 'Control'}+${index + 1}`;
}

/**
 * Show/hide the session panel: `⌃⌘S` on macOS (the system's "Show/Hide
 * Sidebar"), `Ctrl+Shift+S` on Linux/Windows — clear of the shell's own
 * `Ctrl+S` (XOFF). Handled on `window` by ShellApp; terminals let it through.
 */
export function isPanelToggleShortcut(event: ShortcutKeyEvent, mac: boolean): boolean {
  const isS = event.key.toLowerCase() === 's' || event.code === 'KeyS';
  if (!isS || event.altKey) return false;
  return mac
    ? event.metaKey && event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
}

/** The panel toggle shortcut as shown in tooltips. */
export function panelToggleShortcutLabel(mac: boolean): string {
  return mac ? '⌃⌘S' : 'Ctrl+Shift+S';
}

/**
 * The window-chrome shortcuts ShellApp handles besides navigation and
 * reload: rail views and the panel toggle. Terminals use this (with the
 * other two checks) to let the keys bubble instead of sending them to the
 * shell.
 */
export function isAppChromeShortcut(event: ShortcutKeyEvent, mac: boolean): boolean {
  return railViewShortcutIndex(event, mac) !== null || isPanelToggleShortcut(event, mac);
}

/**
 * F2 renames the selected session. Only handled while focus is outside
 * terminals and text fields (`isTextEntryTarget`), so TUI programs such as
 * htop or mc keep their own F2.
 */
export function isRenameShortcut(event: ShortcutKeyEvent): boolean {
  return event.key === 'F2' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
}

/** Focus sits in a terminal or a text field: its keys belong to that element. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return el.closest('input, textarea, select, [contenteditable="true"], .xterm') !== null;
}
