import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionBackend, useShellServices } from '../services';
import {
  GitBranch,
  GitCompareArrows,
  RefreshCw,
  Plus,
  Minus,
  FileDiff,
  Columns2,
  Rows2,
  Hourglass,
  Save,
  Sparkles,
} from 'lucide-react';
import { useSettings } from '../SettingsProvider';
import { usePluginSettings } from './PluginSettingsProvider';
import { ContextMenu, menuItemClass, menuDividerClass } from '../ContextMenu';
import {
  buildExplainPrompt,
  buildTalkPrompt,
  explainCommand,
  explainKeyForCommit,
  explainKeyForCommitFile,
  explainKeyForWorktreeFile,
  fnv1a,
  loadExplanations,
  normalizeReviewAgent,
  removeExplanation,
  saveExplanation,
  talkCommand,
} from './gitReview';
import type { Explanation, ExplanationMap, ReviewAgent } from './gitReview';
import { monaco, applyAxnMonacoTheme, languageForPath, AXN_MONACO_THEME } from './monacoSetup';
import { backendFileService } from './fileService';
import { GitGraph } from './GitGraph';
import {
  assignLanes,
  gitBackendHandle, git,
  parseLog,
  parseNameStatusZ,
  parsePorcelainZ,
  splitStatus,
  LOG_FORMAT,
} from './gitClient';
import type { CommitFile, GitCommit, StatusFile, WorktreeStatus } from './gitClient';
import { ptyIdOf } from '../types';
import type { EditorTab, ShellSession } from '../types';
import { isMac } from '../platform';

const diffSaveTip = isMac ? 'Save (⌘S / Ctrl+S)' : 'Save (Ctrl+S)';

const LOG_LIMIT = 400;
const MIN_HISTORY_H = 96;
const MAX_HISTORY_H = 560;

// ---------------------------------------------------------------------------
// Diff editor (Monaco)
// ---------------------------------------------------------------------------

interface DiffContent {
  title: string;
  language: string;
  original: string;
  modified: string;
  binary?: boolean;
  /** Message shown instead of the diff (identical files, nothing selected). */
  note?: string;
  /**
   * Absolute worktree path the modified side mirrors — set only when the
   * diff shows the live file on disk (unstaged/untracked/conflicted), making
   * the modified editor writable.
   */
  editablePath?: string;
}

/** Handle parents use to save pending diff edits before swapping views. */
interface DiffEditorApi {
  /** Write pending modified-side edits to disk; resolves immediately when clean. */
  flush(): Promise<void>;
}

/** A non-empty text selection in one of the diff editor's panes. */
export interface DiffSelection {
  text: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
}

function MonacoDiff({
  diff,
  sideBySide,
  onSave,
  apiRef,
  onDirtyChange,
  onDiscuss,
}: {
  diff: DiffContent;
  sideBySide: boolean;
  /** Persist modified-side edits (only passed when diff.editablePath is set). */
  onSave?: (contents: string) => Promise<void>;
  apiRef?: { current: DiffEditorApi | null };
  onDirtyChange?: (dirty: boolean) => void;
  /** Open an agent conversation about the selected text (review-agent talk). */
  onDiscuss?: (sel: DiffSelection) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  const { activeTheme } = useSettings();
  const { services } = useShellServices();
  const [menu, setMenu] = useState<ViewMenu | null>(null);
  const dirtyRef = useRef(false);
  /** Swallow the content-change event a model swap produces. */
  const suppressDirty = useRef(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const editablePathRef = useRef(diff.editablePath);
  editablePathRef.current = diff.editablePath;

  const saveRef = useRef(async () => {});
  saveRef.current = async () => {
    const editor = editorRef.current;
    if (!editor || !dirtyRef.current || !editablePathRef.current || !onSaveRef.current) return;
    try {
      await onSaveRef.current(editor.getModifiedEditor().getValue());
    } catch {
      return; // the parent surfaced the error; keep dirty so a retry is possible
    }
    dirtyRef.current = false;
    onDirtyChangeRef.current?.(false);
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { flush: () => saveRef.current() };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    if (!containerRef.current) return;
    applyAxnMonacoTheme(activeTheme);
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: AXN_MONACO_THEME,
      readOnly: true,
      originalEditable: false,
      // Monaco's own context menu offers "Go to Definition" etc. — nonsense
      // in a read-only diff. Disabled; a plain DOM menu is bound below.
      contextmenu: false,
      renderSideBySide: sideBySide,
      automaticLayout: true,
      fontSize: 13,
      fontFamily:
        '"Monaspace Neon Var", "Monaspace Neon", "Fira Code", "Cascadia Code", monospace',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8 },
      hideUnchangedRegions: { enabled: true },
    });
    editorRef.current = editor;
    const modifiedEditor = editor.getModifiedEditor();
    const changeSub = modifiedEditor.onDidChangeModelContent(() => {
      if (suppressDirty.current || dirtyRef.current || !editablePathRef.current) return;
      dirtyRef.current = true;
      onDirtyChangeRef.current?.(true);
    });
    // CtrlCmd is Cmd on macOS / Ctrl elsewhere; WinCtrl is Ctrl on
    // macOS+Linux / Win on Windows — together both ⌘S and Ctrl+S save.
    const saveKey = () => void saveRef.current();
    modifiedEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveKey);
    modifiedEditor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS, saveKey);
    return () => {
      changeSub.dispose();
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      modelsRef.current = null;
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    applyAxnMonacoTheme(activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  useEffect(() => {
    dirtyRef.current = false;
    onDirtyChangeRef.current?.(false);
    const editor = editorRef.current;
    if (!editor || diff.binary) return;
    suppressDirty.current = true;
    modelsRef.current?.original.dispose();
    modelsRef.current?.modified.dispose();
    const original = monaco.editor.createModel(diff.original, diff.language);
    const modified = monaco.editor.createModel(diff.modified, diff.language);
    modelsRef.current = { original, modified };
    editor.setModel({ original, modified });
    editor.updateOptions({ readOnly: !diff.editablePath });
    suppressDirty.current = false;
  }, [diff]);

  if (diff.binary) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-[var(--text-secondary)]">
        Binary file — no diff to display
      </div>
    );
  }
  if (diff.note) {
    return (
      <div className="flex h-full w-full items-center justify-center text-xs text-[var(--text-secondary)]">
        {diff.note}
      </div>
    );
  }
  return (
    <div
      className="h-full w-full"
      onContextMenu={(e) => {
        e.preventDefault();
        const editor = editorRef.current;
        if (!editor) return;
        const modified = editor.getModifiedEditor();
        const original = editor.getOriginalEditor();
        // The non-empty selection wins; right-clicking with no selection
        // still offers the whole-buffer copies.
        const selInfo = [modified, original]
          .map((ed, i): DiffSelection | null => {
            const sel = ed.getSelection();
            if (!sel || sel.isEmpty()) return null;
            const text = ed.getModel()?.getValueInRange(sel) ?? '';
            return text
              ? {
                  text,
                  side: i === 0 ? 'new' : 'old',
                  startLine: sel.startLineNumber,
                  endLine: sel.endLineNumber,
                }
              : null;
          })
          .find((s): s is DiffSelection => s != null);
        const selText = selInfo?.text ?? null;
        const items: ViewMenuItem[] = [
          {
            label: 'Copy selection',
            disabled: !selText,
            onClick: () => void services.copyText(selText!),
          },
          {
            label: 'Copy all (new)',
            onClick: () => void services.copyText(modified.getModel()?.getValue() ?? ''),
          },
          {
            label: 'Copy all (old)',
            onClick: () => void services.copyText(original.getModel()?.getValue() ?? ''),
          },
        ];
        if (onDiscuss) {
          items.push({
            label: 'Discuss this change',
            divider: true,
            disabled: !selInfo,
            onClick: () => selInfo && onDiscuss(selInfo),
          });
        }
        setMenu({ x: e.clientX, y: e.clientY, items });
      }}
    >
      <div ref={containerRef} className="h-full w-full" />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {menu.items.map((it, i) => (
            <button
              key={i}
              type="button"
              disabled={it.disabled}
              className={menuItemClass + (it.disabled ? ' opacity-40' : '')}
              onClick={() => {
                setMenu(null);
                it.onClick?.();
              }}
            >
              {it.label}
            </button>
          ))}
        </ContextMenu>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data loading helpers
// ---------------------------------------------------------------------------

async function showBlob(sessionId: string, root: string, spec: string): Promise<string | null> {
  try {
    return await git(sessionId, root, ['show', spec]);
  } catch {
    return null;
  }
}

async function readDisk(sessionId: string, root: string, path: string): Promise<string | null> {
  try {
    return await backendFileService(gitBackendHandle(), sessionId).readFile(path, root);
  } catch {
    return null;
  }
}

function isBinary(content: string | null): boolean {
  return content != null && (content.includes('\u0000') || content.includes('�'));
}

// -- review-agent diff sources -------------------------------------------------

/** Raw diff text for a worktree file — the prompt body for explain/talk. */
async function diffTextForWorktreeFile(
  sessionId: string,
  root: string,
  f: StatusFile,
  area: NonNullable<FileSel['area']>,
): Promise<string> {
  if (area === 'staged') return git(sessionId, root, ['diff', '--cached', '--', f.path]);
  if (area === 'unstaged' || area === 'conflicted')
    return git(sessionId, root, ['diff', '--', f.path]);
  const content = await readDisk(sessionId, root, f.path);
  return `new file ${f.path}:\n\n${content ?? '(file not readable)'}`;
}

/** Commit header + full patch — `git show` default format. */
async function diffTextForCommit(sessionId: string, root: string, c: GitCommit): Promise<string> {
  return git(sessionId, root, ['show', c.hash]);
}

/** Commit header + just this file's patch. */
async function diffTextForCommitFile(
  sessionId: string,
  root: string,
  sha: string,
  f: CommitFile,
): Promise<string> {
  return git(sessionId, root, ['show', sha, '--', f.path]);
}

function fileLetter(status: string): string {
  return status[0] ?? '?';
}

const LETTER_COLOR: Record<string, string> = {
  M: 'text-[var(--yellow)]',
  A: 'text-[var(--green)]',
  D: 'text-[var(--red)]',
  R: 'text-[var(--blue)]',
  C: 'text-[var(--blue)]',
  T: 'text-[var(--yellow)]',
  U: 'text-[var(--red)]',
  '?': 'text-[var(--orange)]',
};

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

type Selection = { kind: 'worktree' } | { kind: 'commit'; commit: GitCommit };

interface FileSel {
  path: string;
  oldPath?: string;
  /** Which worktree area the file was clicked in. */
  area?: 'staged' | 'unstaged' | 'untracked' | 'conflicted';
}

interface ViewMenuItem {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Render a divider above this item. */
  divider?: boolean;
}

interface ViewMenu {
  x: number;
  y: number;
  /** Optional dimmed header line (e.g. the clicked commit/file). */
  title?: string;
  items: ViewMenuItem[];
}

interface ExplainPop {
  x: number;
  y: number;
  key: string;
}

/** One explainable unit — a commit, a file in a commit, or a worktree file. */
interface ReviewTarget {
  /** Store key for the persisted explanation. */
  key: string;
  /** Short name for the agent sub-shell tab, e.g. "commit a1b2c3d". */
  name: string;
  /** Subject line inside the agent prompt. */
  subject: string;
  getDiff: () => Promise<string>;
}

export function GitInspectView({
  session,
  tab,
  isVisible,
  onOpenFile,
  onOpenSubShell,
}: {
  session: ShellSession;
  tab: EditorTab;
  isVisible: boolean;
  /** Opens a worktree file (absolute path) in an editor tab. */
  onOpenFile?: (path: string) => void;
  /** Opens a sub-shell tab running `command` in `cwd` (agent "talk" feature). */
  onOpenSubShell?: (command: string, cwd: string, label?: string, agent?: ReviewAgent) => void;
}) {
  const backend = useSessionBackend();
  const { services } = useShellServices();
  const root = tab.path;
  const base = tab.base?.trim() || undefined;
  const sessionId = session.id;
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>({ kind: 'worktree' });
  /**
   * `tab.base` compare target — resolved merge-base + commit count, or the
   * failure reason. Drives the "Changes vs <base>" section (three-dot diff,
   * i.e. what a merge request against that ref would introduce).
   */
  const [compare, setCompare] = useState<
    { base: string; mergeBase: string; commits: number } | { base: string; error: string } | null
  >(null);
  const [selFile, setSelFile] = useState<FileSel | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFile[]>([]);
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [historyH, setHistoryH] = useState(220);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [viewMenu, setViewMenu] = useState<ViewMenu | null>(null);
  const diffApiRef = useRef<DiffEditorApi | null>(null);
  const [diffDirty, setDiffDirty] = useState(false);
  const [diffSaving, setDiffSaving] = useState(false);
  const [explanations, setExplanations] = useState<ExplanationMap>({});
  const [pendingExplain, setPendingExplain] = useState<Set<string>>(new Set());
  const [explainPop, setExplainPop] = useState<ExplainPop | null>(null);
  const loadSeq = useRef(0);
  const selRef = useRef(sel);
  const selFileRef = useRef(selFile);
  selRef.current = sel;
  selFileRef.current = selFile;

  const hasChanges =
    !!status &&
    (status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0 ||
      status.conflicted.length > 0);

  // -- data loading ----------------------------------------------------------

  const refresh = useCallback(
    async (includeLog = true) => {
      try {
        const [statusOut, headOut, branchOut] = await Promise.all([
          git(sessionId, root, ['status', '--porcelain', '-z', '--untracked-files=all']),
          git(sessionId, root, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
          git(sessionId, root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
        ]);
        setStatus(splitStatus(parsePorcelainZ(statusOut)));
        setHead(headOut.trim() || null);
        setBranch(branchOut.trim() || null);
        // Compare target (merge-request style): merge-base(base, HEAD) vs
        // HEAD. Ref missing vs. no common ancestor get distinct messages.
        if (base) {
          const exists = await git(sessionId, root, [
            'rev-parse',
            '--verify',
            '--quiet',
            base,
          ]).catch(() => '');
          if (!exists.trim()) {
            setCompare({ base, error: `unknown ref: ${base}` });
          } else {
            const [mbOut, countOut] = await Promise.all([
              git(sessionId, root, ['merge-base', base, 'HEAD']).catch(() => ''),
              git(sessionId, root, ['rev-list', '--count', `${base}...HEAD`]).catch(
                () => '',
              ),
            ]);
            const mb = mbOut.trim();
            setCompare(
              mb
                ? { base, mergeBase: mb, commits: parseInt(countOut.trim(), 10) || 0 }
                : { base, error: `no common ancestor with ${base}` },
            );
          }
        } else {
          setCompare(null);
        }
        if (includeLog) {
          const logOut = await git(sessionId, root, [
            'log',
            '--all',
            'HEAD',
            '--topo-order',
            `-n${LOG_LIMIT}`,
            `--format=${LOG_FORMAT}`,
          ]).catch(() => '');
          setCommits(parseLog(logOut));
        }
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    },
    [root, base],
  );

  /**
   * Persist the diff editor's pending edits, if any. Called before the diff
   * is swapped for another file/commit so edits are never silently dropped.
   */
  const flushDiff = useCallback(async () => {
    try {
      await diffApiRef.current?.flush();
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const saveDiff = useCallback(
    async (contents: string) => {
      const editablePath = diff?.editablePath;
      if (!editablePath) return;
      setDiffSaving(true);
      try {
        await backendFileService(gitBackendHandle(), sessionId).writeFile(
          editablePath,
          root,
          contents,
        );
        setError(null);
        await refresh();
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setDiffSaving(false);
      }
    },
    [diff, root, refresh],
  );

  const loadWorktreeDiff = useCallback(
    async (f: StatusFile, area: NonNullable<FileSel['area']>) => {
      await flushDiff();
      const seq = ++loadSeq.current;
      const path = f.path;
      const oldPath = f.oldPath ?? f.path;
      let original = '';
      let modified: string | null = '';
      if (area === 'untracked') {
        modified = await readDisk(sessionId, root, path);
      } else if (area === 'staged') {
        original = (await showBlob(sessionId, root, `HEAD:${oldPath}`)) ?? '';
        modified =
          f.index === 'D' ? '' : ((await showBlob(sessionId, root, `:${path}`)) ?? (await readDisk(sessionId, root, path)));
      } else {
        original =
          (await showBlob(sessionId, root, `:${oldPath}`)) ??
          (await showBlob(sessionId, root, `HEAD:${oldPath}`)) ??
          '';
        modified = f.worktree === 'D' ? '' : await readDisk(sessionId, root, path);
      }
      if (seq !== loadSeq.current) return;
      const mod = modified ?? '';
      if (isBinary(original) || isBinary(mod)) {
        setDiff({ title: path, language: 'plaintext', original: '', modified: '', binary: true });
        return;
      }
      // The modified side mirrors the worktree file for unstaged/untracked/
      // conflicted rows — those are editable. Staged diffs show the index
      // blob, so editing there is not offered.
      const worktreeBacked =
        area === 'untracked' ||
        ((area === 'unstaged' || area === 'conflicted') && f.worktree !== 'D');
      setDiff({
        title:
          area === 'staged' ? `${path} — staged` : `${path} — working tree`,
        language: languageForPath(path),
        original,
        modified: mod,
        note: original === mod ? 'No differences' : undefined,
        editablePath:
          worktreeBacked && backend.writeFile ? `${root}/${path}` : undefined,
      });
    },
    [root, backend, flushDiff],
  );

  const loadCommitDiff = useCallback(
    async (commit: GitCommit, f: CommitFile) => {
      await flushDiff();
      const seq = ++loadSeq.current;
      const parent = commit.parents[0];
      const oldPath = f.oldPath ?? f.path;
      const original = parent
        ? ((await showBlob(sessionId, root, `${parent}:${oldPath}`)) ?? '')
        : '';
      const modified = f.status.startsWith('D')
        ? ''
        : ((await showBlob(sessionId, root, `${commit.hash}:${f.path}`)) ?? '');
      if (seq !== loadSeq.current) return;
      if (isBinary(original) || isBinary(modified)) {
        setDiff({ title: f.path, language: 'plaintext', original: '', modified: '', binary: true });
        return;
      }
      setDiff({
        title: `${f.path} @ ${commit.hash.slice(0, 7)}`,
        language: languageForPath(f.path),
        original,
        modified,
        note: original === modified ? 'No differences' : undefined,
      });
    },
    [root, flushDiff],
  );

  const selectCommit = useCallback(
    async (commit: GitCommit) => {
      setSel({ kind: 'commit', commit });
      setSelFile(null);
      // Flush before setDiff(null) unmounts the diff editor.
      await flushDiff();
      if (commit.hash === '') {
        setSel({ kind: 'worktree' });
        setDiff(null);
        return;
      }
      setDiff(null);
      try {
        const out =
          commit.parents.length > 0
            ? await git(sessionId, root, [
                'diff',
                '--name-status',
                '-z',
                commit.parents[0],
                commit.hash,
              ])
            : await git(sessionId, root, [
                'diff-tree',
                '--root',
                '--no-commit-id',
                '--name-status',
                '-r',
                '-z',
                commit.hash,
              ]);
        const files = parseNameStatusZ(out);
        setCommitFiles(files);
        if (files.length > 0) {
          const first = files[0];
          setSelFile({ path: first.path, oldPath: first.oldPath });
          void loadCommitDiff(commit, first);
        }
      } catch (e) {
        setError(String(e));
      }
    },
    [root, loadCommitDiff, flushDiff],
  );

  const selectWorktreeFile = useCallback(
    (f: StatusFile, area: NonNullable<FileSel['area']>) => {
      setSel({ kind: 'worktree' });
      setSelFile({ path: f.path, oldPath: f.oldPath, area });
      void loadWorktreeDiff(f, area);
    },
    [loadWorktreeDiff],
  );

  const selectCommitFile = useCallback(
    (f: CommitFile) => {
      if (sel.kind !== 'commit') return;
      setSelFile({ path: f.path, oldPath: f.oldPath });
      void loadCommitDiff(sel.commit, f);
    },
    [sel, loadCommitDiff],
  );

  // -- git actions -----------------------------------------------------------

  const runOp = useCallback(
    async (args: string[], includeLog = false) => {
      setBusy(true);
      setError(null);
      try {
        await git(sessionId, root, args);
        await refresh(includeLog);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [root, refresh],
  );

  const stage = (paths: string[]) => runOp(['add', '--', ...paths]);
  const unstage = (paths: string[]) => runOp(['restore', '--staged', '--', ...paths]);

  const doCommit = async () => {
    const msg = commitMsg.trim();
    const args = amend
      ? msg
        ? ['commit', '--amend', '-m', msg]
        : ['commit', '--amend', '--no-edit']
      : ['commit', '-m', msg];
    setBusy(true);
    setError(null);
    try {
      await git(sessionId, root, args);
      setCommitMsg('');
      setAmend(false);
      await refresh(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // -- agent review: explain / talk ------------------------------------------

  const { pluginSettings } = usePluginSettings();
  const reviewAgent: ReviewAgent | null = normalizeReviewAgent(
    (pluginSettings['git-inspect'] as { reviewAgent?: unknown } | undefined)?.reviewAgent,
  );
  const storage = services.storage;
  const canExplain = !!reviewAgent && !!backend.exec && !!storage;
  const canTalk = !!reviewAgent && !!onOpenSubShell;
  const explanationsRef = useRef(explanations);
  explanationsRef.current = explanations;

  useEffect(() => {
    if (!storage) return;
    void loadExplanations(storage).then(setExplanations);
  }, [storage]);

  /**
   * Single-shot agent explanation: runs `<agent> -p "<prompt>"` via exec
   * (the prompt travels inside the command as a quoted heredoc — no temp
   * file, no fs capability), then stores the answer under `key`.
   */
  const explainChange = useCallback(
    async (key: string, subject: string, getDiff: () => Promise<string>) => {
      if (!canExplain || !reviewAgent || pendingExplain.has(key)) return;
      setPendingExplain((s) => new Set(s).add(key));
      setError(null);
      try {
        const diffText = await getDiff();
        const cmd = explainCommand(reviewAgent, buildExplainPrompt(subject, diffText));
        const out = (await backend.exec!(ptyIdOf(session), cmd, root)).trim();
        const entry: Explanation = {
          text: out || '(no explanation returned)',
          agent: reviewAgent,
          diffHash: fnv1a(diffText),
          at: Date.now(),
        };
        const next = await saveExplanation(storage!, explanationsRef.current, key, entry);
        setExplanations(next);
      } catch (e) {
        setError(String(e));
      } finally {
        setPendingExplain((s) => {
          const n = new Set(s);
          n.delete(key);
          return n;
        });
      }
    },
    [canExplain, reviewAgent, pendingExplain, backend, session, root, storage],
  );

  /**
   * Interactive variant: opens a sub-shell tab running the agent REPL
   * seeded with the prompt (`devin --`/`claude` with the prompt embedded
   * as a quoted heredoc), then drops into a login shell when it exits.
   */
  const talkAbout = useCallback(
    async (t: ReviewTarget) => {
      if (!canTalk || !reviewAgent) return;
      setBusy(true);
      setError(null);
      try {
        const diffText = await t.getDiff();
        onOpenSubShell!(
          talkCommand(reviewAgent, buildTalkPrompt(t.subject, diffText)),
          root,
          `${reviewAgent}: ${t.name}`,
          reviewAgent,
        );
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [canTalk, reviewAgent, onOpenSubShell, root],
  );

  /**
   * "Discuss this change" on a diff-editor selection — the selection text is
   * the prompt body; subject names file, line range, diff side and context
   * (commit sha / worktree area) so the agent knows what it's looking at.
   */
  const discussSelection = useCallback(
    (s: DiffSelection) => {
      if (!selFile) return;
      const range = `L${s.startLine}${s.endLine !== s.startLine ? `-${s.endLine}` : ''}`;
      const side = s.side === 'old' ? 'old side' : 'new side';
      const where =
        sel.kind === 'commit'
          ? `commit ${sel.commit.hash.slice(0, 7)}`
          : (selFile.area ?? 'worktree');
      void talkAbout({
        key: `sel:${selFile.path}`,
        name: `${selFile.path.split('/').pop() ?? selFile.path} ${range}`,
        subject: `${selFile.path} ${range} (${side} of the diff, ${where})`,
        getDiff: () => Promise.resolve(s.text),
      });
    },
    [selFile, sel, talkAbout],
  );

  /**
   * How to fetch the diff for each explanation key — registered on render
   * so the explanation popover can re-fetch the diff for "Talk about this"
   * even after a reload (the store keeps only the answer text).
   */
  const diffTargetsRef = useRef(new Map<string, ReviewTarget>());

  /** Menu rows shared by commit/file context menus. */
  const reviewItems = useCallback(
    (t: ReviewTarget): ViewMenuItem[] => {
      if (!reviewAgent) return [];
      diffTargetsRef.current.set(t.key, t);
      return [
        {
          label: 'Explain this change',
          divider: true,
          disabled: !canExplain || pendingExplain.has(t.key),
          onClick: () => void explainChange(t.key, t.subject, t.getDiff),
        },
        {
          label: 'Talk about this change',
          disabled: !canTalk,
          onClick: () => void talkAbout(t),
        },
      ];
    },
    [reviewAgent, canExplain, canTalk, pendingExplain, explainChange, talkAbout],
  );

  /**
   * Hover/click badge shown on rows with a pending or stored explanation.
   * `subject`/`getDiff` re-register the diff source so the popover's
   * "Talk about this" works without a context menu having been opened.
   */
  const explainBadge = useCallback(
    (t: ReviewTarget) => {
      diffTargetsRef.current.set(t.key, t);
      if (pendingExplain.has(t.key)) {
        return <Hourglass className="h-3 w-3 animate-spin text-[var(--accent)]" />;
      }
      if (!explanations[t.key]) return null;
      return (
        <span
          className="flex cursor-help items-center text-[var(--accent)]"
          data-tip="Agent explanation available — click to view"
          onMouseEnter={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setExplainPop({ x: r.left, y: r.bottom + 4, key: t.key });
          }}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            setExplainPop({ x: r.left, y: r.bottom + 4, key: t.key });
          }}
        >
          <Sparkles className="h-3 w-3" />
        </span>
      );
    },
    [pendingExplain, explanations],
  );

  // -- lifecycle: initial load, visibility, quiet-output refresh -------------

  useEffect(() => {
    if (isVisible) void refresh(true);
  }, [isVisible, refresh]);

  useEffect(() => {
    // Repo state can change through shell commands — refresh once the PTY
    // goes quiet (same trick as the git-status plugin). The main PTY id
    // differs from session.id after a sub-shell promotion.
    const ptyId = ptyIdOf(session);
    let timer: number | undefined;
    const unlisten = backend.onOutput(ptyId, () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (isVisible) void refresh(true);
      }, 600);
    });
    return () => {
      window.clearTimeout(timer);
      unlisten();
    };
  }, [session, isVisible, refresh]);

  // Drop the selected file/diff when it vanished from the worktree status.
  useEffect(() => {
    if (!status || selRef.current.kind !== 'worktree') return;
    const file = selFileRef.current;
    if (!file) return;
    const lists = [status.staged, status.unstaged, status.untracked, status.conflicted];
    if (!lists.some((l) => l.some((f) => f.path === file.path))) {
      setSelFile(null);
      setDiff(null);
    }
  }, [status]);

  // -- derived ----------------------------------------------------------------

  const wipCommit: GitCommit | null =
    hasChanges && head
      ? {
          hash: '',
          parents: [head],
          author: '',
          time: 0,
          refs: [],
          subject: 'Uncommitted changes',
        }
      : null;
  const graphCommits = wipCommit ? [wipCommit, ...commits] : commits;
  const { rows, laneCount } = assignLanes(graphCommits);

  /**
   * The compare section rides the commit-selection machinery: a synthetic
   * commit whose "parent" is the merge-base and whose "hash" is HEAD — the
   * file list (`diff <parent> <hash>`) and blob diffs (`<parent>:path` vs
   * `<hash>:path`) come out as exactly the three-dot MR diff.
   */
  const compareCommit: GitCommit | null =
    compare && 'mergeBase' in compare && head
      ? {
          hash: head,
          parents: [compare.mergeBase],
          author: '',
          time: 0,
          refs: [compare.base],
          subject: `Changes vs ${compare.base} (${compare.commits} commit${
            compare.commits === 1 ? '' : 's'
          })`,
        }
      : null;

  // A base-targeted tab (axn-git <ref>) opens *for* the comparison — select
  // it once the merge-base resolves so the MR changeset is open right away.
  // Re-armed on base change (retarget) but not on data refreshes.
  const autoCompareRef = useRef<string | null>(null);
  useEffect(() => {
    if (!base) {
      autoCompareRef.current = null;
      return;
    }
    if (autoCompareRef.current === base || !compareCommit) return;
    autoCompareRef.current = base;
    void selectCommit(compareCommit);
  }, [base, compareCommit, selectCommit]);

  const stagedPaths = status?.staged.map((f) => f.path) ?? [];
  const unstagedPaths = status?.unstaged.map((f) => f.path) ?? [];
  const untrackedPaths = status?.untracked.map((f) => f.path) ?? [];

  // -- render helpers ----------------------------------------------------------

  function fileRow(f: StatusFile, letter: string, area: NonNullable<FileSel['area']>, action: 'stage' | 'unstage' | null) {
    const selected =
      sel.kind === 'worktree' && selFile?.path === f.path && selFile?.area === area;
    const target: ReviewTarget = {
      key: explainKeyForWorktreeFile(f.path),
      name: f.path.split('/').pop() ?? f.path,
      subject: `${f.path} (${area} changes)`,
      getDiff: () => diffTextForWorktreeFile(sessionId, root, f, area),
    };
    return (
      <div
        key={`${area}-${f.path}`}
        role="button"
        tabIndex={0}
        onClick={() => selectWorktreeFile(f, area)}
        onContextMenu={(e) => {
          e.preventDefault();
          // A deleted file can't be opened — offer restoring the recorded
          // state instead (index version, or HEAD when the index dropped it).
          const deleted = area === 'staged' ? f.index === 'D' : f.worktree === 'D';
          const items: ViewMenuItem[] = [];
          if (action === 'stage') items.push({ label: 'Stage', onClick: () => void stage([f.path]) });
          if (action === 'unstage')
            items.push({ label: 'Unstage', onClick: () => void unstage([f.path]) });
          if (deleted)
            items.push({
              label: 'Restore deleted file',
              onClick: () =>
                void runOp(
                  area === 'staged'
                    ? ['restore', '--source=HEAD', '--worktree', '--', f.path]
                    : ['restore', '--', f.path],
                ),
            });
          else if (onOpenFile)
            items.push({ label: 'Open file', onClick: () => onOpenFile(`${root}/${f.path}`) });
          items.push({ label: 'Copy path', onClick: () => void services.copyText(f.path) });
          items.push(...reviewItems(target));
          setViewMenu({ x: e.clientX, y: e.clientY, title: f.path, items });
        }}
        data-tip={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        className={`group flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-0.5 text-left font-mono text-[10px] transition ${
          selected
            ? 'bg-[var(--surface)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className={`w-3 shrink-0 font-semibold ${LETTER_COLOR[letter] ?? ''}`}>
          {letter}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        </span>
        {explainBadge(target)}
        {action && (
          <button
            type="button"
            data-tip={action === 'stage' ? 'Stage' : 'Unstage'}
            aria-label={action === 'stage' ? 'Stage' : 'Unstage'}
            className="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--accent)] group-hover:flex pointer-coarse:flex"
            onClick={(e) => {
              e.stopPropagation();
              if (action === 'stage') void stage([f.path]);
              else void unstage([f.path]);
            }}
          >
            {action === 'stage' ? (
              <Plus className="h-3 w-3" />
            ) : (
              <Minus className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
    );
  }

  function section(
    title: string,
    files: StatusFile[],
    letterOf: (f: StatusFile) => string,
    area: NonNullable<FileSel['area']>,
    action: 'stage' | 'unstage' | null,
    allLabel?: string,
    onAll?: () => void,
  ) {
    if (files.length === 0) return null;
    return (
      <div className="mb-1">
        <div className="flex items-center justify-between px-2 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          <span>
            {title} ({files.length})
          </span>
          {allLabel && onAll && (
            <button
              type="button"
              onClick={onAll}
              className="normal-case text-[var(--accent)] hover:underline"
            >
              {allLabel}
            </button>
          )}
        </div>
        {files.map((f) => fileRow(f, letterOf(f), area, action))}
      </div>
    );
  }

  const repo = session.repo;
  const repoName = repo?.name ?? root.split('/').filter(Boolean).pop() ?? root;

  // -- render -------------------------------------------------------------------

  return (
    <div className="flex h-full w-full flex-col bg-[var(--terminal-bg)]">
      {/* toolbar */}
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <GitBranch className="h-3.5 w-3.5 text-[var(--cyan)]" />
        <span className="truncate font-semibold text-[11px] text-[var(--text-primary)]">
          {repoName}
        </span>
        <span className="max-w-48 truncate font-mono text-[10px] text-[var(--cyan)]">
          {branch === 'HEAD' ? '(detached)' : branch}
        </span>
        {base && (
          <span
            className="flex shrink-0 items-center gap-1 font-mono text-[9px] text-[var(--accent)]"
            data-tip="Compare base — the view diffs merge-base vs HEAD"
          >
            <GitCompareArrows className="h-3 w-3" />
            {base}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-[var(--text-secondary)]">
          {root}
        </span>
        {hasChanges && (
          <span className="shrink-0 font-mono text-[9px] text-[var(--yellow)]">
            {status!.staged.length + status!.unstaged.length + status!.untracked.length + status!.conflicted.length}{' '}
            changed
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh(true)}
          disabled={busy}
          data-tip="Refresh"
          aria-label="Refresh"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1 font-mono text-[10px] text-[var(--red)]">
          {error}
        </div>
      )}

      {/* main row: left panel + diff */}
      <div className="flex min-h-0 flex-1">
        {/* left panel */}
        <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-[var(--border)]">
          {sel.kind === 'worktree' ? (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto py-1">
                {!status && (
                  <div className="px-3 py-2 text-[10px] text-[var(--text-secondary)]">
                    loading…
                  </div>
                )}
                {status && !hasChanges && (
                  <div className="px-3 py-2 text-[10px] italic text-[var(--text-secondary)]">
                    working tree clean
                  </div>
                )}
                {base && (
                  <div className="px-2 pb-1">
                    <button
                      type="button"
                      disabled={!compareCommit}
                      onClick={() => compareCommit && void selectCommit(compareCommit)}
                      data-tip={
                        compare && 'error' in compare
                          ? compare.error
                          : 'Files this branch would change when merged into the base ref'
                      }
                      className={`flex w-full items-center gap-1.5 rounded border px-2 py-1 text-left text-[10px] transition ${
                        compare && 'error' in compare
                          ? 'border-[var(--border)] text-[var(--red)]'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'
                      } disabled:opacity-70`}
                    >
                      <GitCompareArrows className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                      <span className="min-w-0 flex-1 truncate">
                        {compareCommit
                          ? compareCommit.subject
                          : compare && 'error' in compare
                            ? `Changes vs ${base} — ${compare.error}`
                            : `Changes vs ${base}…`}
                      </span>
                    </button>
                  </div>
                )}
                {status && (
                  <>
                    {section(
                      'Conflicted',
                      status.conflicted,
                      (f) => fileLetter(f.index),
                      'conflicted',
                      'stage',
                    )}
                    {section(
                      'Staged',
                      status.staged,
                      (f) => fileLetter(f.index),
                      'staged',
                      'unstage',
                      'unstage all',
                      () => void unstage(stagedPaths),
                    )}
                    {section(
                      'Unstaged',
                      status.unstaged,
                      (f) => fileLetter(f.worktree),
                      'unstaged',
                      'stage',
                      'stage all',
                      () => void stage(unstagedPaths),
                    )}
                    {section(
                      'Untracked',
                      status.untracked,
                      () => '?',
                      'untracked',
                      'stage',
                      'stage all',
                      () => void stage(untrackedPaths),
                    )}
                  </>
                )}
              </div>
              {/* commit box */}
              <div className="shrink-0 border-t border-[var(--border)] p-2">
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.currentTarget.value)}
                  placeholder={amend ? 'Amend message (empty keeps the old one)' : 'Commit message'}
                  rows={3}
                  className="w-full resize-none rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1 font-mono text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <div className="mt-1 flex items-center gap-2">
                  <label className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
                    <input
                      type="checkbox"
                      checked={amend}
                      onChange={(e) => setAmend(e.currentTarget.checked)}
                      className="h-3 w-3 accent-[var(--accent)]"
                    />
                    amend
                  </label>
                  <div className="flex-1" />
                  <button
                    type="button"
                    onClick={() => void doCommit()}
                    disabled={
                      busy ||
                      (!amend && (commitMsg.trim() === '' || stagedPaths.length === 0))
                    }
                    className="rounded bg-[var(--accent)] px-3 py-1 text-[10px] font-semibold text-[var(--text-inverted)] transition hover:opacity-90 disabled:opacity-40"
                  >
                    {amend ? 'Amend' : 'Commit'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  void flushDiff().then(() => {
                    setSel({ kind: 'worktree' });
                    setSelFile(null);
                    setDiff(null);
                  });
                }}
                className="m-2 shrink-0 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[10px] text-[var(--text-primary)] transition hover:bg-[var(--surface-hover)]"
              >
                ← Working copy
              </button>
              <div className="border-b border-[var(--border)] px-3 pb-2">
                <div className="font-mono text-[10px] text-[var(--accent)]">
                  {sel.commit.hash.slice(0, 10)}
                </div>
                <div className="mt-0.5 text-[11px] font-semibold text-[var(--text-primary)]">
                  {sel.commit.subject}
                </div>
                <div className="mt-0.5 text-[10px] text-[var(--text-secondary)]">
                  {sel.commit.author}
                  {sel.commit.time > 0 &&
                    ` · ${new Date(sel.commit.time * 1000).toLocaleString()}`}
                </div>
                {sel.commit.refs.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {sel.commit.refs.map((r) => (
                      <span
                        key={r}
                        className="rounded bg-[var(--surface-hover)] px-1 py-px font-mono text-[9px] text-[var(--text-primary)]"
                      >
                        {r}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-2 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                Files ({commitFiles.length})
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-1">
                {commitFiles.map((f) => {
                  const target: ReviewTarget = {
                    key: explainKeyForCommitFile(sel.commit.hash, f.path),
                    name: f.path.split('/').pop() ?? f.path,
                    subject: `${f.path} @ ${sel.commit.hash.slice(0, 7)}`,
                    getDiff: () =>
                      diffTextForCommitFile(sessionId, root, sel.commit.hash, f),
                  };
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => selectCommitFile(f)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        // Files deleted AT this commit no longer exist in its
                        // tree — restore the last version (the parent's).
                        const deleted = fileLetter(f.status) === 'D';
                        const items: ViewMenuItem[] = [
                          {
                            label: deleted ? 'Restore deleted file' : 'Restore this state',
                            onClick: () =>
                              void runOp([
                                'restore',
                                `--source=${deleted ? `${sel.commit.hash}^` : sel.commit.hash}`,
                                '--worktree',
                                '--',
                                f.path,
                              ]),
                          },
                          {
                            label: 'Copy path',
                            onClick: () => void services.copyText(f.path),
                          },
                          ...reviewItems(target),
                        ];
                        setViewMenu({ x: e.clientX, y: e.clientY, title: f.path, items });
                      }}
                      data-tip={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                      className={`flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left font-mono text-[10px] transition ${
                        selFile?.path === f.path
                          ? 'bg-[var(--surface)] text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <span
                        className={`w-3 shrink-0 font-semibold ${LETTER_COLOR[fileLetter(f.status)] ?? ''}`}
                      >
                        {fileLetter(f.status)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                      </span>
                      {explainBadge(target)}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* diff pane */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
            <FileDiff className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--text-secondary)]">
              {diff?.title ?? 'select a file or commit'}
            </span>
            {diff?.editablePath && (
              <>
                {diffDirty && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-[var(--orange)]"
                    data-tip="Unsaved changes"
                  />
                )}
                <button
                  type="button"
                  onClick={() => void diffApiRef.current?.flush()}
                  disabled={diffSaving || !diffDirty}
                  data-tip={diffSaveTip}
                  aria-label={diffSaveTip}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)] disabled:opacity-50"
                >
                  <Save className="h-3 w-3" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setSideBySide((v) => !v)}
              data-tip={sideBySide ? 'Inline diff' : 'Side-by-side diff'}
              aria-label={sideBySide ? 'Inline diff' : 'Side-by-side diff'}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] transition hover:bg-[var(--surface)] hover:text-[var(--accent)]"
            >
              {sideBySide ? (
                <Rows2 className="h-3 w-3" />
              ) : (
                <Columns2 className="h-3 w-3" />
              )}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {diff ? (
              <MonacoDiff
                diff={diff}
                sideBySide={sideBySide}
                onSave={saveDiff}
                apiRef={diffApiRef}
                onDirtyChange={setDiffDirty}
                onDiscuss={canTalk && selFile ? discussSelection : undefined}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-xs text-[var(--text-secondary)]">
                Select a changed file or a commit to inspect the diff
              </div>
            )}
          </div>
        </div>
      </div>

      {/* history strip */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startY = e.clientY;
          const startH = historyH;
          const onMove = (ev: MouseEvent) => {
            setHistoryH(
              Math.min(MAX_HISTORY_H, Math.max(MIN_HISTORY_H, startH + (startY - ev.clientY))),
            );
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        className="h-1 shrink-0 cursor-row-resize select-none hover:bg-[var(--accent)]"
        data-tip="Drag to resize history"
      />
      <div className="flex h-6 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2">
        <button
          type="button"
          onClick={() => setHistoryOpen((v) => !v)}
          className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]"
        >
          {historyOpen ? '▾' : '▸'} History
          {commits.length > 0 && ` (${commits.length})`}
        </button>
      </div>
      {historyOpen && (
        <div className="shrink-0 overflow-auto" style={{ height: historyH }}>
          {rows.length === 0 ? (
            <div className="px-3 py-2 text-[10px] italic text-[var(--text-secondary)]">
              no commits yet
            </div>
          ) : (
            <GitGraph
              rows={rows}
              laneCount={laneCount}
              selectedHash={
                sel.kind === 'commit' ? sel.commit.hash : wipCommit ? '' : null
              }
              onSelect={(c) => void selectCommit(c)}
              onContextMenu={(c, pos) => {
                const target: ReviewTarget = {
                  key: explainKeyForCommit(c.hash),
                  name: `commit ${c.hash.slice(0, 7)}`,
                  subject: `commit ${c.hash.slice(0, 7)}: ${c.subject}`,
                  getDiff: () => diffTextForCommit(sessionId, root, c),
                };
                const items: ViewMenuItem[] = [
                  {
                    label: 'Copy commit hash',
                    onClick: () => void services.copyText(c.hash),
                  },
                  ...reviewItems(target),
                ];
                setViewMenu({
                  x: pos.x,
                  y: pos.y,
                  title: `${c.hash.slice(0, 10)} ${c.subject}`,
                  items,
                });
              }}
              rowExtra={(c) =>
                explainBadge({
                  key: explainKeyForCommit(c.hash),
                  name: `commit ${c.hash.slice(0, 7)}`,
                  subject: `commit ${c.hash.slice(0, 7)}: ${c.subject}`,
                  getDiff: () => diffTextForCommit(sessionId, root, c),
                })
              }
            />
          )}
        </div>
      )}

      {/* shared context menu (file rows, commit rows, diff pane) */}
      {viewMenu && (
        <ContextMenu x={viewMenu.x} y={viewMenu.y} onClose={() => setViewMenu(null)}>
          {viewMenu.title && (
            <div className="truncate px-2 pb-1 pt-1.5 font-mono text-[9px] text-[var(--text-secondary)]">
              {viewMenu.title}
            </div>
          )}
          {viewMenu.items.map((it, i) => (
            <div key={i}>
              {it.divider && <div className={menuDividerClass} />}
              <button
                type="button"
                disabled={it.disabled}
                className={menuItemClass + (it.disabled ? ' opacity-40' : '')}
                onClick={() => {
                  setViewMenu(null);
                  it.onClick?.();
                }}
              >
                {it.label}
              </button>
            </div>
          ))}
        </ContextMenu>
      )}

      {/* stored agent explanation popover */}
      {explainPop && explanations[explainPop.key] && (
        <ContextMenu
          x={explainPop.x}
          y={explainPop.y}
          onClose={() => setExplainPop(null)}
          widthClass="w-80"
        >
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 pb-2 pt-2.5 text-[11px] leading-snug text-[var(--text-primary)]">
            {explanations[explainPop.key].text}
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--border)] px-3 py-1.5">
            <span className="flex-1 truncate font-mono text-[9px] text-[var(--text-secondary)]">
              {explanations[explainPop.key].agent} ·{' '}
              {new Date(explanations[explainPop.key].at).toLocaleString()}
            </span>
            <button
              type="button"
              className={menuItemClass + ' w-auto shrink-0 px-1.5 py-0.5 text-[var(--accent)]'}
              onClick={() => {
                const t = diffTargetsRef.current.get(explainPop.key);
                setExplainPop(null);
                if (t) void talkAbout(t);
              }}
            >
              Talk about this
            </button>
            <button
              type="button"
              className={menuItemClass + ' w-auto shrink-0 px-1.5 py-0.5'}
              onClick={() => {
                if (storage)
                  void removeExplanation(storage, explanationsRef.current, explainPop.key).then(
                    setExplanations,
                  );
                setExplainPop(null);
              }}
            >
              Forget
            </button>
          </div>
        </ContextMenu>
      )}
    </div>
  );
}
