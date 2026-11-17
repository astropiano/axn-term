import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Trash2 } from 'lucide-react';
import type { PluginSettingsViewContext } from './plugin';
import { TAG_PALETTE, clearTagColor, normalizeTag, setTagColor, tagColor, tagColorOverrides } from './taggingModel';

/**
 * Settings → Plugins → Tags: pick the colour of a tag by name. Unlisted tags
 * keep their derived colour; the list is only the overrides, because tags
 * themselves live on sessions and workspaces.
 */
export function TagColorSettings({ settings, update }: PluginSettingsViewContext) {
  const { t } = useLingui();
  const colors = tagColorOverrides(settings);
  const [name, setName] = useState('');
  const [colour, setColour] = useState(TAG_PALETTE[0]);
  const entries = Object.entries(colors);
  const canAdd = normalizeTag(name) !== null;

  const add = () => {
    if (!canAdd) return;
    update({ colors: setTagColor(colors, name, colour) });
    setName('');
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="text-[12px] font-medium text-[var(--text-primary)]">
        <Trans>Tag colours</Trans>
      </div>
      <p className="text-[11px] text-[var(--text-secondary)]">
        <Trans>Tags without an entry here get a colour derived from their name.</Trans>
      </p>
      {entries.map(([tag, value]) => (
        <div key={tag} className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t`Colour of ${tag}`}
            value={value}
            onChange={(e) => update({ colors: setTagColor(colors, tag, e.currentTarget.value) })}
            className="h-6 w-8 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0"
          />
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{tag}</span>
          <button
            type="button"
            aria-label={t`Reset colour of ${tag}`}
            title={t`Reset to derived colour (${tagColor(tag)})`}
            onClick={() => update({ colors: clearTagColor(colors, tag) })}
            className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={t`New tag colour`}
          value={colour}
          onChange={(e) => setColour(e.currentTarget.value)}
          className="h-6 w-8 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0"
        />
        <input
          value={name}
          placeholder={t`Tag name`}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[12px] text-[var(--text-primary)]"
        />
        <button
          type="button"
          disabled={!canAdd}
          onClick={add}
          className="rounded border border-[var(--border)] px-2 py-1 text-[12px] text-[var(--text-primary)] enabled:hover:bg-[var(--fill-1)] disabled:opacity-40"
        >
          <Trans>Set colour</Trans>
        </button>
      </div>
    </div>
  );
}
