// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewContainStyle, sanitizePreviewHtml } from './html';

describe('sanitizePreviewHtml', () => {
  it('drops <style> sheets but keeps inline style attributes', () => {
    const clean = sanitizePreviewHtml(
      '<style>body{display:none}</style><table><col style="width: 50%;"></table><p>text</p>',
    );
    expect(clean).not.toContain('<style');
    expect(clean).not.toContain('display:none');
    expect(clean).toContain('style="width: 50%;"');
    expect(clean).toContain('<p>text</p>');
  });

  it('drops forms and form submission targets', () => {
    const clean = sanitizePreviewHtml(
      '<form action="https://evil.example/"><input name="pw" type="password"><textarea></textarea><select><option>a</option></select><button formaction="https://evil.example/">go</button></form><button form="app-form">x</button>',
    );
    expect(clean).not.toMatch(/<form|<textarea|<select|action=|formaction|form="/);
    expect(clean).toContain('<button>go</button>');
  });

  it('drops embedded documents and document-level elements', () => {
    const clean = sanitizePreviewHtml(
      '<iframe src="https://evil.example/"></iframe><object data="x"></object><embed src="x"><link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/"><p>ok</p>',
    );
    expect(clean).not.toMatch(/iframe|object|embed|<link|<meta|<base|evil/);
    expect(clean).toContain('<p>ok</p>');
  });

  it('keeps GFM task-list checkboxes and surface action buttons', async () => {
    const md = await marked.parse('- [x] done\n- [ ] todo\n', { gfm: true });
    const clean = sanitizePreviewHtml(md);
    expect(clean).toMatch(/<input[^>]*type="checkbox"/);
    expect(clean).toMatch(/<input[^>]*checked/);
    expect(sanitizePreviewHtml('<button data-axn-action="clear">clear</button>')).toBe(
      '<button data-axn-action="clear">clear</button>',
    );
  });

  it('keeps an inline SVG with inline styles', () => {
    const clean = sanitizePreviewHtml(
      '<svg viewBox="0 0 10 10"><rect width="10" height="10" style="fill:#f00"></rect></svg>',
    );
    expect(clean).toContain('<rect');
    // re-serialized by the CSS parser
    expect(clean).toMatch(/style="fill: ?(#f00|rgb\(255, 0, 0\));?"/);
  });
});

describe('preview markup cannot cover the app', () => {
  const overlay =
    '<div style="position:fixed;inset:0;z-index:2147483647;background:#fff">fake</div>';

  it('strips position:fixed and sticky from inline styles', () => {
    for (const html of [
      overlay,
      '<div style="POSITION: Fixed !important; top:0">x</div>',
      '<div style="position:/**/fixed">x</div>',
      '<p style="position:sticky;top:0;color:red">x</p>',
      '<svg><rect style="position:fixed" width="1" height="1"></rect></svg>',
    ]) {
      const clean = sanitizePreviewHtml(html);
      const el = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html').body
        .firstElementChild as HTMLElement;
      const inner = (el.querySelector('rect') ?? el) as HTMLElement;
      expect(inner.style?.getPropertyValue('position') ?? '', clean).not.toMatch(/fixed|sticky/i);
      expect(clean).not.toMatch(/fixed|sticky/i);
    }
    // other declarations survive
    expect(sanitizePreviewHtml('<p style="position:sticky;top:0;color:red">x</p>')).toContain('color: red');
    expect(sanitizePreviewHtml('<div style="position:relative">x</div>')).toContain('position: relative');
  });

  it('hosts the markup in a clipped, isolated container', () => {
    expect(previewContainStyle).toMatchObject({
      position: 'relative',
      contain: 'paint',
      isolation: 'isolate',
    });
  });

  it('keeps the .axn-prose stylesheet rule contained', () => {
    const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8');
    const rule = /\.axn-prose \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/contain:\s*paint/);
    expect(rule).toMatch(/isolation:\s*isolate/);
    expect(rule).toMatch(/position:\s*relative/);
  });
});
