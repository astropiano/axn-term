import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { shellServices } from '../../services';
import { useSettings } from '../../SettingsProvider';
import { renderMermaidInto } from './mermaidRender';
import type { FilePreviewContext } from './plugin';

// The sanitized markup is injected into the app document itself, so beyond
// DOMPurify's script/handler stripping it must not restyle or navigate the
// app: no <style> sheets (inline `style` attributes stay — asciidoctor column
// widths and SVG fills use them), no forms or form submission targets, no
// embedded documents or document-level <link>/<meta>/<base>. <input> and
// <button> stay: GFM task lists render disabled checkboxes, surfaces may use
// `<button data-axn-action>`, and without a form neither can submit.
const SANITIZE_OPTS = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: [
    'style',
    'form',
    'textarea',
    'select',
    'iframe',
    'object',
    'embed',
    'link',
    'meta',
    'base',
  ],
  FORBID_ATTR: ['action', 'formaction', 'form'],
};

export function sanitizePreviewHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_OPTS);
}

function isRemoteRef(src: string): boolean {
  return /^(https?:|data:|blob:|asset:|tauri:)/i.test(src);
}

/**
 * Post-process sanitized markup in place:
 * - `code.language-mermaid` blocks (marked ```mermaid fences, asciidoctor
 *   `[source,mermaid]`/`[mermaid]` listings) become rendered diagrams.
 * - `img[src]` with a relative path is read through `ctx.readSibling` and
 *   swapped for a blob URL (the webview cannot load file:// URIs).
 */
async function enhanceDom(
  root: HTMLElement,
  ctx: FilePreviewContext,
  theme: 'dark' | 'default',
  live: () => boolean,
  objectUrls: string[],
): Promise<void> {
  const codeBlocks = [...root.querySelectorAll('code.language-mermaid')];
  for (const code of codeBlocks) {
    if (!live()) return;
    const host = code.closest('pre') ?? code;
    const holder = document.createElement('div');
    holder.className = 'axn-mermaid';
    host.replaceWith(holder);
    // Intentionally not awaited one-by-one is fine, but sequential keeps
    // mermaid's internal id allocation deterministic.
    await renderMermaidInto(holder, code.textContent ?? '', theme);
  }

  const images = [...root.querySelectorAll<HTMLImageElement>('img[src]')];
  for (const img of images) {
    if (!live()) return;
    const src = img.getAttribute('src') ?? '';
    if (!src || isRemoteRef(src)) continue;
    let rel = src;
    try {
      rel = decodeURIComponent(src);
    } catch {
      // keep raw src
    }
    try {
      const bytes = await ctx.readSibling(rel);
      if (!live()) return;
      const url = URL.createObjectURL(new Blob([bytes]));
      objectUrls.push(url);
      img.src = url;
    } catch {
      // leave the broken src — the alt text still shows
    }
  }
}

/**
 * Renders an HTML string (sanitized) as a preview body. Used by the built-in
 * markdown/asciidoc/svg plugins and by external `.mjs` plugins whose `render`
 * returns a string.
 */
export function HtmlPreview({ html, ctx }: { html: string; ctx: FilePreviewContext }) {
  const ref = useRef<HTMLDivElement>(null);
  const { activeTheme } = useSettings();
  const theme = activeTheme.mode === 'light' ? 'default' : 'dark';
  const clean = sanitizePreviewHtml(html);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    const objectUrls: string[] = [];
    void enhanceDom(root, ctx, theme, () => live, objectUrls);
    return () => {
      live = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
    // `clean` is derived from `html`; `ctx` is memoized per tab.
  }, [clean, ctx, theme]);

  return (
    <div
      ref={ref}
      className="axn-prose"
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest('a');
        const href = anchor?.getAttribute('href');
        if (!href) return;
        e.preventDefault();
        if (/^https?:/i.test(href)) {
          const open = shellServices()?.openExternal ?? ((u: string) => window.open(u, '_blank', 'noopener'));
          open(href);
        }
      }}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
