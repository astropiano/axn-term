import type { ComponentType } from 'react';
import type { ShellSession, Workspace } from '../../types';
import type { PluginApi, SessionViewContext } from './plugin';

/**
 * Cross-plugin contribution point for merge-request actions.
 *
 * `glab-mr` renders registered providers on each MR row — both in the full
 * merge-requests view and in the per-session MR list — without knowing who
 * registered them. Providers are React components (so they may use hooks,
 * e.g. `usePluginSettings`) receiving the MR and a view env. The env hands
 * out session-bound APIs on demand — a provider can `exec`/`openSession`
 * through any session, typically the one whose repo hosts the MR.
 *
 * Registration is module-level: a plugin calls `registerMrActions` at import
 * time. Duplicate ids replace earlier registrations (keeps hot reload and
 * re-entrant tests deterministic).
 */
export interface MrRef {
  iid: number;
  /** e.g. `!75` */
  reference: string;
  title: string;
  url: string;
  /** GitLab fullPath e.g. `group/proj` — absent on session-level summaries. */
  project?: string;
  sourceBranch?: string;
  targetBranch?: string;
}

/** View-side capabilities handed to MR action providers. */
export interface MrRowEnv {
  sessions: ShellSession[];
  /**
   * The window's workspaces in panel order — lets a provider target the
   * workspace already hosting the MR's repo, or offer a workspace picker.
   * Empty where the host cannot enumerate workspaces.
   */
  workspaces?: Workspace[];
  /** Session-bound api for a known session id, when the view can provide it. */
  apiFor: (sessionId: string) => (SessionViewContext & PluginApi) | undefined;
  selectSession: (sessionId: string) => void;
}

export interface MrActionProps {
  mr: MrRef;
  env: MrRowEnv;
}

export type MrActionsProvider = ComponentType<MrActionProps>;

const providers = new Map<string, MrActionsProvider>();

export function registerMrActions(id: string, provider: MrActionsProvider): void {
  providers.set(id, provider);
}

export function mrActionProviders(): MrActionsProvider[] {
  return [...providers.values()];
}
