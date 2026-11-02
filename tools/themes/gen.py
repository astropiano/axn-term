#!/usr/bin/env python3
"""Generate axn-term theme YAMLs (and a JSON for the design canvas) from one
palette table, applying the same readability rules to every theme.

Rules (WCAG contrast against the terminal background):
  foreground            >= 7.0   (Solarized keeps its low-contrast look: 6.0)
  ANSI text colours     >= 4.5   red..cyan, their brights; white on dark themes
  bright black          >= 3.5   comments, autosuggestions: dim but legible
                                 (light themes: brights >= 3.0, white/brightWhite exempt)
  selection             foreground on it >= 4.5
  ui.textSecondary      >= 4.5 on ui.bg;  ui.accent >= 4.5 on ui.bg
A colour that misses its target keeps its hue and saturation; only its
lightness moves away from the background until it passes.
"""
import colorsys, json, sys, os

def hx(h):
    h = h.lstrip('#'); return tuple(int(h[i:i+2], 16) / 255 for i in (0, 2, 4))
def tohex(c):
    return '#%02X%02X%02X' % tuple(max(0, min(255, round(v * 255))) for v in c)
def lum(h):
    c = [v / 12.92 if v <= .03928 else ((v + .055) / 1.055) ** 2.4 for v in hx(h)]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]
def ratio(a, b):
    x, y = lum(a), lum(b); return (max(x, y) + .05) / (min(x, y) + .05)
def mix(a, b, t):
    A, B = hx(a), hx(b); return tohex(tuple(A[i] + (B[i] - A[i]) * t for i in range(3)))

def lift(color, bg, target):
    """Move `color`'s HLS lightness away from `bg` until ratio >= target."""
    if ratio(color, bg) >= target: return color.upper()
    h, l, s = colorsys.rgb_to_hls(*hx(color))
    up = lum(bg) < 0.18
    for _ in range(200):
        l = min(1, l + 0.005) if up else max(0, l - 0.005)
        c = tohex(colorsys.hls_to_rgb(h, l, s))
        if ratio(c, bg) >= target: return c
    return c

def sink(sel, bg, fg, target=4.5):
    """Move a selection colour toward the background until fg on it passes."""
    if ratio(fg, sel) >= target: return sel.upper()
    for i in range(1, 101):
        c = mix(sel, bg, i / 100)
        if ratio(fg, c) >= target: return c
    return bg

ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
        'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
        'brightMagenta', 'brightCyan', 'brightWhite']

def build(t):
    c = dict(t['colors']); bg = c['background']; dark = t['mode'] == 'dark'
    changed = {}
    def fix(key, target):
        new = lift(c[key], bg, target)
        if new.upper() != c[key].upper(): changed[key] = (c[key].upper(), new)
        c[key] = new
    fix('foreground', t.get('fgTarget', 7.0))
    for k in ANSI:
        if k == 'black': continue
        if k == 'brightBlack': fix(k, 3.5); continue
        if not dark and k in ('white', 'brightWhite'): continue
        fix(k, 4.5 if (dark or not k.startswith('bright')) else 3.0)
    sel = sink(c['selectionBackground'], bg, c['foreground'])
    if sel.upper() != c['selectionBackground'].upper():
        changed['selectionBackground'] = (c['selectionBackground'].upper(), sel)
    c['selectionBackground'] = sel
    c['selectionForeground'] = c['foreground']
    c.setdefault('cursorAccent', bg)
    c.setdefault('orange', t.get('orange', '#F97316'))
    c.setdefault('violet', c['magenta'])

    u = dict(t.get('ui') or {})
    fg = c['foreground']
    u.setdefault('bg', bg)
    u.setdefault('bgSecondary', mix(bg, fg, 0.05 if dark else 0.04))
    u.setdefault('surface', u['bgSecondary'])
    u.setdefault('surfaceHover', mix(bg, fg, 0.11 if dark else 0.08))
    u.setdefault('border', mix(bg, fg, 0.2 if dark else 0.16))
    u.setdefault('text', fg)
    u.setdefault('textSecondary', mix(fg, bg, 0.3))
    u.setdefault('textInverted', bg)
    u.setdefault('accent', c['blue'])
    u.setdefault('cursor', c['cursor'])
    for k, target in (('textSecondary', 4.5), ('accent', 4.5)):
        new = lift(u[k], u['bg'], target)
        if new.upper() != u[k].upper(): changed['ui.' + k] = (u[k].upper(), new)
        u[k] = new
    u.setdefault('accentHover', lift(mix(u['accent'], fg, 0.3), u['bg'], 4.5))
    out = {'id': t['id'], 'name': t['name'], 'mode': t['mode'],
           'colors': {k: v.upper() for k, v in c.items()},
           'ui': {k: v.upper() for k, v in u.items()}}
    return out, changed

def credits(theme_id):
    from palettes import UPSTREAM, SOURCES
    return [UPSTREAM[k] for k in SOURCES.get(theme_id, [])]

def yaml_of(theme, meta, changed):
    L = []
    for line in meta['about'].strip().splitlines(): L.append('# ' + line if line else '#')
    for name, url, lic, holder in credits(theme['id']):
        L.append(f'# Palette: {name} <{url}>, {lic}. {holder}.')
    if changed:
        L.append('# Adjusted for legibility (hue kept, lightness moved):')
        for k, (a, b) in changed.items(): L.append(f'#   {k}: {a} -> {b}')
    L += [f"id: {theme['id']}", f"name: {theme['name']}", f"mode: {theme['mode']}", '', 'colors:']
    order = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
             'selectionForeground', ''] + ANSI[:8] + [''] + ANSI[8:] + ['', 'orange', 'violet']
    for k in order:
        L.append('' if k == '' else f"  {k}: '{theme['colors'][k]}'")
    L += ['', 'ui:']
    for k in ['bg', 'bgSecondary', 'surface', 'surfaceHover', 'text', 'textSecondary',
              'textInverted', 'border', 'accent', 'accentHover', 'cursor']:
        L.append(f"  {k}: '{theme['ui'][k]}'")
    return '\n'.join(L) + '\n'

MIT_TEXT = """Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

def notices():
    from palettes import THEMES, UPSTREAM, SOURCES
    used = {}
    for t in THEMES:
        for k in SOURCES.get(t['id'], []): used.setdefault(k, []).append(t['name'])
    L = ['# Third-party theme palettes', '',
         'Generated by `tools/themes/gen.py` from `tools/themes/palettes.py`; do not edit.', '',
         'The Axn themes are axn-term\'s own. Every other bundled theme is a port of the',
         'palette below. Colours were adjusted for legibility where each theme file says so.', '']
    for k, (name, url, lic, holder) in sorted(UPSTREAM.items(), key=lambda kv: kv[1][0].lower()):
        if k not in used: continue
        L += [f'## {name}', '', f'- Source: <{url}>', f'- License: {lic}', f'- {holder}',
              f'- Used by: {", ".join(used[k])}', '']
    L += ['## MIT License', '', 'Applies to every palette above marked MIT, with its copyright line.', '',
          '```', MIT_TEXT.rstrip(), '```', '']
    return '\n'.join(L)

if __name__ == '__main__':
    from palettes import THEMES, SOURCES
    outdir, canvas_json = sys.argv[1], sys.argv[2]
    missing = [t['id'] for t in THEMES if t['group'] != 'axn' and t['id'] not in SOURCES]
    if missing: sys.exit(f'no SOURCES entry (licence credit) for: {", ".join(missing)}')
    canvas = []
    for t in THEMES:
        theme, changed = build(t)
        with open(os.path.join(outdir, t['id'] + '.yaml'), 'w') as f:
            f.write(yaml_of(theme, t, changed))
        c = theme['colors']
        canvas.append({**theme, 'group': t['group'], 'tagline': t['tagline'],
                       'changed': {k: list(v) for k, v in changed.items()},
                       'fgRatio': round(ratio(c['foreground'], c['background']), 1),
                       'minAnsi': round(min(ratio(c[k], c['background']) for k in ANSI[1:7]), 1),
                       'dimRatio': round(ratio(c['brightBlack'], c['background']), 1)})
        print(f"{t['id']:20} fg {canvas[-1]['fgRatio']:5} minAnsi {canvas[-1]['minAnsi']:4} dim {canvas[-1]['dimRatio']:4}  changed {len(changed)}")
    json.dump(canvas, open(canvas_json, 'w'), indent=1)
    with open(os.path.join(outdir, 'THIRD_PARTY_NOTICES.md'), 'w') as f:
        f.write(notices())
