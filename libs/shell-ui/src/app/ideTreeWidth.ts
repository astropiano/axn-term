/** Width of the IDE view's resizable file tree column. */

/** Default width of the file tree column (px) — the old fixed `w-56`. */
export const IDE_TREE_DEFAULT_WIDTH = 224;
const IDE_TREE_MIN_WIDTH = 160;
/** The editor keeps at least this much of the view. */
const IDE_EDITOR_MIN_WIDTH = 240;
const IDE_TREE_WIDTH_KEY = 'axn-term:ide-tree-width';

/**
 * Clamp a dragged tree width: at least `IDE_TREE_MIN_WIDTH`, and never so
 * wide that the editor drops below `IDE_EDITOR_MIN_WIDTH` of `viewWidth`
 * (0 = unknown, then only the minimum applies).
 */
export function clampTreeWidth(width: number, viewWidth: number): number {
  const max = viewWidth > 0 ? Math.max(IDE_TREE_MIN_WIDTH, viewWidth - IDE_EDITOR_MIN_WIDTH) : Infinity;
  return Math.round(Math.min(max, Math.max(IDE_TREE_MIN_WIDTH, width)));
}

/** The last tree width the user dragged to — a per-viewer convenience. */
export function storedTreeWidth(): number {
  try {
    const n = Number(localStorage.getItem(IDE_TREE_WIDTH_KEY));
    return Number.isFinite(n) && n >= IDE_TREE_MIN_WIDTH ? n : IDE_TREE_DEFAULT_WIDTH;
  } catch {
    return IDE_TREE_DEFAULT_WIDTH;
  }
}

export function storeTreeWidth(width: number) {
  try {
    localStorage.setItem(IDE_TREE_WIDTH_KEY, String(width));
  } catch {
    // private window / blocked storage — the width just isn't remembered
  }
}
