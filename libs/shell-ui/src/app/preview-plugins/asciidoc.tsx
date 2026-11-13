import { useEffect, useState } from 'react';
import { extensionMatcher } from './plugin';
import type { FilePreviewContext, FilePreviewPlugin } from './plugin';
import { HtmlPreview } from './html';

function AsciidocPreview({ ctx }: { ctx: FilePreviewContext }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const source = await ctx.readFile();
        const { convert } = await import('asciidoctor');
        // `[mermaid]` blocks compile to a plain listing without a language
        // class; rewriting the style to `[source,mermaid]` makes them
        // detectable as `code.language-mermaid` for the diagram renderer.
        const normalized = source.replace(/^\[mermaid(?:\s*,[^\]]*)?\]\s*$/gm, '[source,mermaid]');
        // `safe` mode: no file includes — the webview can't resolve them
        // anyway. `to_file: false` forces a string result for string input.
        const rendered = await convert(normalized, {
          safe: 'safe',
          to_file: false,
          attributes: { showtitle: true },
        });
        if (live) setHtml(String(rendered));
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
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
  return <HtmlPreview html={html} ctx={ctx} />;
}

export const asciidocPreviewPlugin: FilePreviewPlugin = {
  id: 'asciidoc',
  title: 'AsciiDoc',
  version: '0.1.0',
  matches: extensionMatcher(['adoc', 'asciidoc', 'asc', 'ad']),
  render: (ctx) => <AsciidocPreview ctx={ctx} />,
};
