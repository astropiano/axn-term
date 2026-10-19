import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useShellServices } from '../services';
import type { GitCommit, GraphRow } from './gitClient';

const LANE_W = 12;
const ROW_H = 24;
const PAD = 6;
const DOT_R = 3.5;

const LANE_COLORS = [
  '#4fc1ff',
  '#c586c0',
  '#4ec9b0',
  '#dcdcaa',
  '#f28fad',
  '#fab387',
  '#89dceb',
  '#a6e3a1',
];

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

function laneX(lane: number): number {
  return PAD + lane * LANE_W + LANE_W / 2;
}

export function graphWidth(laneCount: number): number {
  return PAD * 2 + Math.max(laneCount, 1) * LANE_W;
}

interface RefChip {
  label: string;
  kind: 'head' | 'branch' | 'tag' | 'remote';
}

function refChips(refs: string[]): RefChip[] {
  const chips: RefChip[] = [];
  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) {
      chips.push({ label: 'HEAD', kind: 'head' });
      chips.push({ label: ref.slice(8), kind: 'branch' });
    } else if (ref === 'HEAD') {
      chips.push({ label: 'HEAD', kind: 'head' });
    } else if (ref.startsWith('tag: ')) {
      chips.push({ label: ref.slice(5), kind: 'tag' });
    } else if (ref.includes('/')) {
      chips.push({ label: ref, kind: 'remote' });
    } else {
      chips.push({ label: ref, kind: 'branch' });
    }
  }
  return chips;
}

const chipColor: Record<RefChip['kind'], string> = {
  head: 'bg-[var(--accent)] text-[var(--text-inverted)]',
  branch: 'bg-[var(--surface-hover)] text-[var(--text-primary)]',
  tag: 'bg-[var(--surface-hover)] text-[var(--orange)]',
  remote: 'text-[var(--text-secondary)]',
};

function relTime(unix: number): string {
  if (!unix) return '';
  const diff = Math.max(0, Date.now() / 1000 - unix);
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}

const TIP_DELAY_MS = 400;
const TIP_HIDE_MS = 300;
const TIP_GAP = 6;
const TIP_EDGE = 4;

interface CommitTip {
  commit: GitCommit;
  rect: DOMRect;
  /** Mouse x at hover — the rows span the full strip width, so the card
   * anchors to the cursor horizontally, not to the row's center. */
  x: number;
}

/**
 * Interactive hover card for a commit: full hash (click to copy), author +
 * absolute commit time, then the subject. Unlike the shared `data-tip`
 * tooltip this one takes pointer events so the hash can be clicked — it stays
 * open while hovered.
 */
function CommitHoverCard({
  tip,
  cardRef,
  onHover,
}: {
  tip: CommitTip;
  cardRef: (el: HTMLDivElement | null) => void;
  onHover: (inside: boolean) => void;
}) {
  const { services } = useShellServices();
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const c = tip.commit;

  useLayoutEffect(() => {
    setPos(null);
    const bubble = bubbleRef.current?.getBoundingClientRect();
    if (!bubble) return;
    const rect = tip.rect;
    const above = rect.top - bubble.height - TIP_GAP >= TIP_EDGE;
    setPos({
      top: above ? rect.top - bubble.height - TIP_GAP : rect.bottom + TIP_GAP,
      left: Math.max(
        TIP_EDGE,
        Math.min(tip.x - bubble.width / 2, window.innerWidth - bubble.width - TIP_EDGE),
      ),
    });
  }, [tip]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const d = c.time ? new Date(c.time * 1000) : null;
  const when = d
    ? `${d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : '';

  return createPortal(
    <div
      ref={(el) => {
        bubbleRef.current = el;
        cardRef(el);
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className="fixed z-[70] max-w-md rounded border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-[10px] leading-snug text-[var(--text-primary)] shadow-lg"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <button
        type="button"
        data-tip="Copy commit hash"
        onClick={() => {
          void services.copyText(c.hash);
          setCopied(true);
        }}
        className="group flex w-full items-baseline gap-2 text-left font-mono text-[11px]"
      >
        <span className="whitespace-nowrap text-[var(--accent)] group-hover:underline">
          {c.hash}
        </span>
        <span className="shrink-0 font-sans text-[9px] text-[var(--text-secondary)]">
          {copied ? '✓ copied' : 'click to copy'}
        </span>
      </button>
      {(c.author || when) && (
        <div className="mt-1 text-[var(--text-secondary)]">
          {c.author}
          {c.author && when ? ' · ' : ''}
          {when}
        </div>
      )}
      <div className="mt-1 whitespace-pre-wrap break-words">
        {c.subject || '(no message)'}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Edge segments of one graph row, drawn inside the row's band (0..ROW_H):
 * lanes passing straight through, lanes ending in the dot (own lane + merges)
 * and lanes forked off the dot toward secondary parents.
 */
function RowEdges({ row, index }: { row: GraphRow; index: number }) {
  const cy = ROW_H / 2;
  const dotX = laneX(row.lane);
  const hash = row.commit.hash;
  const paths: { d: string; lane: number }[] = [];

  row.entering.forEach((expected, l) => {
    if (expected === null) return;
    const x = laneX(l);
    if (expected === hash) {
      if (l === row.lane) {
        // Own lane: straight into the dot.
        paths.push({ d: `M ${x} 0 L ${x} ${cy}`, lane: l });
      } else {
        // Merge fan-in: curve from lane l into the dot.
        paths.push({
          d: `M ${x} 0 C ${x} ${cy * 0.6} ${dotX} ${cy * 0.6} ${dotX} ${cy}`,
          lane: l,
        });
      }
    } else {
      // Lane expecting a later commit → passes straight through.
      paths.push({ d: `M ${x} 0 L ${x} ${ROW_H}`, lane: l });
    }
  });

  row.leaving.forEach((expected, l) => {
    if (expected === null) return;
    const x = laneX(l);
    if (l === row.lane) {
      // First-parent continuation: dot to bottom.
      paths.push({ d: `M ${x} ${cy} L ${x} ${ROW_H}`, lane: l });
    } else if (row.forks.includes(l)) {
      // Forked-off secondary parent: curve from the dot to lane l.
      paths.push({
        d: `M ${dotX} ${cy} C ${dotX} ${cy + cy * 0.6} ${x} ${ROW_H - cy * 0.6} ${x} ${ROW_H}`,
        lane: l,
      });
    }
    // Lanes entering and leaving unchanged were already drawn as through.
  });

  return (
    <svg
      className="absolute"
      style={{ top: index * ROW_H, left: 0 }}
      width={graphWidth(Math.max(row.entering.length, row.leaving.length))}
      height={ROW_H}
    >
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke={laneColor(p.lane)}
          strokeWidth={1.5}
        />
      ))}
      {hash === '' ? (
        // Synthetic WIP node: hollow dashed circle.
        <circle
          cx={dotX}
          cy={cy}
          r={DOT_R}
          fill="none"
          stroke={laneColor(row.lane)}
          strokeWidth={1.5}
          strokeDasharray="2 2"
        />
      ) : (
        <circle cx={dotX} cy={cy} r={DOT_R} fill={laneColor(row.lane)} />
      )}
    </svg>
  );
}

export interface GitGraphProps {
  rows: GraphRow[];
  laneCount: number;
  /** Currently selected commit hash ('' for the WIP row). */
  selectedHash?: string | null;
  onSelect: (commit: GitCommit) => void;
  /** Emitted when a commit row is right-clicked. */
  onContextMenu?: (commit: GitCommit, pos: { x: number; y: number }) => void;
  /** Optional extra content rendered inside each row (e.g. review badges). */
  rowExtra?: (commit: GitCommit) => ReactNode;
}

/**
 * GitKraken-style lane graph: SVG edges per row plus a text overlay with
 * refs, subject, author and relative time. Clicking a row selects it.
 */
export function GitGraph({ rows, laneCount, selectedHash, onSelect, onContextMenu, rowExtra }: GitGraphProps) {
  const width = graphWidth(laneCount);
  const [tip, setTip] = useState<CommitTip | null>(null);
  const tipRef = useRef<CommitTip | null>(null);
  tipRef.current = tip;
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cardEl = useRef<HTMLDivElement | null>(null);
  const mouseX = useRef(0);

  const enterRow = useCallback((c: GitCommit, el: HTMLElement) => {
    if (c.hash === '') return;
    clearTimeout(hideTimer.current);
    if (tipRef.current) {
      // A card is already open — switch commits instantly.
      setTip({ commit: c, rect: el.getBoundingClientRect(), x: mouseX.current });
      return;
    }
    clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => {
      if (el.isConnected)
        setTip({ commit: c, rect: el.getBoundingClientRect(), x: mouseX.current });
    }, TIP_DELAY_MS);
  }, []);

  const leaveRow = useCallback(() => {
    clearTimeout(showTimer.current);
    if (tipRef.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setTip(null), TIP_HIDE_MS);
    }
  }, []);

  const hoverCard = useCallback((inside: boolean) => {
    if (inside) clearTimeout(hideTimer.current);
    else setTip(null);
  }, []);

  // Same dismissal rules as the shared TooltipHost — scroll, keys, presses
  // outside the card, blur and resize. Presses inside the card are kept so
  // the hash button can be clicked.
  useEffect(() => {
    const dismiss = () => {
      clearTimeout(showTimer.current);
      setTip(null);
    };
    const onDown = (e: Event) => {
      if (cardEl.current?.contains(e.target as Node)) return;
      dismiss();
    };
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      clearTimeout(showTimer.current);
      clearTimeout(hideTimer.current);
    };
  }, []);

  const rowEls = useMemo(
    () =>
      rows.map((row, i) => {
        const c = row.commit;
        const chips = refChips(c.refs);
        const isHead = c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD ->'));
        const selected =
          selectedHash != null &&
          (c.hash === '' ? selectedHash === '' : c.hash.startsWith(selectedHash));
        return (
          <div
            key={`${c.hash}-${i}`}
            onClick={() => onSelect(c)}
            onMouseEnter={(e) => {
              mouseX.current = e.clientX;
              enterRow(c, e.currentTarget);
            }}
            onMouseMove={(e) => {
              mouseX.current = e.clientX;
            }}
            onMouseLeave={leaveRow}
            onContextMenu={(e) => {
              if (!onContextMenu || c.hash === '') return;
              e.preventDefault();
              onContextMenu(c, { x: e.clientX, y: e.clientY });
            }}
            className={`absolute flex cursor-pointer items-center gap-2 overflow-hidden whitespace-nowrap px-2 text-[11px] transition ${
              selected
                ? 'bg-[var(--surface)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'
            }`}
            style={{
              top: i * ROW_H,
              left: width,
              right: 0,
              height: ROW_H,
            }}
            data-tip={c.hash === '' ? c.subject : undefined}
          >
            {isHead && (
              <span className="shrink-0 font-semibold text-[var(--accent)]">●</span>
            )}
            {chips.map((chip, j) => (
              <span
                key={j}
                className={`shrink-0 rounded px-1 py-px font-mono text-[9px] leading-tight ${chipColor[chip.kind]}`}
              >
                {chip.label}
              </span>
            ))}
            <span
              className={`min-w-0 truncate ${
                c.hash === '' ? 'italic text-[var(--orange)]' : 'text-[var(--text-primary)]'
              }`}
            >
              {c.subject || '(no message)'}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[9px]">
              {c.hash !== '' && rowExtra?.(c)}
              <span className="max-w-28 truncate">{c.author}</span>
              <span>{relTime(c.time)}</span>
              <span className="w-14 text-right">{c.hash.slice(0, 7)}</span>
            </span>
          </div>
        );
      }),
    [rows, width, selectedHash, onSelect, onContextMenu, rowExtra, enterRow, leaveRow],
  );

  return (
    <div className="relative" style={{ height: rows.length * ROW_H }}>
      {rows.map((row, i) => (
        <RowEdges key={`${row.commit.hash}-${i}`} row={row} index={i} />
      ))}
      {rowEls}
      {tip && (
        <CommitHoverCard
          tip={tip}
          cardRef={(el) => {
            cardEl.current = el;
          }}
          onHover={hoverCard}
        />
      )}
    </div>
  );
}
