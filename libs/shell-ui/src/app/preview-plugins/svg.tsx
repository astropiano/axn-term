import { useEffect, useState } from 'react';
import { extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { HtmlPreview } from './html';

function SvgPreview({ ctx }: { ctx: FilePreviewContext }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    ctx
      .readFile()
      .then((source) => {
        if (live) setHtml(source);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [ctx]);

  if (error) {
    return <div className="p-4 text-xs text-[var(--red)]">{error}</div>;
  }
  if (html === null) {
    return <div className="p-4 text-xs text-[var(--text-secondary)]">Loading…</div>;
  }
  // Inlined (sanitized) so the SVG scales with the container instead of being
  // rasterized like a bitmap image.
  return (
    <div className="axn-svg-preview flex h-full items-center justify-center p-4">
      <HtmlPreview html={html} ctx={ctx} />
    </div>
  );
}

export const svgPreviewPlugin: FilePreviewPlugin = {
  id: 'svg',
  title: 'SVG',
  version: '0.1.0',
  matches: extensionMatcher(['svg']),
  render: (ctx) => <SvgPreview ctx={ctx} />,
};
