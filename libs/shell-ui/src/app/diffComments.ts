import type { DiffComment } from '../types';
import { fnv1a } from './gitReview';

/**
 * Anchored diff comments — the pure half of the git-inspect review feature.
 * A comment pins `range` + the exact line text + context lines; every diff
 * refresh re-anchors it against the new content through a cascade (exact hit
 * → windowed search → whole-file search → stale), because on a live diff the
 * agent keeps editing and line numbers drift. Prefer 'stale' over a wrong
 * re-pin: `status` is anchor health, `resolution` is the user's triage
 * (open / done / deferred — deferred means "should be done, not now" and is
 * re-included in every send until resolved).
 */

/** Context lines captured above/below the anchored range. */
const CTX = 2;
/** Near-search radius in lines before falling back to a whole-file scan. */
const WINDOW = 30;
/** Minimum context agreement (0..1) for a candidate line to win. */
const MIN_SCORE = 0.5;

export function nextCommentId(): string {
  return `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Capture the anchor for `range` (1-based, inclusive) inside `lines` — the
 * line text plus CTX context lines on each side, and the content fingerprint
 * the anchor is validated against.
 */
export function captureAnchor(
  lines: string[],
  start: number,
  end: number,
  diffId?: string,
): DiffComment['anchor'] {
  return {
    text: lines.slice(start - 1, end).join('\n'),
    before: lines.slice(Math.max(0, start - 1 - CTX), start - 1),
    after: lines.slice(end, end + CTX),
    diffId: diffId ?? fnv1a(lines.join('\n')),
  };
}

/** 0..1 — share of the anchor's context lines matching at their offsets. */
function contextScore(anchor: DiffComment['anchor'], lines: string[], start: number): number {
  let total = 0;
  let hits = 0;
  anchor.before.forEach((line, i) => {
    total += 1;
    const idx = start - anchor.before.length + i;
    if (lines[idx] === line) hits += 1;
  });
  anchor.after.forEach((line, i) => {
    total += 1;
    const end = start + anchor.text.split('\n').length;
    if (lines[end + i] === line) hits += 1;
  });
  return total === 0 ? 1 : hits / total;
}

/**
 * Index of the anchor's first line inside `lines` between `lo` and `hi`
 * (0-based), scored by context agreement — best-scoring candidate wins,
 * ties broken by distance to `hint`. Returns null below MIN_SCORE.
 */
function findAnchor(
  anchor: DiffComment['anchor'],
  lines: string[],
  hint: number,
  lo: number,
  hi: number,
): number | null {
  const textLines = anchor.text.split('\n');
  let best: { idx: number; score: number; dist: number } | null = null;
  for (let i = lo; i <= hi && i + textLines.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < textLines.length; j++) {
      if (lines[i + j] !== textLines[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const score = contextScore(anchor, lines, i);
    const dist = Math.abs(i - hint);
    if (score >= MIN_SCORE && (!best || score > best.score || (score === best.score && dist < best.dist))) {
      best = { idx: i, score, dist };
    }
  }
  return best?.idx ?? null;
}

/**
 * Re-anchor one comment against `lines` (the file content of its diff side).
 * Returns `{ status, start }` — start is the (possibly unchanged) 1-based
 * first line; `lines` null means the side's content is unavailable (keep as
 * is, don't mark stale — absence of data is not deletion).
 */
export function reanchor(
  c: DiffComment,
  lines: string[] | null,
  diffId: string,
): { status: DiffComment['status']; range: [number, number] } {
  if (lines === null) return { status: c.status === 'stale' ? 'stale' : 'active', range: c.range };
  if (c.anchor.diffId === diffId) return { status: 'active', range: c.range };

  const span = c.range[1] - c.range[0];
  // 1. exact hit — position and content both unchanged.
  if (lines.slice(c.range[0] - 1, c.range[1]).join('\n') === c.anchor.text) {
    return { status: 'active', range: c.range };
  }
  const hint = c.range[0] - 1;
  // 2. windowed search around the last known position.
  const near = findAnchor(c.anchor, lines, hint, Math.max(0, hint - WINDOW), hint + WINDOW);
  // 3. whole-file fallback.
  const idx = near ?? findAnchor(c.anchor, lines, hint, 0, lines.length - 1);
  if (idx !== null) {
    return { status: idx === hint ? 'active' : 'moved', range: [idx + 1, idx + 1 + span] };
  }
  // 4. unanchorable — flag, never silently re-pin.
  return { status: 'stale', range: c.range };
}

/**
 * Re-anchor every comment on `path` against the freshly loaded diff content
 * (`original` = old side, `modified` = new side; missing side stays as-is).
 * Returns the updated list or null when nothing changed — callers patch the
 * tab only on a non-null result so clean refreshes never write state.
 */
export function reanchorComments(
  comments: DiffComment[],
  path: string,
  content: { original?: string; modified?: string },
): DiffComment[] | null {
  const sideLines = {
    old: content.original != null ? content.original.split('\n') : null,
    new: content.modified != null ? content.modified.split('\n') : null,
  };
  const sideIds = {
    old: content.original != null ? fnv1a(content.original) : undefined,
    new: content.modified != null ? fnv1a(content.modified) : undefined,
  };
  let changed = false;
  const next = comments.map((c) => {
    if (c.path !== path) return c;
    const lines = sideLines[c.side];
    const diffId = sideIds[c.side];
    if (diffId === undefined) return c; // that side not loaded — keep as-is
    const r = reanchor(c, lines, diffId);
    if (
      r.status === c.status &&
      r.range[0] === c.range[0] &&
      r.range[1] === c.range[1] &&
      c.anchor.diffId === diffId
    ) {
      return c;
    }
    changed = true;
    return {
      ...c,
      status: r.status,
      range: r.range,
      anchor: { ...c.anchor, diffId },
    };
  });
  return changed ? next : null;
}

// ---------------------------------------------------------------------------
// Send-to-agent prompt
// ---------------------------------------------------------------------------

function formatRange(range: [number, number]): string {
  return range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
}

function formatComment(c: DiffComment): string {
  const flags: string[] = [];
  if (c.side === 'old') flags.push('old side');
  if (c.status === 'moved') flags.push(`moved to line ${c.range[0]}`);
  if (c.status === 'stale') flags.push('line changed since comment — original text quoted');
  const loc = `${c.path}:${formatRange(c.range)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  const quote = c.anchor.text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `${loc}\n${quote}\n${c.body}`;
}

/**
 * Build the review prompt injected into the agent tab: open comments first,
 * deferred ones as an explicit "still to do" section (a deferred comment is
 * a promise, not a dismissal — it re-enters every send). Done comments are
 * left out.
 */
export function buildCommentsPrompt(subject: string, comments: DiffComment[]): string | null {
  const open = comments.filter((c) => c.resolution === 'open');
  const deferred = comments.filter((c) => c.resolution === 'deferred');
  if (open.length === 0 && deferred.length === 0) return null;
  let out = `Review comments on ${subject} — please address them:\n\n`;
  out += open.map(formatComment).join('\n\n');
  if (deferred.length) {
    out += `\n\nDeferred from an earlier review (still to do — address now or say why they stay deferred):\n\n`;
    out += deferred.map(formatComment).join('\n\n');
  }
  return out;
}

/** Comments worth sending or surfacing as open work. */
export function actionableComments(comments: DiffComment[]): DiffComment[] {
  return comments.filter((c) => c.resolution !== 'done');
}
