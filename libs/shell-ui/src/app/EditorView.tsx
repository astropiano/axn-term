import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Save, Search } from 'lucide-react';
import { useSettings } from '../SettingsProvider';
import { monaco, applyAxnMonacoTheme, languageForPath, AXN_MONACO_THEME } from './monacoSetup';
import { resolvePath, type FileService } from './fileService';
import { registerViewFocus } from './viewFocus';
import { isMac } from '../platform';

const saveTip = isMac ? 'Save (⌘S / Ctrl+S)' : 'Save (Ctrl+S)';
const findTip = isMac ? 'Find (⌘F / Ctrl+F)' : 'Find (Ctrl+F)';

export interface EditorHandle {
  isDirty(): boolean;
  save(): Promise<boolean>;
  focus(): void;
  /** Focus the editor and open Monaco's find widget. */
  find(): void;
}

interface EditorViewProps {
  ref?: Ref<EditorHandle>;
  path: string;
  cwd?: string;
  isVisible?: boolean;
  fileService: FileService;
  onDirtyChange?: (dirty: boolean) => void;
  /** Register the editor as the tab's focus target for session/tab switching. */
  focusId?: string;
  /**
   * Shift+find (`⇧⌘F`/`Ctrl+Shift+F`) — a container-wide search owned by the
   * parent (the IDE view's folder tree); absent when there is none.
   */
  onGlobalSearch?: () => void;
}

export function EditorView({ ref, path, cwd, isVisible, fileService, onDirtyChange, focusId, onGlobalSearch }: EditorViewProps) {
  // Resolve relative paths once per file, against the directory at open time.
  // A session's live cwd is not part of an already-open buffer's identity.
  const fileRef = useRef({ path, resolvedPath: resolvePath(cwd, path) });
  if (fileRef.current.path !== path) {
    fileRef.current = { path, resolvedPath: resolvePath(cwd, path) };
  }
  const resolvedPath = fileRef.current.resolvedPath;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Saving is only allowed once the file was read: after a failed read the
  // buffer is empty, and writing it would truncate the file.
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onGlobalSearchRef = useRef(onGlobalSearch);
  onGlobalSearchRef.current = onGlobalSearch;
  // Callers build the FileService inline, so it changes identity on every
  // render; keep it in a ref so the mount effect below doesn't tear down
  // and recreate the editor on every parent re-render.
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;
  const { activeTheme } = useSettings();

  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
    onDirtyChangeRef.current?.(value);
  }, []);

  const save = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor || savingRef.current || !loadedRef.current) return false;
    const contents = editor.getValue();
    savingRef.current = true;
    setSaving(true);
    try {
      await fileServiceRef.current.writeFile(resolvedPath, undefined, contents);
      if (editorRef.current !== editor) return false;
      const changed = editor.getValue() !== contents;
      markDirty(changed);
      setError(null);
      return !changed;
    } catch (e) {
      if (editorRef.current === editor) setError(String(e));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [resolvedPath, markDirty]);
  const saveRef = useRef(save);
  saveRef.current = save;
  // Parent dirty-state updates replace callback refs. Keep the registered
  // handle stable so an in-flight Save-and-close still targets this editor.
  const handleRef = useRef<EditorHandle>({
    isDirty: () => dirtyRef.current,
    save: () => saveRef.current(),
    focus: () => editorRef.current?.focus(),
    find: () => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      editor.getAction('actions.find')?.run();
    },
  });
  useImperativeHandle(ref, () => handleRef.current, []);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    loadedRef.current = false;
    setLoaded(false);

    applyAxnMonacoTheme(activeTheme);
    const editor = monaco.editor.create(containerRef.current, {
      value: '',
      language: languageForPath(path),
      theme: AXN_MONACO_THEME,
      automaticLayout: false,
      fontSize: 13,
      fontFamily:
        '"Monaspace Neon Var", "Monaspace Neon", "Fira Code", "Cascadia Code", monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      readOnly: true,
    });
    editorRef.current = editor;

    // automaticLayout is off (it polls) — relayout on real container size
    // changes instead: orientation flips, sidebar toggles, keyboard open.
    const container = containerRef.current;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => editor.layout())
        : null;
    if (container) resizeObserver?.observe(container);

    const changeSub = editor.onDidChangeModelContent(() => {
      if (!dirtyRef.current) markDirty(true);
    });

    // CtrlCmd is Cmd on macOS / Ctrl elsewhere; WinCtrl is Ctrl on
    // macOS+Linux / Win on Windows — together both ⌘S and Ctrl+S save.
    const saveKey = () => void saveRef.current();
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveKey);
    editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS, saveKey);
    // ⇧⌘F / Ctrl+Shift+F while typing bubbles out as the container-wide
    // search (IDE folder tree) — standalone Monaco has no binding for it.
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      () => onGlobalSearchRef.current?.(),
    );

    fileServiceRef.current
      .readFile(resolvedPath)
      .then((contents) => {
        if (disposed) return;
        editor.setValue(contents);
        markDirty(false);
        editor.updateOptions({ readOnly: false });
        loadedRef.current = true;
        setLoaded(true);
      })
      .catch((e) => {
        if (!disposed) setError(`${String(e)} (not loaded, saving disabled)`);
      });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      changeSub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [resolvedPath, markDirty]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    applyAxnMonacoTheme(activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    if (isVisible && editorRef.current) {
      editorRef.current.layout();
    }
  }, [isVisible]);

  // The tab's focus target for app navigation — session/tab switching
  // shortcuts land here instead of leaving focus in the panel.
  useEffect(() => {
    if (!focusId) return;
    return registerViewFocus(focusId, () => editorRef.current?.focus());
  }, [focusId]);

  return (
    <div
      className="flex h-full w-full flex-col bg-[var(--terminal-bg)]"
      // Monaco's own bindings only fire while its textarea is focused; this
      // catches ⌘S/Ctrl+S and ⌘F/Ctrl+F pressed with focus anywhere else in
      // the view (⇧⌘F delegates to the container-wide search, if any).
      onKeyDown={(event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        const key = event.key.toLowerCase();
        if (key === 's' && !event.shiftKey) {
          event.preventDefault();
          void saveRef.current();
        } else if (key === 'f' && !event.shiftKey) {
          event.preventDefault();
          handleRef.current.find();
        } else if (key === 'f' && event.shiftKey && onGlobalSearchRef.current) {
          event.preventDefault();
          onGlobalSearchRef.current();
        }
      }}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">
          {path}
        </span>
        {dirty && <span className="h-2 w-2 rounded-full bg-[var(--orange)]" data-tip="Unsaved" />}
        {error && (
          <span className="truncate text-[11px] text-[var(--red)]" data-tip={error}>
            {error}
          </span>
        )}
        <button
          type="button"
          // Monaco's find contribution is always bundled — this is just the
          // discoverable/touch trigger for it (mobile has no ⌘F).
          onClick={() => {
            const editor = editorRef.current;
            if (editor) {
              editor.focus();
              editor.getAction('actions.find')?.run();
            }
          }}
          disabled={!!error}
          data-tip={findTip}
          aria-label={findTip}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !loaded}
          data-tip={saveTip}
          aria-label={saveTip}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" />
        </button>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
