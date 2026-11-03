// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MrDescription } from './mrDescription';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (node: ReactNode) => {
  await act(async () => {
    root.render(node);
    // let the lazy marked import + parse settle before asserting
    await import('marked');
    await Promise.resolve();
  });
};

const prose = () => container.querySelector<HTMLElement>('.axn-prose-compact')!;

describe('MrDescription', () => {
  it('renders markdown — bold, code, lists', async () => {
    await render(<MrDescription markdown={'**bold** and `code`\n\n- one\n- two'} />);
    expect(prose().innerHTML).toContain('<strong>bold</strong>');
    expect(prose().innerHTML).toContain('<code>code</code>');
    expect(prose().querySelectorAll('li')).toHaveLength(2);
  });

  it('renders a leading # heading inside the compact prose body', async () => {
    await render(<MrDescription markdown={'# Title\n\nbody text'} />);
    expect(prose().querySelector('h1')?.textContent).toBe('Title');
  });

  it('keeps markdown links as anchors (the row must not wrap it in one)', async () => {
    await render(<MrDescription markdown="see [the ticket](https://example.com/t)" />);
    expect(prose().querySelector('a')?.getAttribute('href')).toBe('https://example.com/t');
  });

  it('sanitizes injected markup', async () => {
    await render(
      <MrDescription markdown={'hello <img src=x onerror="window.__x=1"><script>window.__y=1</script>'} />,
    );
    expect(prose().innerHTML).not.toMatch(/onerror|<script/);
  });

  it('shows raw markdown until the parse resolves', () => {
    act(() => root.render(<MrDescription markdown="**pending**" />));
    const el = container.querySelector<HTMLElement>('.line-clamp-4')!;
    expect(el.classList.contains('axn-prose-compact')).toBe(false);
    expect(el.textContent).toBe('**pending**');
  });

  it('clamps to 4 lines and expands via the toggle', async () => {
    // jsdom has no layout — pretend the content overflows the clamp.
    const scroll = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(200);
    const client = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(40);
    try {
      await render(<MrDescription markdown={'one\n\ntwo\n\nthree\n\nfour\n\nfive'} />);
      expect(prose().classList.contains('line-clamp-4')).toBe(true);
      const toggle = container.querySelector('button')!;
      expect(toggle.textContent).toBe('show more');
      await act(async () => {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(prose().classList.contains('line-clamp-4')).toBe(false);
      expect(container.querySelector('button')!.textContent).toBe('show less');
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it('hides the toggle when the description fits the clamp', async () => {
    await render(<MrDescription markdown="short" />);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('compact prose stylesheet', () => {
  const css = readFileSync(join(__dirname, '../../styles.css'), 'utf8');
  const rule = /\.axn-prose-compact h1[^{]*\{([^}]*)\}/.exec(css);

  it('knocks every heading down to body size', () => {
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(css).toContain(`.axn-prose-compact ${h}`);
    }
    expect(rule?.[1]).toMatch(/font-size:\s*1em/);
    expect(rule?.[1]).toMatch(/border:\s*none/);
  });
});
