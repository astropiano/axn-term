import type { CSSProperties } from 'react';
import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';

/**
 * DOMPurify `afterSanitizeAttributes` hook for markup injected into the app
 * document: inline styles lose `position: fixed/sticky` (so nothing can lay
 * itself over the app) and are re-serialized from what the engine parsed,
 * so no unparsed text slips through. Shared by file previews and SVG icons.
 */
export function containInlineStyle(node: Element): void {
  if (!node.hasAttribute?.('style')) return;
  const style = (node as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!style) {
    node.removeAttribute('style');
    return;
  }
  if (/fixed|sticky/i.test(style.getPropertyValue('position'))) style.removeProperty('position');
  if (style.length) node.setAttribute('style', style.cssText);
  else node.removeAttribute('style');
}

// SVG-only profile: no HTML elements, no <style>/<script>/<foreignObject>
// (foreignObject re-enters HTML). DOMPurify already drops `on*` handlers and
// `javascript:` URIs in href/xlink:href.
const SVG_ICON_OPTS = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['style', 'foreignObject', 'script'],
};

// a url() reference that does not point into the icon itself (`url(#grad)`)
const EXTERNAL_URL_REF = /url\(\s*['"]?\s*(?!#)/i;

let purifier: Purifier | undefined;

function svgIconPurifier(): Purifier {
  if (purifier) return purifier;
  // own instance, so the hooks do not affect other DOMPurify users
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    containInlineStyle(el);
    // An icon references only its own parts (`<use href="#a">`, `fill="url(#g)"`):
    // anything else (`<image href="https://…">`, `filter="url(https://…)"`)
    // would load from the network every time the icon renders.
    for (const attr of [...(el.attributes ?? [])]) {
      const isHref = attr.localName === 'href';
      if ((isHref && !attr.value.trim().startsWith('#')) || EXTERNAL_URL_REF.test(attr.value)) {
        el.removeAttributeNode(attr);
      }
    }
  });
  purifier = p;
  return p;
}

/**
 * Sanitize an inline-SVG `sessionIcons` value before it is injected as HTML.
 * Icon values come from config.yaml, config import and workspace sets, so
 * they are untrusted markup.
 */
export function sanitizeSvgIcon(svg: string): string {
  return svgIconPurifier().sanitize(svg, SVG_ICON_OPTS);
}

/**
 * Inline style for the element hosting a sanitized SVG icon: the containing
 * block for anything positioned inside, its own stacking context, and a clip
 * a few px outside its box (hosts like the rail draw the svg slightly larger
 * than the span) — so an icon cannot cover or intercept clicks on the app.
 */
export const svgIconContainStyle: CSSProperties = {
  position: 'relative',
  isolation: 'isolate',
  clipPath: 'inset(-4px)',
};
