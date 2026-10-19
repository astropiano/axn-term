import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorTab } from '../types';
import type { EditorHandle } from './EditorView';

/** Shared by session tabs and plugin-hosted editors. */
export function useEditorClose() {
  const editors = useRef(new Map<string, EditorHandle>());
  const [pending, setPending] = useState<{ tab: EditorTab; close: () => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const registerEditor = useCallback((id: string, handle: EditorHandle | null) => {
    if (handle) editors.current.set(id, handle);
    else editors.current.delete(id);
  }, []);
  const requestClose = useCallback((tab: EditorTab, close: () => void) => {
    if (busy.current) return;
    const handle = editors.current.get(tab.id);
    if ((tab.kind ?? 'editor') !== 'editor' || !(handle?.isDirty() ?? tab.dirty)) {
      close();
      return;
    }
    setError(null);
    setPending({ tab, close });
  }, []);
  useEffect(() => {
    if (!pending) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!busy.current) setPending(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [pending]);
  const saveAndClose = async () => {
    if (!pending || busy.current) return;
    const handle = editors.current.get(pending.tab.id);
    if (!handle) {
      setError('This editor is unavailable. Cancel to return to the file, or discard its changes.');
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      const saved = await handle.save();
      if (saved && editors.current.get(pending.tab.id) === handle && !handle.isDirty()) {
        pending.close();
        setPending(null);
      } else {
        setError('The file has unsaved changes. Check the editor for a save error and try again.');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const dialog = pending && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div role="dialog" aria-modal="true" aria-labelledby="unsaved-editor-title"
        className="w-full max-w-md rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] p-5 text-[var(--text-primary)] shadow-xl"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
        <h2 id="unsaved-editor-title" className="font-semibold">Save changes before closing?</h2>
        <p className="my-3 break-all text-sm">{pending.tab.path}</p>
        {error && <p role="alert" className="my-3 text-sm text-[var(--red)]">{error}</p>}
        <div className="flex justify-end gap-3 text-sm">
          <button autoFocus disabled={saving} onClick={() => setPending(null)}>Cancel</button>
          <button disabled={saving} onClick={() => { pending.close(); setPending(null); }}>Discard</button>
          <button disabled={saving} onClick={() => void saveAndClose()}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
  return { registerEditor, requestClose, dialog };
}
