import { i18n } from '../../i18n';
import { t } from '@lingui/core/macro';
import { Tag } from 'lucide-react';
import type { ShellSession, Workspace } from '../../types';
import { openTagModal } from '../tagHost';
import type { SessionViewPlugin } from './plugin';
import { TAGGING, tagColor, tagColorOverrides } from './taggingModel';
import { cssColour } from './tint';
import { TagColorSettings } from './TagColorSettings';

const tagsOf = (state: unknown): string[] => {
  const tags = (state as { tags?: unknown } | null | undefined)?.tags;
  return Array.isArray(tags) ? tags.filter((x): x is string => typeof x === 'string') : [];
};

const sessionTags = (session: ShellSession): string[] => tagsOf(session.pluginState?.[TAGGING.id]);
const workspaceTags = (workspace: Workspace): string[] => tagsOf(workspace.pluginState?.[TAGGING.id]);

/**
 * Colours sessions and workspaces from typed string tags. A tag's colour is
 * derived from its text; tags live only on the session or workspace that
 * carries them.
 */
export const taggingPlugin: SessionViewPlugin = {
  id: TAGGING.id,
  title: 'Tags',
  logo: 'tag',
  sessionColors: (ctx) => {
    const colors = tagColorOverrides(ctx.pluginSettings);
    return tagsOf(ctx.pluginState).map((tag) => tagColor(tag, colors));
  },
  workspaceColors: ({ workspace, pluginSettings }) => {
    const colors = tagColorOverrides(pluginSettings);
    return workspaceTags(workspace).map((tag) => tagColor(tag, colors));
  },
  sessionFields: [
    {
      id: 'tags',
      label: 'Tags',
      kind: 'inline',
      zone: 'title',
      value: (ctx) => {
        const tags = tagsOf(ctx.pluginState);
        if (tags.length === 0) return null;
        const colors = tagColorOverrides(ctx.pluginSettings);
        return (
          <span className="flex min-w-0 shrink items-center gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 truncate rounded-full px-1.5 text-[10px] leading-[16px]"
                style={{
                  color: `color-mix(in srgb, ${cssColour(tagColor(tag, colors))} 80%, var(--text-primary))`,
                  backgroundColor: `color-mix(in srgb, ${cssColour(tagColor(tag, colors))} 18%, transparent)`,
                }}
              >
                <Tag className="h-2.5 w-2.5 shrink-0" />
                {tag}
              </span>
            ))}
          </span>
        );
      },
      search: (ctx) => {
        const tags = tagsOf(ctx.pluginState);
        return tags.length > 0 ? tags : null;
      },
    },
  ],
  renderSettings: (ctx) => <TagColorSettings {...ctx} />,
  sessionMenuItems: (_ctx, scope) => [
    {
      label: i18n._(t`Tag…`),
      onClick: () => {
        const ids = new Set(scope.targets.map((target) => target.session.id));
        openTagModal({
          title: i18n._(
            scope.targets.length > 1 ? t`Tag ${scope.targets.length} sessions` : t`Tag session`,
          ),
          targets: scope.targets.map((target) => tagsOf(target.pluginState)),
          others: [
            ...scope.sessions.filter((s) => !ids.has(s.id)).map(sessionTags),
            ...scope.workspaces.map(workspaceTags),
          ],
          onApply: (next) =>
            scope.targets.forEach((target, i) => target.updatePluginState({ tags: next[i] })),
        });
      },
    },
  ],
  workspaceActions: ({ workspace, sessions, workspaces, updateWorkspaceState }) => [
    {
      label: i18n._(t`Tag…`),
      onClick: () =>
        openTagModal({
          title: i18n._(t`Tag workspace`),
          targets: [workspaceTags(workspace)],
          others: [
            ...sessions.map(sessionTags),
            ...workspaces.filter((w) => w.id !== workspace.id).map(workspaceTags),
          ],
          onApply: ([tags]) => updateWorkspaceState({ tags }),
        }),
    },
  ],
};
