// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workspaces: Workspace[] = [{ id: 'ws-1', name: 'api', collapsed: false }];
const session = (id: string, name: string): ShellSession => ({
  id,
  workspaceId: 'ws-1',
  name,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
});
const sessions = [session('s-1', 'server'), session('s-2', 'tests')];

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  localStorage.removeItem('axn-term:settings');
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

async function render(props: Partial<ComponentProps<typeof SessionPanel>>) {
  const noop = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders>
        <ShellServicesProvider services={{ copyText: noop, openExternal: noop }} fileReader={() => undefined}>
        <SessionPanel
          workspaces={workspaces}
          sessions={sessions}
          selectedSessionId="s-1"
          taskState={null}
          onSelectWorkspace={noop}
          onSelectSession={noop}
          onAddWorkspace={noop}
          onSaveWorkspaceSet={noop}
          onLoadWorkspaceSet={noop}
          onRenameWorkspace={noop}
          onDeleteWorkspace={noop}
          onToggleWorkspace={noop}
          updateWorkspace={noop}
          onAddSession={noop}
          onMoveSession={noop}
          onReorderWorkspace={noop}
          onMoveWorkspace={noop}
          onRenameSession={noop}
          onDuplicateSession={noop}
          onCloseSession={noop}
          updateSession={noop}
          mergePluginState={noop}
          plugins={[]}
          onOpenBrowser={noop}
          onOpenTab={noop}
          onOpenSubShell={() => undefined}
          onTurnIntoWorkspace={noop}
          pluginData={{}}
          mergePluginData={noop}
          {...props}
        />
        </ShellServicesProvider>
      </StoryShellProviders>,
    ),
  );
}

const fieldPlugin: SessionViewPlugin = {
  id: 'probe',
  title: 'probe',
  sessionFields: [
    { id: 'badge', label: 'Badge', kind: 'inline', zone: 'title', value: (c) => <span>badge-{c.session.name}</span> },
    { id: 'line', label: 'Line', kind: 'inline', zone: 'always', value: (c) => <span>line-{c.session.name}</span> },
    { id: 'more', label: 'More', kind: 'block', zone: 'selected', value: (c) => <div>more-{c.session.name}</div> },
  ],
};

const titleRowOf = (name: string) =>
  [...container.querySelectorAll('span')]
    .find((s) => s.className.includes('font-medium') && s.textContent === name)
    ?.closest('[class*="group/row"]');

it('shows no plugin field the layout does not place', async () => {
  await render({ plugins: [fieldPlugin] });
  const text = container.textContent ?? '';
  expect(text).not.toContain('badge-');
  expect(text).not.toContain('line-');
  expect(text).not.toContain('more-');
});

it('places plugin fields in the zones the layout names', async () => {
  localStorage.setItem(
    'axn-term:settings',
    JSON.stringify({
      sessionCard: { title: ['core.name', 'probe.badge'], always: [['probe.line']], selected: [['probe.more']] },
    }),
  );
  await render({ plugins: [fieldPlugin] });
  const text = container.textContent ?? '';
  expect(titleRowOf('tests')?.textContent).toContain('badge-tests');
  expect(text).toContain('line-server');
  expect(text).toContain('line-tests');
  // selected zone: only s-1 ('server') is selected
  expect(text).toContain('more-server');
  expect(text).not.toContain('more-tests');
});

it('follows a configured sessionCard layout', async () => {
  localStorage.setItem(
    'axn-term:settings',
    JSON.stringify({
      sessionCard: { title: ['core.name', 'probe.line'], selected: [['probe.badge']], hidden: ['probe.more'] },
    }),
  );
  await render({ plugins: [fieldPlugin] });
  const text = container.textContent ?? '';
  expect(titleRowOf('tests')?.textContent).toContain('line-tests');
  expect(titleRowOf('tests')?.textContent).not.toContain('badge-tests');
  expect(text).toContain('badge-server');
  expect(text).not.toContain('badge-tests');
  expect(text).not.toContain('more-server');
});

it('still renders legacy renderRow/render hooks of external plugins', async () => {
  const legacy = {
    id: 'legacy',
    title: 'legacy',
    renderRow: () => <span>old-badge</span>,
    render: () => <div>old-panel</div>,
  } as unknown as SessionViewPlugin;
  localStorage.setItem(
    'axn-term:settings',
    JSON.stringify({ sessionCard: { title: ['core.name', 'legacy.row'], selected: [['legacy.panel']] } }),
  );
  await render({ plugins: [legacy] });
  const text = container.textContent ?? '';
  expect(text).toContain('old-badge');
  expect(text).toContain('old-panel');
});

/** Type into the panel filter the way React sees it. */
async function filterBy(text: string) {
  const input = container.querySelector('input[placeholder="Filter sessions…"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const searchPlugin: SessionViewPlugin = {
  id: 'git',
  title: 'git',
  sessionFields: [
    {
      id: 'branch',
      label: 'Branch',
      kind: 'inline',
      zone: 'title',
      value: (c) => <span>{c.session.id === 's-2' ? 'VECTORDB-29' : 'main'}</span>,
      search: (c) => (c.session.id === 's-2' ? 'feature/VECTORDB-29-x' : 'main'),
    },
  ],
};

it('filters sessions on searchable session fields', async () => {
  localStorage.setItem('axn-term:settings', JSON.stringify({ sessionCard: { title: ['core.name', 'git.branch'] } }));
  await render({ plugins: [searchPlugin] });
  await filterBy('vectordb-29');
  const text = container.textContent ?? '';
  expect(text).toContain('tests');
  expect(text).not.toContain('server');
});

it('does not match fields the layout hides', async () => {
  localStorage.setItem('axn-term:settings', JSON.stringify({ sessionCard: { title: ['core.name', 'git.branch'], hidden: ['git.branch'] } }));
  await render({ plugins: [searchPlugin] });
  await filterBy('vectordb-29');
  const text = container.textContent ?? '';
  expect(text).not.toContain('tests');
});
