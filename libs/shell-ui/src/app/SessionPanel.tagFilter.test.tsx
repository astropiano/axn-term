// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { SessionPanel } from './SessionPanel';
import { StoryShellProviders } from './storyMocks';
import { ShellServicesProvider } from '../services';
import type { ShellSession, Workspace } from '../types';
import { taggingPlugin } from './session-plugins/tagging';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  localStorage.removeItem('axn-term:settings');
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

const ws = (id: string, name: string, tags?: string[]): Workspace => ({
  id,
  name,
  collapsed: false,
  pluginState: tags ? { tagging: { tags } } : undefined,
});

const sess = (id: string, workspaceId: string, name: string, tags?: string[]): ShellSession => ({
  id,
  workspaceId,
  name,
  topic: '',
  summary: '',
  tasks: [],
  progress: 0,
  output: '',
  pluginState: tags ? { tagging: { tags } } : undefined,
});

async function renderPanel({
  workspaces,
  sessions,
  pluginsYaml,
  props = {},
}: {
  workspaces: Workspace[];
  sessions: ShellSession[];
  pluginsYaml?: string;
  props?: Partial<ComponentProps<typeof SessionPanel>>;
}) {
  const noop = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <StoryShellProviders pluginsYaml={pluginsYaml}>
        <ShellServicesProvider services={{ copyText: noop, openExternal: noop }} fileReader={() => undefined}>
          <SessionPanel
            workspaces={workspaces}
            sessions={sessions}
            selectedSessionId={sessions[0]?.id ?? ''}
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
            plugins={[taggingPlugin]}
            onOpenBrowser={noop}
            onOpenTab={noop}
            onOpenSubShell={() => undefined}
            onTurnIntoWorkspace={noop}
            onOpenIde={noop}
            pluginData={{}}
            mergePluginData={noop}
            {...props}
          />
        </ShellServicesProvider>
      </StoryShellProviders>,
    ),
  );
  return container;
}

const displayedSessionNames = () =>
  [...container.querySelectorAll('[class*="group/row"]')]
    .map((el) => {
      const nameSpan = [...el.querySelectorAll('span')].find((s) => s.className.includes('font-medium'));
      return nameSpan?.textContent?.trim() ?? '';
    })
    .filter(Boolean);

it('does not show tag filter UI when tagFilter is disabled (default)', async () => {
  await renderPanel({
    workspaces: [ws('w1', 'frontend-ws', ['ui'])],
    sessions: [sess('s1', 'w1', 'app', ['ui'])],
  });
  const filterGroup = container.querySelector('[aria-label="Tag filter"]');
  expect(filterGroup).toBeNull();
});

it('shows tag filter UI when tagFilter is enabled in plugin settings', async () => {
  await renderPanel({
    workspaces: [ws('w1', 'frontend-ws', ['ui'])],
    sessions: [sess('s1', 'w1', 'app', ['ui'])],
    pluginsYaml: 'tagging:\n  tagFilter: true\n',
  });
  const filterGroup = container.querySelector('[aria-label="Tag filter"]');
  expect(filterGroup).not.toBeNull();
  expect(filterGroup?.textContent).toContain('All');
  expect(filterGroup?.textContent).toContain('ui');
});

it('selecting a tag shows workspaces with all their sessions if workspace has the tag', async () => {
  const workspaces = [
    ws('w1', 'frontend-ws', ['ui']),
    ws('w2', 'backend-ws', ['api']),
  ];
  const sessions = [
    sess('s1', 'w1', 'app-client', ['ui']),
    sess('s2', 'w1', 'app-docs', []), // untagged, but in w1 which has 'ui'
    sess('s3', 'w2', 'api-server', ['api']),
    sess('s4', 'w2', 'api-worker', []),
  ];

  await renderPanel({
    workspaces,
    sessions,
    pluginsYaml: 'tagging:\n  tagFilter: true\n',
  });

  // Initially all are shown
  expect(displayedSessionNames()).toEqual(['app-client', 'app-docs', 'api-server', 'api-worker']);

  // Click 'ui' tag chip
  const uiChip = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'ui');
  expect(uiChip).toBeDefined();
  await act(async () => uiChip?.click());

  // w1 has 'ui' tag, so both s1 and s2 (untagged) in w1 are shown!
  // w2 does not have 'ui' and has no 'ui' sessions, so w2 is hidden!
  expect(displayedSessionNames()).toEqual(['app-client', 'app-docs']);
  expect(container.querySelector('[data-workspace-block="w1"]')).not.toBeNull();
  expect(container.querySelector('[data-workspace-block="w2"]')).toBeNull();
});

it('selecting a tag shows only matching sessions in a workspace that does not have the tag', async () => {
  const workspaces = [
    ws('w1', 'mixed-ws', []), // mixed-ws does NOT have 'urgent' tag
  ];
  const sessions = [
    sess('s1', 'w1', 'urgent-task', ['urgent']),
    sess('s2', 'w1', 'regular-task', ['normal']),
    sess('s3', 'w1', 'other-task', []),
  ];

  await renderPanel({
    workspaces,
    sessions,
    pluginsYaml: 'tagging:\n  tagFilter: true\n',
  });

  const urgentChip = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'urgent');
  expect(urgentChip).toBeDefined();
  await act(async () => urgentChip?.click());

  // Workspace mixed-ws is visible, but ONLY urgent-task is shown
  expect(displayedSessionNames()).toEqual(['urgent-task']);
  expect(container.querySelector('[data-workspace-block="w1"]')).not.toBeNull();
});

it('shows empty workspaces when the workspace has the selected tag', async () => {
  const workspaces = [
    ws('w1', 'empty-tagged', ['ops']),
    ws('w2', 'empty-other', ['dev']),
  ];
  const sessions: ShellSession[] = [];

  await renderPanel({
    workspaces,
    sessions,
    pluginsYaml: 'tagging:\n  tagFilter: true\n',
  });

  const opsChip = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'ops');
  expect(opsChip).toBeDefined();
  await act(async () => opsChip?.click());

  expect(container.querySelector('[data-workspace-block="w1"]')).not.toBeNull();
  expect(container.querySelector('[data-workspace-block="w2"]')).toBeNull();
});

it('combines tag filter with search query', async () => {
  const workspaces = [
    ws('w1', 'team-ws', ['shared']),
  ];
  const sessions = [
    sess('s1', 'w1', 'alpha-service', ['shared']),
    sess('s2', 'w1', 'beta-service', ['shared']),
  ];

  await renderPanel({
    workspaces,
    sessions,
    pluginsYaml: 'tagging:\n  tagFilter: true\n',
  });

  // Select 'shared'
  const sharedChip = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'shared');
  await act(async () => sharedChip?.click());

  expect(displayedSessionNames()).toEqual(['alpha-service', 'beta-service']);

  // Enter search text "alpha" in the search input
  const input = container.querySelector('input[placeholder="Filter sessions…"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, 'alpha');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // After typing "alpha", only alpha-service is shown
  expect(displayedSessionNames()).toEqual(['alpha-service']);
});
