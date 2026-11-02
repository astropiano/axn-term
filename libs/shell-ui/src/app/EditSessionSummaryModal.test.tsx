// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '../i18n';
import type { ShellSession } from '../types';
import { SESSION_SUMMARY_MAX } from './hiddenCommands';
import { EditSessionSummaryModal } from './EditSessionSummaryModal';

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

const session = (summary: string): ShellSession => ({
  id: 's1',
  workspaceId: 'w1',
  name: 'work · zsh',
  topic: '',
  summary,
  tasks: [],
  progress: 0,
  output: '',
});

const render = (node: ReactNode) =>
  act(() => root.render(<I18nProvider i18n={i18n}>{node}</I18nProvider>));

const renderModal = (summary = 'one\ntwo', onSave = vi.fn(), onCancel = vi.fn()) => {
  render(
    <EditSessionSummaryModal
      session={session(summary)}
      width={200}
      onSave={onSave}
      onCancel={onCancel}
    />,
  );
  return { onSave, onCancel };
};

const textarea = () => container.querySelector('textarea')!;

const typeText = (value: string) => {
  // React's controlled input only sees changes through its own value setter.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const clickButton = (label: string) => {
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === label,
  )!;
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

describe('EditSessionSummaryModal', () => {
  it('seeds the textarea with the current summary and saves trimmed text', () => {
    const { onSave } = renderModal('  padded  ');
    expect(textarea().value).toBe('  padded  ');
    clickButton('Save');
    expect(onSave).toHaveBeenCalledWith('padded');
  });

  it('saves the edited text', () => {
    const { onSave } = renderModal('old');
    typeText('new\nlines');
    clickButton('Save');
    expect(onSave).toHaveBeenCalledWith('new\nlines');
  });

  it('an empty summary saves as an empty string (clears it)', () => {
    const { onSave } = renderModal('had one');
    typeText('   ');
    clickButton('Save');
    expect(onSave).toHaveBeenCalledWith('');
  });

  it('Escape cancels without saving', () => {
    const { onSave, onCancel } = renderModal();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl+Enter inside the textarea saves', () => {
    const { onSave } = renderModal('keep');
    act(() =>
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
      ),
    );
    expect(onSave).toHaveBeenCalledWith('keep');
  });

  it('caps input at SESSION_SUMMARY_MAX', () => {
    renderModal();
    expect(textarea().maxLength).toBe(SESSION_SUMMARY_MAX);
  });

  it('warns when the text overflows the panel’s three-line clamp', () => {
    renderModal('short');
    const mirror = container.querySelector<HTMLElement>('.line-clamp-3')!;
    expect(mirror).toBeTruthy();
    expect(container.textContent).not.toContain('longer than three lines');

    // happy-dom does no layout — fake the mirror's metrics, then retype to
    // re-run the measurement.
    Object.defineProperty(mirror, 'scrollHeight', { value: 120, configurable: true });
    Object.defineProperty(mirror, 'clientHeight', { value: 40, configurable: true });
    typeText('long');
    expect(container.textContent).toContain('longer than three lines');
  });
});
