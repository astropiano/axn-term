import { beforeEach, expect, it, vi } from 'vitest';
import type { ShellSession, Workspace } from '../../types';
import type { MenuScope, SessionViewContext, PluginApi, WorkspaceActionContext } from './plugin';
import { taggingPlugin } from './tagging';
import { tagColor } from './taggingModel';
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
