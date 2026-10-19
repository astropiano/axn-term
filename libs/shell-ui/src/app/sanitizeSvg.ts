import DOMPurify from 'dompurify';

// SVG-only profile: no HTML elements, no <style>/<script>/<foreignObject>
// (foreignObject re-enters HTML). DOMPurify already drops `on*` handlers and
// `javascript:` URIs in href/xlink:href.
const SVG_ICON_OPTS = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['style', 'foreignObject', 'script'],
};

/**
 * Sanitize an inline-SVG `sessionIcons` value before it is injected as HTML.
 * Icon values come from config.yaml, config import and workspace sets, so
 * they are untrusted markup.
 */
export function sanitizeSvgIcon(svg: string): string {
  return DOMPurify.sanitize(svg, SVG_ICON_OPTS);
}
