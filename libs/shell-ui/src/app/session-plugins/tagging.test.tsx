import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { ShellSession, Workspace } from '../../types';
import type { MenuScope, SessionViewContext, PluginApi, WorkspaceActionContext } from './plugin';
import { taggingPlugin } from './tagging';
import { tagColor } from './taggingModel';
import { resolveCardLayout, type FieldMeta } from '../sessionCardLayout';
import { StoryShellProviders } from '../storyMocks';
import * as host from '../tagHost';

vi.mock('../tagHost', () => ({ openTagModal: vi.fn() }));
const open = vi.mocked(host.openTagModal);
beforeEach(() => open.mockClear());

type Ctx = SessionViewContext & PluginApi;
const session = (id: string, tags?: unknown): ShellSession =>
  ({ id, workspaceId: 'w', name: id, pluginState: tags === undefined ? undefined : { tagging: { tags } } }) as ShellSession;
const target = (s: ShellSession) =>
  ({ session: s, pluginState: s.pluginState?.tagging, updatePluginState: vi.fn() }) as unknown as Ctx;
const ws = (id: string, tags?: unknown): Workspace =>
  ({ id, name: id, pluginState: tags === undefined ? undefined : { tagging: { tags } } }) as Workspace;

it('colours a session from its tags and ignores garbage state', () => {
  expect(taggingPlugin.sessionColors!(target(session('a', ['x', 'y'])))).toEqual([tagColor('x'), tagColor('y')]);
  expect(taggingPlugin.sessionColors!(target(session('a', 'nope')))).toEqual([]);
  expect(taggingPlugin.sessionColors!(target(session('a', [1, null, 'ok'])))).toEqual([tagColor('ok')]);
  expect(taggingPlugin.sessionColors!(target(session('a')))).toEqual([]);
});

it('colours a workspace from its own state', () => {
  expect(taggingPlugin.workspaceColors!({ workspace: ws('w', ['x']), pluginSettings: undefined })).toEqual([tagColor('x')]);
  expect(taggingPlugin.workspaceColors!({ workspace: ws('w'), pluginSettings: undefined })).toEqual([]);
});

it('shows nothing without tags and exposes tags to the panel search', () => {
  const [field] = taggingPlugin.sessionFields!;
  expect(field.value(target(session('a')))).toBeNull();
  expect(field.search!(target(session('a')))).toBeNull();
  expect(field.value(target(session('a', ['x'])))).not.toBeNull();
  expect(field.search!(target(session('a', ['x', 'y'])))).toEqual(['x', 'y']);
});

it('draws each tag chip filled in its own colour with contrast text', () => {
  const [field] = taggingPlugin.sessionFields!;
  const html = renderToStaticMarkup(
    <StoryShellProviders>{field.value({ ...target(session('a', ['x', 'y'])), pluginSettings: { colors: { x: '#ffb224', y: '#6e56cf' } } }) as ReactElement}</StoryShellProviders>,
  );
  expect(html).toContain('background-color:#ffb224');
  expect(html).toContain('color:#111111');
  expect(html).toContain('background-color:#6e56cf');
  expect(html).toContain('color:#ffffff');
});

it('opens the modal for every multi-selected session and writes each one', () => {
  const [a, b, c] = [session('a', ['x']), session('b', []), session('c', ['z'])];
  const targets = [target(a), target(b)];
  const scope: MenuScope = { targets, sessions: [a, b, c], workspaces: [ws('w', ['wtag'])] };
  const [row] = taggingPlugin.sessionMenuItems!(targets[0], scope);
  row.onClick();
  const request = open.mock.calls[0][0];
  expect(request.targets).toEqual([['x'], []]);
  expect(request.others).toEqual([['z'], ['wtag']]);
  request.onApply([['x', 'n'], ['n']]);
  expect(targets[0].updatePluginState).toHaveBeenCalledWith({ tags: ['x', 'n'] });
  expect(targets[1].updatePluginState).toHaveBeenCalledWith({ tags: ['n'] });
});

it('tags a workspace with no sessions', () => {
  const updateWorkspaceState = vi.fn();
  const ctx: WorkspaceActionContext = {
    workspace: ws('empty', ['e']),
    pluginSettings: undefined,
    sessions: [],
    workspaces: [ws('empty', ['e']), ws('other', ['o'])],
    updateWorkspaceState,
  };
  const [row] = taggingPlugin.workspaceActions!(ctx);
  row.onClick();
  const request = open.mock.calls[0][0];
  expect(request.targets).toEqual([['e']]);
  expect(request.others).toEqual([['o']]);
  request.onApply([['e', 'n']]);
  expect(updateWorkspaceState).toHaveBeenCalledWith({ tags: ['e', 'n'] });
});

it('uses a configured colour over the derived one for sessions and workspaces', () => {
  const pluginSettings = { colors: { x: '#123456' } };
  expect(taggingPlugin.sessionColors!({ ...target(session('a', ['x', 'y'])), pluginSettings })).toEqual([
    '#123456',
    tagColor('y'),
  ]);
  expect(taggingPlugin.workspaceColors!({ workspace: ws('w', ['X']), pluginSettings })).toEqual(['#123456']);
});

it('shows the tag name only where the sessionCard layout places it', () => {
  const meta: FieldMeta[] = taggingPlugin.sessionFields!.map((f) => ({
    id: `tagging.${f.id}`,
    label: f.label,
    kind: f.kind,
    zone: f.zone,
  }));
  const all = (l: ReturnType<typeof resolveCardLayout>) => [...l.title, ...l.always.flat(), ...l.selected.flat()];
  expect(all(resolveCardLayout(undefined, meta))).not.toContain('tagging.tags');
  expect(resolveCardLayout({ title: ['core.name', 'tagging.tags'] }, meta).title).toContain('tagging.tags');
  expect(resolveCardLayout({ always: [['tagging.tags']] }, meta).always).toEqual([['tagging.tags']]);
  expect(all(resolveCardLayout({ hidden: ['tagging.tags'], title: ['tagging.tags'] }, meta))).not.toContain('tagging.tags');
});

it('declares tagFilter setting and searchFilter capability', () => {
  expect(taggingPlugin.settings).toEqual([
    expect.objectContaining({
      key: 'tagFilter',
      type: 'boolean',
      default: false,
    }),
  ]);
  expect(taggingPlugin.searchFilter).toBeDefined();
  expect(taggingPlugin.searchFilter?.id).toBe('tagFilter');
});

it('enables searchFilter only when tagFilter setting is true', () => {
  const sf = taggingPlugin.searchFilter!;
  expect(sf.enabled?.({})).toBe(false);
  expect(sf.enabled?.(undefined)).toBe(false);
  expect(sf.enabled?.({ tagFilter: false })).toBe(false);
  expect(sf.enabled?.({ tagFilter: true })).toBe(true);
});

it('filters workspaces and sessions by tag with workspace inheritance', () => {
  const sf = taggingPlugin.searchFilter!;
  const w1 = ws('w1', ['frontend']);
  const w2 = ws('w2', ['backend']);
  const s1 = session('s1', ['frontend']);
  const s2 = session('s2', []); // untagged session
  const s3 = session('s3', ['frontend']);
  const s4 = session('s4', ['backend']);

  expect(sf.isActive(null)).toBe(false);
  expect(sf.isActive('')).toBe(false);
  expect(sf.isActive('   ')).toBe(false);
  expect(sf.isActive('frontend')).toBe(true);

  // Workspace matches when it has the tag (case-insensitive)
  expect(sf.matchesWorkspace?.(w1, 'frontend', { pluginSettings: {} })).toBe(true);
  expect(sf.matchesWorkspace?.(w2, 'frontend', { pluginSettings: {} })).toBe(false);
  expect(sf.matchesWorkspace?.(w1, 'FRONTEND', { pluginSettings: {} })).toBe(true);

  // Sessions are shown if they have the tag OR their workspace has the tag
  expect(sf.matchesSession?.(s1, w1, 'frontend', { pluginSettings: {} })).toBe(true);
  expect(sf.matchesSession?.(s2, w1, 'frontend', { pluginSettings: {} })).toBe(true); // in w1 which has tag
  expect(sf.matchesSession?.(s2, w2, 'frontend', { pluginSettings: {} })).toBe(false); // in w2 which does not
  expect(sf.matchesSession?.(s3, w2, 'frontend', { pluginSettings: {} })).toBe(true); // s3 has tag even though w2 doesn't
  expect(sf.matchesSession?.(s4, w2, 'frontend', { pluginSettings: {} })).toBe(false);
});
