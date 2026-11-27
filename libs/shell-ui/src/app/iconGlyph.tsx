import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Bot, SquareTerminal } from 'lucide-react';
import dynamicIconImports from 'lucide-react/dynamicIconImports';
import { useIconBag, pluginIconOverride, type IconBag } from './iconModel';
import { sanitizeSvgIcon, svgIconContainStyle } from './sanitizeSvg';

/**
 * Session/plugin icon rendering — its own module so a plugin's own UI (the
 * agents' Resume button) can show its logo without importing SessionPanel,
 * which imports the plugins.
 */

function isSvgString(value: string): boolean {
  return value.trim().toLowerCase().startsWith('<svg');
}

function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Render a sessionIcons value: a Lucide icon name or an inline SVG tag. */
export function SessionIconGlyph({
  value,
  className = 'h-4 w-4 shrink-0',
}: {
  value: string;
  className?: string;
}) {
  const [DynamicIcon, setDynamicIcon] = useState<ComponentType<{ className?: string }> | null>(null);

  useEffect(() => {
    if (isSvgString(value)) {
      setDynamicIcon(null);
      return;
    }

    const lower = value.toLowerCase();
    if (lower === 'bot') {
      setDynamicIcon(() => Bot);
      return;
    }
    if (lower === 'square-terminal' || lower === 'terminal-squared' || lower === 'squareterminal') {
      setDynamicIcon(() => SquareTerminal);
      return;
    }

    const key = toKebabCase(value);
    const loader = (dynamicIconImports as unknown as Record<string, () => Promise<{ default: ComponentType<{ className?: string }> }>>)[key];
    if (!loader) {
      setDynamicIcon(() => SquareTerminal);
      return;
    }

    let cancelled = false;
    loader()
      .then((mod) => {
        if (!cancelled) setDynamicIcon(() => mod.default);
      })
      .catch(() => {
        if (!cancelled) setDynamicIcon(() => SquareTerminal);
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  const svg = useMemo(() => (isSvgString(value) ? sanitizeSvgIcon(value) : null), [value]);

  if (svg !== null) {
    return <span className={className} style={svgIconContainStyle} dangerouslySetInnerHTML={{ __html: svg }} />;
  }

  const IconComponent = DynamicIcon ?? SquareTerminal;
  return <IconComponent className={className} />;
}

export function resolvePluginIcon(
  plugin: { id: string; iconKey?: string; logo?: string },
  bag: IconBag,
): string {
  // Declaring `logo` is the has-an-icon capability: without it a plugin
  // shows the generic Puzzle and the bag is not consulted.
  if (plugin.logo === undefined) return 'Puzzle';
  return pluginIconOverride(bag, plugin) ?? plugin.logo;
}

/** A plugin's logo: `pluginIcons` override, else the declared `logo`, else a generic Puzzle. */
export function PluginIcon({
  plugin,
  className = 'h-4 w-4 shrink-0',
}: {
  plugin: { id: string; iconKey?: string; logo?: string };
  className?: string;
}) {
  const bag = useIconBag();
  return (
    <SessionIconGlyph
      value={resolvePluginIcon(plugin, bag)}
      className={className}
    />
  );
}
