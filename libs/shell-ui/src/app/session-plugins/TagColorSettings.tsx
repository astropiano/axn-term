import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { RotateCcw } from 'lucide-react';
import type { PluginSettingsViewContext } from './plugin';
import { TagColorInput } from './TagColorInput';
import {
  TAGGING,
  clearTagColor,
  derivedTags,
  normalizeTag,
  setTagColor,
  tagColor,
  tagColorOverrides,
} from './taggingModel';

const tagsOf = (state: unknown): string[] => {
  const tags = (state as { tags?: unknown } | null | undefined)?.tags;
  return Array.isArray(tags) ? tags.filter((x): x is string => typeof x === 'string') : [];
};

/**
 * Settings → Plugins → Tags: every tag in use in this window (plus tags that
 * only have a configured colour), each with its colour editable. A tag
 * without a configured colour shows its derived one.
 */
export function TagColorSettings({ settings, update, sessions, workspaces }: PluginSettingsViewContext) {
  const { t } = useLingui();
  const colors = tagColorOverrides(settings);
  const [name, setName] = useState('');
  const tags = derivedTags([
    ...sessions.map((s) => tagsOf(s.pluginState?.[TAGGING.id])),
    ...workspaces.map((w) => tagsOf(w.pluginState?.[TAGGING.id])),
    Object.keys(colors),
  ]);
  const typed = normalizeTag(name);

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="text-[12px] font-medium text-[var(--text-primary)]">
        <Trans>Tag colours</Trans>
      </div>
      <p className="text-[11px] text-[var(--text-secondary)]">
        <Trans>
          Tags in use in this window — create one by choosing Tag… on a session or workspace. A tag without a set
          colour gets one derived from its name.
        </Trans>
      </p>
      {tags.length === 0 && (
        <p className="text-[11px] text-[var(--text-secondary)]">
          <Trans>No tags yet — right-click a session or workspace and choose Tag….</Trans>
        </p>
      )}
      {tags.map((tag) => {
        const custom = colors[tag.trim().toLowerCase()] !== undefined;
        return (
          <div key={tag} className="flex items-center gap-2">
            <TagColorInput
              value={tagColor(tag, colors)}
              label={t`Colour of ${tag}`}
              onChange={(hex) => update({ colors: setTagColor(colors, tag, hex) })}
            />
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{tag}</span>
            {custom && (
              <button
                type="button"
                aria-label={t`Reset colour of ${tag}`}
                title={t`Reset to derived colour (${tagColor(tag)})`}
                onClick={() => update({ colors: clearTagColor(colors, tag) })}
                className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
      <div className="mt-1 flex items-center gap-2">
        <input
          value={name}
          placeholder={t`Tag name`}
          onChange={(e) => setName(e.currentTarget.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)]"
        />
        {typed && (
          <TagColorInput
            value={tagColor(typed, colors)}
            label={t`New tag colour`}
            onChange={(hex) => {
              update({ colors: setTagColor(colors, typed, hex) });
              setName('');
            }}
          />
        )}
      </div>
    </div>
  );
}
