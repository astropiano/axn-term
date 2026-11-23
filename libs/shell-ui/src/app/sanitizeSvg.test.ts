// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeSvgIcon } from './sanitizeSvg';

describe('sanitizeSvgIcon', () => {
  it('keeps a lucide-style icon intact', () => {
    const icon =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 11 2-2-2-2"></path><path d="M11 13h4"></path><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect></svg>';
    const clean = sanitizeSvgIcon(icon);
    expect(clean).toContain('<svg');
    expect(clean).toContain('viewBox="0 0 24 24"');
    expect(clean).toContain('stroke="currentColor"');
    expect(clean).toContain('<path d="m7 11 2-2-2-2"');
    expect(clean).toContain('<rect');
  });

  it('strips event handlers', () => {
    const clean = sanitizeSvgIcon(
      '<svg onload="alert(1)"><circle r="4" onclick="alert(2)"></circle><image href="x" onerror="alert(3)"></image></svg>',
    );
    expect(clean).not.toMatch(/onload|onclick|onerror|alert/);
    expect(clean).toContain('<circle');
  });

  it('strips javascript: links', () => {
    const clean = sanitizeSvgIcon(
      '<svg><a href="javascript:alert(1)"><circle r="4"></circle></a><a xlink:href="javascript:alert(2)"><rect></rect></a></svg>',
    );
    expect(clean).not.toMatch(/javascript:/i);
    expect(clean).toContain('<circle');
  });

  it('strips script, style, foreignObject and smuggled HTML', () => {
    const clean = sanitizeSvgIcon(
      '<svg><script>alert(1)</script><style>body{display:none}</style><foreignObject><img src="x" onerror="alert(2)"></foreignObject><path d="M0 0"></path></svg><img src="x" onerror="alert(3)">',
    );
    expect(clean).not.toMatch(/script|style|foreignobject|<img|onerror/i);
    expect(clean).toContain('<path d="M0 0"');
  });

  it('drops fixed/sticky positioning so an icon cannot cover the app', () => {
    const clean = sanitizeSvgIcon(
      '<svg style="position:fixed;inset:0;z-index:9999;color:red"><rect style="position: sticky; top: 0"></rect></svg>',
    );
    expect(clean).not.toMatch(/fixed|sticky/i);
    expect(clean).toMatch(/color:\s*red/);
  });

  it('keeps in-icon references but drops external ones', () => {
    const clean = sanitizeSvgIcon(
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="g"></linearGradient><path id="p" d="M0 0"></path></defs>' +
        '<a href="#p"><circle r="1"></circle></a><a href="https://evil.example/x"><rect></rect></a><rect fill="url(#g)"></rect>' +
        '<image href="https://evil.example/beacon.png"></image><image xlink:href="//evil.example/b.png"></image>' +
        '<rect filter="url(https://evil.example/f.svg#x)"></rect><circle style="fill: url(&quot;https://evil.example/p&quot;)"></circle></svg>',
    );
    expect(clean).toContain('href="#p"');
    expect(clean).toContain('fill="url(#g)"');
    expect(clean).not.toContain('evil.example');
  });
});
