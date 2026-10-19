import { useEffect, useState } from 'react';
import { extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { HtmlPreview } from './html';

function MarkdownPreview({ ctx }: { ctx: FilePreviewContext }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const source = await ctx.readFile();
        const { marked } = await import('marked');
        const rendered = await marked.parse(source, { gfm: true });
        if (live) setHtml(rendered);
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [ctx]);

  if (error) {
    return <div className="p-4 text-[11px] text-[var(--red)]">{error}</div>;
  }
  if (html === null) {
    return <div className="p-4 text-[11px] text-[var(--text-secondary)]">Loading…</div>;
  }
  return <HtmlPreview html={html} ctx={ctx} />;
}

export const markdownPreviewPlugin: FilePreviewPlugin = {
  id: 'markdown',
  title: 'Markdown',
  version: '0.1.0',
  matches: extensionMatcher(['md', 'markdown', 'mdown', 'mkd', 'mkdn']),
  render: (ctx) => <MarkdownPreview ctx={ctx} />,
};
