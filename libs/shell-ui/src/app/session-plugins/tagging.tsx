import { i18n } from '../../i18n';
import { t } from '@lingui/core/macro';
import { Tag } from 'lucide-react';
import type { ShellSession, Workspace } from '../../types';
import { openTagModal } from '../tagHost';
import type { SessionViewPlugin } from './plugin';
import { TAGGING, tagColor, tagColorOverrides } from './taggingModel';
import { useSettings } from '../../SettingsProvider';
import { themeTagPalette } from '../../themes';
import { contrastText, resolveColour } from './tint';
import { TagColorSettings } from './TagColorSettings';

const tagsOf = (state: unknown): string[] => {
  const tags = (state as { tags?: unknown } | null | undefined)?.tags;
  return Array.isArray(tags) ? tags.filter((x): x is string => typeof x === 'string') : [];
};

const sessionTags = (session: ShellSession): string[] => tagsOf(session.pluginState?.[TAGGING.id]);
const workspaceTags = (workspace: Workspace): string[] => tagsOf(workspace.pluginState?.[TAGGING.id]);

function TagChip({ tag, colour }: { tag: string; colour: string }) {
  const { activeTheme } = useSettings();
  const hex = resolveColour(colour, themeTagPalette(activeTheme));
  if (!hex) return null;
  const text = contrastText(hex);
  return (
    <span
      className="inline-flex items-center gap-0.5 truncate rounded-full px-1.5 text-[10px] font-medium leading-[16px]"
      style={{
        color: text,
        backgroundColor: hex,
        // Keeps the chip's edge visible on a card tinted in the same colour.
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${text} 25%, transparent)`,
      }}
    >
      <Tag className="h-2.5 w-2.5 shrink-0" />
      {tag}
    </span>
  );
}

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
              <TagChip key={tag} tag={tag} colour={tagColor(tag, colors)} />
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
