// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import { describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { ShellServices } from '@axn-term/session-backend';
import { i18n } from '../i18n';
import { AppContextMenu, appMenuTarget } from './AppContextMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('terminal Copy', () => {
  it('copies the selection captured at right-click, even if the terminal changes it after', async () => {
    let live = 'select this whole sentence';
    const term = { getSelection: () => live } as unknown as Terminal;
    const target = appMenuTarget(document.createElement('span'), () => term);
    // what xterm's right-click word selection used to do before Copy ran
    live = '';
    const copyText = vi.fn();
    const services = { copyText } as unknown as ShellServices;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <I18nProvider i18n={i18n}>
          <AppContextMenu
            x={0}
            y={0}
            target={target}
            services={services}
            reloadShortcut="⌘⇧R"
            onReload={() => {}}
            onClose={() => {}}
          />
        </I18nProvider>,
      );
    });
    const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    expect(copy?.disabled).toBe(false);
    await act(async () => copy!.click());
    expect(copyText).toHaveBeenCalledWith('select this whole sentence');
    act(() => root.unmount());
  });
});
