// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { TabStrip, tabStartScroll } from './TabStrip';

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

/** Five 100px tabs starting at x=8 (the strip's padding), 4px apart. */
function strip(scrollLeft: number, clientWidth = 250) {
  const el = document.createElement('div');
  for (let i = 0; i < 5; i++) {
    const tab = document.createElement('div');
    Object.defineProperty(tab, 'offsetLeft', { value: 8 + i * 104 });
    Object.defineProperty(tab, 'offsetWidth', { value: 100 });
    el.appendChild(tab);
  }
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth });
  Object.defineProperty(el, 'scrollWidth', { value: 8 + 5 * 104 + 4 });
  return el;
}

describe('tabStartScroll', () => {
  it('forward step reveals the cut tab whole and lands on a tab start', () => {
    // View 0..250: tab 2 (216..316) is cut; it needs 324-250=74, next start is 104.
    expect(tabStartScroll(strip(0), 1)).toBe(104);
  });

  it('backward step lands on the start of the tab cut off on the left', () => {
    // View starts at 150: tab 1 (start 104) is cut on the left.
    expect(tabStartScroll(strip(150), -1)).toBe(104);
  });

  it('never steps past either end', () => {
    expect(tabStartScroll(strip(0), -1)).toBeUndefined();
    expect(tabStartScroll(strip(536 - 250), 1)).toBeUndefined();
  });
});
