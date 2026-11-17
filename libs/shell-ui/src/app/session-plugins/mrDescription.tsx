import { useEffect, useRef, useState } from 'react';
import {
  previewContainStyle,
  previewLinkClick,
  sanitizePreviewHtml,
} from '../preview-plugins/html';

// Parsed+sanitized markup per source — the overview refresh re-renders the
// same descriptions every poll, and marked is a lazy chunk.
const htmlCache = new Map<string, string>();

async function renderMarkdown(markdown: string): Promise<string> {
  const hit = htmlCache.get(markdown);
  if (hit !== undefined) return hit;
  const { marked } = await import('marked');
  const html = sanitizePreviewHtml(await marked.parse(markdown, { gfm: true }));
  if (htmlCache.size > 200) htmlCache.clear();
  htmlCache.set(markdown, html);
  return html;
}

/**
 * An MR/PR description rendered as markdown inside a list row. Descriptions
 * often open with a `# title`, so `.axn-prose-compact` knocks headings down
 * to bold lead-ins, and the body clamps to 4 lines until expanded — a title
 * plus its blank line already spends two of them. Rendered outside the row's
 * anchor: markdown links inside an `<a>` are invalid HTML.
 */
export function MrDescription({ markdown }: { markdown: string }) {
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(markdown) ?? null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setHtml(htmlCache.get(markdown) ?? null);
    setExpanded(false);
    void renderMarkdown(markdown).then((h) => {
      if (live) setHtml(h);
    });
    return () => {
      live = false;
    };
  }, [markdown]);

  // Only offer the toggle when the clamp actually cuts content off.
  useEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [html, expanded]);

  if (html === null) {
    return (
      <div className="mt-0.5 line-clamp-4 whitespace-pre-line break-words text-[11px] text-[var(--text-secondary)]">
        {markdown}
      </div>
    );
  }
  return (
    <div className="mt-0.5">
      <div
        ref={ref}
        className={`axn-prose axn-prose-compact${expanded ? '' : ' line-clamp-4'}`}
        style={previewContainStyle}
        onClick={previewLinkClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {overflowing && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[10px] text-[var(--accent)] hover:underline"
        >
          {expanded ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  );
}
