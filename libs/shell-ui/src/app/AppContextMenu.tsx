import { useEffect, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { Trans } from '@lingui/react/macro';
import { ClipboardPaste, Copy, ExternalLink, FolderOpen, FolderSearch, RotateCw, Scissors, TextSelect } from 'lucide-react';
import type { ShellServices } from '@axn-term/session-backend';
import { ContextMenu, menuDividerClass, menuItemClass } from '../ContextMenu';
import { selectionResolver, terminalSelection, type SelectionResolver } from '../terminalRegistry';
import { wrappedSelectionCandidates } from '../terminalLinks';
import { revealLabel as defaultRevealLabel } from '../platform';

/** What the right-click landed on. */
export type AppMenuTarget =
  /** `selection` is captured as the menu opens — before anything can change it. */
  | { kind: 'terminal'; term: Terminal; selection: string }
  | { kind: 'editable'; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'other'; selection: string };

/** Classify a right-click target: terminal, text field, or anything else. */
export function appMenuTarget(
  target: EventTarget | null,
  terminalAt: (target: EventTarget | null) => Terminal | undefined,
): AppMenuTarget {
  const term = terminalAt(target);
  if (term) return { kind: 'terminal', term, selection: terminalSelection(term) };
  if (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && /^(text|search|url|email|password|number|)$/.test(target.type))
  ) {
    return { kind: 'editable', el: target };
  }
  return { kind: 'other', selection: window.getSelection()?.toString() ?? '' };
}

export interface SelectionTarget {
  path: string;
  isUrl: boolean;
  isDir: boolean;
}

/**
 * Aggressive path/URL check for a manual selection — the buffer's link
 * tokens miss plenty (agent TUIs draw text lookalikes and hard-wrap long
 * paths), so every plausible candidate is tried: the whole selection, each
 * whitespace token and line, the rows rejoined, and the soft-wrap rejoins
 * the link scanner itself uses.
 */
export async function resolveSelectionTarget(
  resolve: SelectionResolver,
  selection: string,
): Promise<SelectionTarget | null> {
  const candidates = new Set<string>();
  const add = (t: string) => {
    const s = t
      .trim()
      .replace(/^[.,;:'"()[\]{}<>*]+/, '')
      .replace(/[.,;:'"()[\]{}<>*@|=]+$/, '');
    if (s.length > 1) candidates.add(s);
  };
  add(selection);
  for (const tok of selection.split(/\s+/)) add(tok);
  for (const line of selection.split('\n')) add(line);
  add(selection.split('\n').map((l) => l.trim()).join(''));
  for (const c of wrappedSelectionCandidates(selection)) add(c);
  for (const c of candidates) {
    const hit = await resolve(c);
    if (hit) return { path: hit.stat.path, isUrl: hit.isUrl, isDir: hit.stat.isDir };
  }
  return null;
}

/**
 * The app-wide right-click menu, replacing the webview's native one wherever
 * no view handles the click itself: copy/paste in terminals (paste goes into
 * the shell under the pointer) and text fields, plus "Reload window".
 */
export function AppContextMenu({
  x,
  y,
  target,
  services,
  reloadShortcut,
  onReload,
  onClose,
}: {
  x: number;
  y: number;
  target: AppMenuTarget;
  services: ShellServices;
  reloadShortcut: string;
  onReload: () => void;
  onClose: () => void;
}) {
  const run = (action: () => void | Promise<void>) => () => {
    onClose();
    void action();
  };
  const paste = services.pasteText;

  // A manual selection may be a path/URL the token scan never linked —
  // resolve it and add the same Open/Reveal actions the hover card offers.
  const termTarget = target.kind === 'terminal' ? target : null;
  const [selTarget, setSelTarget] = useState<SelectionTarget | null>(null);
  useEffect(() => {
    setSelTarget(null);
    const resolve = termTarget ? selectionResolver(termTarget.term) : undefined;
    const sel = termTarget?.selection.trim() ?? '';
    if (!resolve || sel.length < 2) return;
    let live = true;
    void resolveSelectionTarget(resolve, sel).then((hit) => {
      if (live) setSelTarget(hit);
    });
    return () => {
      live = false;
    };
  }, [termTarget?.term, termTarget?.selection]);
  const row = (
    key: string,
    icon: React.ReactNode,
    label: React.ReactNode,
    action: () => void | Promise<void>,
    disabled = false,
  ) => (
    <button
      key={key}
      type="button"
      disabled={disabled}
      onClick={run(action)}
      className={`${menuItemClass} disabled:pointer-events-none disabled:opacity-40`}
    >
      {icon}
      {label}
    </button>
  );
  const icon = 'h-3.5 w-3.5 shrink-0';

  let rows: React.ReactNode[] = [];
  if (target.kind === 'terminal') {
    const { term, selection } = target;
    const revealText = services.revealLabel ?? defaultRevealLabel;
    const targetRows = selTarget
      ? [
          selTarget.isUrl
            ? row('open-link', <ExternalLink className={icon} />, <Trans>Open link</Trans>, () =>
                services.openExternal(selTarget.path),
              )
            : null,
          !selTarget.isUrl && selTarget.isDir && services.openDirectory
            ? row('open-dir', <FolderOpen className={icon} />, <Trans>Open</Trans>, () =>
                services.openDirectory?.(selTarget.path),
              )
            : null,
          !selTarget.isUrl && services.revealPath
            ? row('reveal', <FolderSearch className={icon} />, revealText, () =>
                services.revealPath?.(selTarget.path),
              )
            : null,
          <div key="sel-sep" className={menuDividerClass} />,
        ].filter(Boolean)
      : [];
    rows = [
      ...targetRows,
      row('copy', <Copy className={icon} />, <Trans>Copy</Trans>, () => services.copyText(selection), !selection),
      paste &&
        row('paste', <ClipboardPaste className={icon} />, <Trans>Paste</Trans>, async () => {
          const text = await paste();
          // term.paste honours bracketed-paste mode and feeds the PTY.
          if (text) term.paste(text);
          term.focus();
        }),
      row('select-all', <TextSelect className={icon} />, <Trans>Select all</Trans>, () => term.selectAll()),
    ];
  } else if (target.kind === 'editable') {
    const { el } = target;
    const selected = () => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    const hasSelection = (el.selectionEnd ?? 0) > (el.selectionStart ?? 0);
    rows = [
      row('cut', <Scissors className={icon} />, <Trans>Cut</Trans>, async () => {
        await services.copyText(selected());
        el.focus();
        // execCommand edits go through the input's own change events, so
        // React-controlled fields stay in sync.
        document.execCommand('delete');
      }, !hasSelection || el.readOnly),
      row('copy', <Copy className={icon} />, <Trans>Copy</Trans>, () => services.copyText(selected()), !hasSelection),
      paste &&
        row('paste', <ClipboardPaste className={icon} />, <Trans>Paste</Trans>, async () => {
          const text = await paste();
          el.focus();
          if (text) document.execCommand('insertText', false, text);
        }, el.readOnly),
      row('select-all', <TextSelect className={icon} />, <Trans>Select all</Trans>, () => {
        el.focus();
        el.select();
      }),
    ];
  } else if (target.selection) {
    const text = target.selection;
    rows = [row('copy', <Copy className={icon} />, <Trans>Copy</Trans>, () => services.copyText(text))];
  }

  const visible = rows.filter(Boolean);
  return (
    <ContextMenu x={x} y={y} onClose={onClose} widthClass="w-48" className="rounded-[var(--radius-lg)] bg-[var(--elevated)] p-1 shadow-[var(--shadow-pop)]">
      {visible}
      {visible.length > 0 && <div className={menuDividerClass} />}
      <button type="button" onClick={run(onReload)} className={menuItemClass}>
        <RotateCw className={icon} />
        <span className="flex-1">
          <Trans>Reload window</Trans>
        </span>
        <span className="text-[11px] text-[var(--text-secondary)]">{reloadShortcut}</span>
      </button>
    </ContextMenu>
  );
}
