// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import { CloseConfirmModal } from './CloseConfirmModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = (node: ReactNode) =>
  act(() => root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>));

const renderModal = (onConfirm = vi.fn(), onCancel = vi.fn()) => {
  render(
    <CloseConfirmModal
      sessionCount={3}
      runningCount={1}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onCancel };
};

describe('CloseConfirmModal auto-close countdown', () => {
  it('counts down from 10 and confirms on its own when it reaches 0', () => {
    const { onConfirm } = renderModal();
    expect(container.textContent).toContain('Closing automatically in 10s');
    expect(container.textContent).toContain('Close (10s)');

    act(() => vi.advanceTimersByTime(1000));
    expect(container.textContent).toContain('Closing automatically in 9s');
    expect(container.textContent).toContain('Close (9s)');
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(9000));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('confirms immediately on Enter without waiting for the countdown', () => {
    const { onConfirm } = renderModal();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape and never auto-confirms once unmounted', () => {
    const { onConfirm, onCancel } = renderModal();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The parent hides the modal in response to the cancel.
    act(() => root.render(null));
    act(() => vi.advanceTimersByTime(15_000));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
