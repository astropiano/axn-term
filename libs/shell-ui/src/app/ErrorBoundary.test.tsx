// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { ErrorBoundary } from './ErrorBoundary';
import { safely } from '../terminalRenderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // React logs caught errors to console.error — keep the test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const render = (node: ReactNode) =>
  act(() => root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>));

function Boom(): ReactNode {
  throw new Error('render exploded');
}

/** Stands in for a terminal view whose unmount cleanup throws. */
function BadCleanup() {
  useEffect(() => () => {
    throw new Error('dispose exploded');
  }, []);
  return <div>tab content</div>;
}

describe('ErrorBoundary', () => {
  it('replaces only the failing subtree with an error panel', () => {
    render(
      <div>
        <span>sibling stays</span>
        <ErrorBoundary scope="shell tab — build">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(container.textContent).toContain('sibling stays');
    expect(container.textContent).toContain('This view hit an unexpected error');
    expect(container.textContent).toContain('render exploded');
  });

  it('catches an error thrown by a closed view’s cleanup instead of blanking the app', () => {
    render(
      <ErrorBoundary kind="app" scope="axn-term">
        <BadCleanup />
      </ErrorBoundary>,
    );
    // Closing the tab unmounts the view; its cleanup throws.
    render(<ErrorBoundary kind="app" scope="axn-term">{null}</ErrorBoundary>);
    expect(container.textContent).toContain('axn-term hit an unexpected error');
    expect(container.textContent).toContain('dispose exploded');
  });

  it('remounts the view on Reload view', () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('once');
      return <div>recovered</div>;
    }
    render(
      <ErrorBoundary scope="tab">
        <Flaky />
      </ErrorBoundary>,
    );
    fail = false;
    const reload = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Reload view'),
    );
    act(() => reload?.click());
    expect(container.textContent).toContain('recovered');
  });
});

describe('safely', () => {
  it('swallows a throwing teardown step and keeps going', () => {
    const steps: string[] = [];
    safely('first', () => {
      throw new Error('nope');
    });
    safely('second', () => steps.push('ran'));
    expect(steps).toEqual(['ran']);
  });
});
