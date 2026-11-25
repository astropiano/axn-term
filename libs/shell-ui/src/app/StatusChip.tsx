import type { MouseEventHandler, ReactNode } from 'react';
import { chipStyle } from './session-plugins/cardEnrichers';
import { shellServices } from '../services';

/**
 * The compact coloured chip of a session card's title row — tinted fill,
 * full-strength border, text mixed toward the theme's text colour
 * (`chipStyle`, the same look as the card-enricher chips). Plugins use it for
 * any state badge (branch, merge request, …): `color` is a named theme colour
 * (`red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `violet`, `magenta`,
 * `gray`, `accent`) or a hex value. With `href` it is an external link.
 *
 * Fixed 16px height with the content centred on both axes, so a chip lines up
 * with the row's text whatever glyphs it holds.
 */
export function StatusChip({
  color,
  icon,
  href,
  tip,
  onContextMenu,
  children,
}: {
  color: string;
  icon?: ReactNode;
  href?: string;
  tip?: string;
  onContextMenu?: MouseEventHandler;
  children?: ReactNode;
}) {
  const cls =
    'inline-flex h-4 shrink-0 select-none items-center justify-center gap-0.5 self-center rounded border px-1 font-mono text-[9px] font-medium leading-none';
  const style = chipStyle({ color });
  const swallowRightButton: MouseEventHandler = (e) => {
    // A held right-button would otherwise start the row's long-press menu.
    if (e.button === 2) e.stopPropagation();
  };
  const content = (
    <>
      {icon}
      {/* The mono font's glyphs sit ~1px above the box centre while the SVG icon is
          centred exactly, so the text is centred on its own. */}
      {children != null && (
        <span className="inline-flex items-center gap-0.5 translate-y-px">{children}</span>
      )}
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const open = shellServices()?.openExternal;
          if (open) open(href);
          else window.open(href, '_blank', 'noopener');
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onContextMenu={onContextMenu}
        data-tip={tip}
        style={style}
        className={`${cls} hover:opacity-80`}
      >
        {content}
      </a>
    );
  }
  return (
    <span
      onContextMenu={onContextMenu}
      onMouseDown={swallowRightButton}
      data-tip={tip}
      style={style}
      className={cls}
    >
      {content}
    </span>
  );
}
