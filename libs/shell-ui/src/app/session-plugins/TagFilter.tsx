import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tag } from 'lucide-react';
import { useSettings } from '../../SettingsProvider';
import { themeTagPalette } from '../../themes';
import type { ShellSession, Workspace } from '../../types';
import type { PluginSearchFilterRenderContext } from './plugin';
import { TAGGING, derivedTags, tagColor, tagColorOverrides } from './taggingModel';
import { contrastText, resolveColour } from './tint';

export const tagsOf = (state: unknown): string[] => {
  const tags = (state as { tags?: unknown } | null | undefined)?.tags;
  return Array.isArray(tags) ? tags.filter((x): x is string => typeof x === 'string') : [];
};

export const sessionTags = (session: ShellSession): string[] =>
  tagsOf(session.pluginState?.[TAGGING.id]);

export const workspaceTags = (workspace: Workspace): string[] =>
  tagsOf(workspace.pluginState?.[TAGGING.id]);

export function TagFilter({
  value,
  onChange,
  sessions,
  workspaces,
  pluginSettings,
}: PluginSearchFilterRenderContext<string | null>) {
  const { t } = useLingui();
  const { activeTheme } = useSettings();
  const colors = tagColorOverrides(pluginSettings);
  const palette = themeTagPalette(activeTheme);

  const tags = useMemo(() => {
    return derivedTags([
      ...sessions.map(sessionTags),
      ...workspaces.map(workspaceTags),
    ]);
  }, [sessions, workspaces]);

  if (tags.length === 0) return null;

  const activeKey = value ? value.trim().toLowerCase() : null;

  return (
    <div
      className="flex flex-wrap items-center gap-1 py-0.5 text-xs"
      role="group"
      aria-label={t`Tag filter`}
    >
      <button
        type="button"
        onClick={() => onChange(null)}
        className={`flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-medium transition-colors duration-[var(--dur-1)] ${
          activeKey === null
            ? 'bg-[var(--fill-2)] text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--hairline)]'
            : 'text-[var(--text-tertiary)] hover:bg-[var(--fill-1)] hover:text-[var(--text-secondary)]'
        }`}
      >
        <Trans>All</Trans>
      </button>
      {tags.map((tag) => {
        const isSelected = activeKey === tag.trim().toLowerCase();
        const colour = tagColor(tag, colors);
        const hex = resolveColour(colour, palette);
        const text = hex ? contrastText(hex) : undefined;

        return (
          <button
            key={tag}
            type="button"
            onClick={() => onChange(isSelected ? null : tag)}
            aria-pressed={isSelected}
            data-tip={t`Filter by tag: ${tag}`}
            className="flex h-5 max-w-full min-w-0 items-center gap-1 rounded-full px-2 text-[10px] font-medium transition-all duration-[var(--dur-1)]"
            style={
              isSelected && hex && text
                ? {
                    backgroundColor: hex,
                    color: text,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${text} 25%, transparent)`,
                  }
                : {
                    backgroundColor: 'var(--fill-1)',
                    color: 'var(--text-secondary)',
                    boxShadow: 'inset 0 0 0 1px var(--hairline)',
                  }
            }
          >
            {hex && !isSelected && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: hex }}
              />
            )}
            {isSelected && <Tag className="h-2.5 w-2.5 shrink-0" />}
            <span className="truncate">{tag}</span>
          </button>
        );
      })}
    </div>
  );
}
