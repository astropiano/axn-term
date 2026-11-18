import { useCallback, useImperativeHandle, useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from 'react';
import { PanelLeft } from 'lucide-react';
import { BrowserView } from './BrowserView';
import { EditorView, type EditorHandle } from './EditorView';
import type { FileService } from './fileService';
import { useCoarsePointer, useMediaQuery } from '../useMediaQuery';
import { IDE_TREE_DEFAULT_WIDTH, clampTreeWidth, storeTreeWidth, storedTreeWidth } from './ideTreeWidth';

interface IdeViewProps {
  /**
   * Aggregate handle across all open files — isDirty() reports any unsaved
   * buffer, save() saves every dirty one. Wired into the shared close-
   * confirm flow via `registerEditor`.
   */
  ref?: Ref<EditorHandle>;
  /** Root directory of the tree (already resolved). */
  path: string;
  cwd?: string;
  isVisible?: boolean;
  sessionId?: string;
  fileService: FileService;
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * IDE-style composite tab: file tree left, editor right. The tree is an
 * inline column on `sm:` and up, resizable by dragging its right edge (the
 * width is remembered; a double-click resets it), so deep or wide folders
 * fit; on small screens it becomes a slide-over
 * drawer (the session-panel pattern) toggled by a top-bar button — the
 * component owns its responsive layout so the tab model stays untouched.
 *
 * Every opened file keeps a mounted-but-hidden EditorView, so switching
 * files never loses an unsaved buffer and no save prompt is needed on
 * switch — only on closing the tab itself (aggregated handle).
 */
export function IdeView({
  ref,
  path,
  cwd,
  isVisible,
  sessionId,
  fileService,
  onDirtyChange,
}: IdeViewProps) {
  const coarsePointer = useCoarsePointer();
  const wide = useMediaQuery('(min-width: 640px)');
  const [treeOpen, setTreeOpen] = useState(false);
  const [treeWidth, setTreeWidth] = useState(storedTreeWidth);
  const viewRef = useRef<HTMLDivElement>(null);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const handlesRef = useRef(new Map<string, EditorHandle>());
  const dirtyRef = useRef(new Map<string, boolean>());
  const anyDirtyRef = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const selectFile = useCallback((p: string) => {
    setOpenFiles((files) => (files.includes(p) ? files : [...files, p]));
    setActiveFile(p);
    setTreeOpen(false);
  }, []);

  // Drag the tree's right edge: pointer capture keeps the drag alive over the
  // editor (Monaco would otherwise swallow the moves).
  const startTreeResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = treeWidth;
    const viewWidth = viewRef.current?.getBoundingClientRect().width ?? 0;
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = clampTreeWidth(startWidth + ev.clientX - startX, viewWidth);
      setTreeWidth(width);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      storeTreeWidth(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }, [treeWidth]);

  const resetTreeWidth = useCallback(() => {
    setTreeWidth(IDE_TREE_DEFAULT_WIDTH);
    storeTreeWidth(IDE_TREE_DEFAULT_WIDTH);
  }, []);

  const fileDirty = useCallback((p: string, dirty: boolean) => {
    dirtyRef.current.set(p, dirty);
    const any = [...dirtyRef.current.values()].some(Boolean);
    if (any !== anyDirtyRef.current) {
      anyDirtyRef.current = any;
      onDirtyChangeRef.current?.(any);
    }
  }, []);

  const handleRef = useRef<EditorHandle>({
    isDirty: () => anyDirtyRef.current,
    save: async () => {
      let ok = true;
      for (const [p, dirty] of dirtyRef.current) {
        if (!dirty) continue;
        const handle = handlesRef.current.get(p);
        if (handle && !(await handle.save())) ok = false;
      }
      return ok;
    },
  });
  useImperativeHandle(ref, () => handleRef.current, []);

  const tree = (
    <BrowserView
      path={path}
      cwd={cwd}
      sessionId={sessionId}
      isVisible={isVisible && (wide || treeOpen)}
      onOpenFile={selectFile}
      alwaysShowHidden
      openOnSelect
    />
  );

  return (
    <div ref={viewRef} className="relative flex h-full w-full bg-[var(--terminal-bg)]">
      {/* Inline tree column on sm+, resizable from its right edge */}
      {wide && (
        <>
          <div className="min-w-0 shrink-0" style={{ width: treeWidth }}>
            {tree}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            data-tip="Drag to resize · double-click to reset"
            onPointerDown={startTreeResize}
            onDoubleClick={resetTreeWidth}
            className="w-1 shrink-0 cursor-ew-resize touch-none select-none border-r border-[var(--border)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)]"
          />
        </>
      )}
      {/* Slide-over drawer on small screens (session-panel pattern) */}
      {!wide && treeOpen && (
        <>
          <div
            className="absolute inset-0 z-30 bg-black/20"
            onClick={() => setTreeOpen(false)}
          />
          <div className="absolute bottom-0 left-0 top-0 z-40 w-64 max-w-[85vw] shadow-lg">
            {tree}
          </div>
        </>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!wide && (
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
            <button
              type="button"
              onClick={() => setTreeOpen((open) => !open)}
              data-tip="Files"
              aria-label="Files"
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)]"
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-secondary)]">
              {path}
            </span>
          </div>
        )}
        <div className="relative min-h-0 flex-1">
          {openFiles.map((f) => (
            <div key={f} className={f === activeFile ? 'h-full w-full' : 'hidden'}>
              <EditorView
                ref={(handle) => {
                  if (handle) handlesRef.current.set(f, handle);
                  else handlesRef.current.delete(f);
                }}
                path={f}
                isVisible={isVisible && f === activeFile}
                fileService={fileService}
                onDirtyChange={(dirty) => fileDirty(f, dirty)}
              />
            </div>
          ))}
          {!activeFile && (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[var(--text-secondary)]">
              {coarsePointer || !wide
                ? 'Tap the tree button and pick a file'
                : 'Select a file from the tree to edit'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
