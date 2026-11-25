// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { i18n } from './i18n';
import { PathActionMenu } from './PathActionMenu';
import { ShellServicesProvider } from './services';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mockServices = {
  copyText: vi.fn().mockResolvedValue(undefined),
  openExternal: vi.fn(),
  revealPath: vi.fn(),
  revealLabel: 'Finder',
  hasFilePreview: vi.fn().mockReturnValue(true),
};

const mockFileReader = () => ({
  readText: vi.fn().mockResolvedValue('line 1\nline 2'),
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function renderMenu(props: Parameters<typeof PathActionMenu>[0]) {
  await act(async () => {
    root!.render(
      <I18nProvider i18n={i18n}>
        <ShellServicesProvider services={mockServices} fileReader={mockFileReader}>
          <PathActionMenu {...props} />
        </ShellServicesProvider>
      </I18nProvider>,
    );
  });
}

it('renders action buttons on one row and path on its own line below it for inline variant', async () => {
  const longPath = '/Volumes/MgnlDevExtended/github/axn-term/libs/shell-ui/src/PathActionMenu.tsx';
  await renderMenu({
    resolvedPath: longPath,
    isDir: false,
    variant: 'inline',
  });

  const pathEl = container?.querySelector('.break-all');
  expect(pathEl).not.toBeNull();
  expect(pathEl?.textContent).toBe(longPath);
  expect(pathEl?.classList.contains('select-text')).toBe(true);

  // Check buttons
  const buttons = container?.querySelectorAll('button');
  expect(buttons && buttons.length).toBeGreaterThan(0);

  // Check divider exists between header and preview
  const divider = container?.querySelector('.border-b');
  expect(divider).not.toBeNull();
});

it('does not duplicate URL preview below divider when isUrl is true in inline variant', async () => {
  const url = 'https://github.com/example/repo/pull/123';
  await renderMenu({
    resolvedPath: url,
    isDir: false,
    isUrl: true,
    variant: 'inline',
  });

  const pathEl = container?.querySelector('.break-all');
  expect(pathEl?.textContent).toBe(url);

  // No preview divider or duplicate URL preview below
  const divider = container?.querySelector('.border-b');
  expect(divider).toBeNull();
});

it('renders copy-only variant without preview divider', async () => {
  await renderMenu({
    resolvedPath: 'some-selected-token',
    isDir: false,
    copyOnly: true,
    variant: 'inline',
  });

  const pathEl = container?.querySelector('.break-all');
  expect(pathEl?.textContent).toBe('some-selected-token');

  const divider = container?.querySelector('.border-b');
  expect(divider).toBeNull();
});
