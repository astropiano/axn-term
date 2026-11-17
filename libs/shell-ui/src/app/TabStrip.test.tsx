// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { TabStrip } from './TabStrip';

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
  vi.restoreAllMocks();
});

function mockScroller(scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
  vi.spyOn(HTMLElement.prototype, 'scrollLeft', 'get').mockReturnValue(scrollLeft);
}

const render = (activeTab = 'a') =>
  act(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <TabStrip activeTab={activeTab}>
          <button data-tab-id="a">a</button>
          <button data-tab-id="b">b</button>
        </TabStrip>
      </I18nProvider>,
    ),
  );

const arrows = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label]'));

describe('TabStrip', () => {
  it('shows no scroll arrows when the tabs fit', () => {
    mockScroller(300, 300);
    render();
    expect(arrows()).toHaveLength(0);
  });

  it('shows arrows when tabs overflow, left disabled at the start', () => {
    mockScroller(900, 300, 0);
    render();
    const [left, right] = arrows();
    expect(left.disabled).toBe(true);
    expect(right.disabled).toBe(false);
  });

  it('right arrow scrolls the tab row, not the page', () => {
    mockScroller(900, 300, 0);
    const scrollBy = vi.fn();
    HTMLElement.prototype.scrollBy = scrollBy as never;
    render();
    act(() => arrows()[1].click());
    expect(scrollBy).toHaveBeenCalledWith({ left: 240, behavior: 'smooth' });
  });

  it('scrolls the active tab into view when it changes', () => {
    mockScroller(900, 300);
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    render('a');
    scrollIntoView.mockClear();
    render('b');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(container.querySelector('[data-tab-id="b"]'));
  });
});
