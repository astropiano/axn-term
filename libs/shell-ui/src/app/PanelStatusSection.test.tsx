// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '@lingui/react';
import { i18n } from '../i18n';
import { PanelStatusSection } from './PanelStatusSection';
import { publishPanelStatus, resetPanelStatus, type StatusGroup } from './panelStatus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const memory: StatusGroup = {
  title: 'Memory',
  system: true,
  meters: [
    { label: 'RAM', value: '55%', pct: 55, level: 0, detail: '17.6 GB of 32.0 GB' },
    { label: 'Swap', value: '1.2 GB', pct: 30, level: 1 },
  ],
};
const docker: StatusGroup = {
  title: 'Docker',
  meters: [
    { label: 'Containers', summaryLabel: 'Running', value: '5', detail: '5 running · 2 stopped' },
    { label: 'Memory', summaryLabel: 'Mem', value: '85%', pct: 85, level: 2, color: 'var(--orange)' },
  ],
};
const mrs: StatusGroup = {
  title: 'Merge requests',
  meters: [{ label: 'Mine', value: '2/7', detail: 'need action' }],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetPanelStatus();
});

async function render(props: Partial<Parameters<typeof PanelStatusSection>[0]> = {}) {
  await act(async () =>
    root.render(
      <I18nProvider i18n={i18n}>
        <PanelStatusSection
          systemExpanded
          onToggleSystem={() => {}}
          sourceOrder={['glab-mr', 'docker']}
          {...props}
        />
      </I18nProvider>,
    ),
  );
}

const headers = () => [...host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
const names = () => headers().map((b) => b.querySelector('.font-semibold')?.textContent);

it('renders nothing while nothing is published', async () => {
  await render();
  expect(host.innerHTML).toBe('');
});

it('stacks one accordion per tool in rail order, with System last', async () => {
  publishPanelStatus('ram', memory);
  publishPanelStatus('docker', docker);
  publishPanelStatus('glab-mr', mrs);
  await render();
  // No parent header: every accordion is a sibling at the top level.
  expect(names()).toEqual(['Merge requests', 'Docker', 'System']);
  expect(headers().every((b) => b.parentElement?.parentElement === host.firstElementChild)).toBe(true);
});

it('keeps tools collapsed by default with their key numbers, System open with its details', async () => {
  publishPanelStatus('ram', memory);
  publishPanelStatus('docker', docker);
  await render();
  const [dockerHeader, systemHeader] = headers();
  expect(dockerHeader.getAttribute('aria-expanded')).toBe('false');
  // Collapsed: one line of "label value" pairs, the warning first.
  expect(dockerHeader.textContent).toBe('DockerMem 85%Running 5');
  expect(systemHeader.getAttribute('aria-expanded')).toBe('true');
  expect(systemHeader.textContent).toBe('System');
  // The docker VM stays out of System: only the machine's meters are below it.
  const systemBody = document.getElementById(systemHeader.getAttribute('aria-controls')!)!;
  expect(systemBody.textContent).toContain('RAM');
  expect(systemBody.textContent).toContain('17.6 GB of 32.0 GB');
  expect(systemBody.textContent).not.toContain('Containers');
});

it('expands each accordion on its own', async () => {
  publishPanelStatus('ram', memory);
  publishPanelStatus('docker', docker);
  publishPanelStatus('glab-mr', mrs);
  const onToggleGroup = vi.fn();
  const onToggleSystem = vi.fn();
  await render({ systemExpanded: false, expandedGroups: ['docker'], onToggleGroup, onToggleSystem });
  const [mrHeader, dockerHeader, systemHeader] = headers();
  expect(headers().map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);
  expect(document.getElementById(dockerHeader.getAttribute('aria-controls')!)!.textContent).toContain(
    '5 running · 2 stopped',
  );
  expect(systemHeader.textContent).toBe('SystemRAM 55%Swap 1.2 GB');
  await act(async () => mrHeader.click());
  expect(onToggleGroup).toHaveBeenCalledWith('glab-mr');
  await act(async () => systemHeader.click());
  expect(onToggleSystem).toHaveBeenCalledTimes(1);
});

it('shows no System accordion without machine-level groups, and draws the icon it is given', async () => {
  publishPanelStatus('docker', docker);
  await render({ renderIcon: ({ source }) => <i data-icon={source} /> });
  expect(names()).toEqual(['Docker']);
  expect(host.querySelector('[data-icon="docker"]')).not.toBeNull();
});
