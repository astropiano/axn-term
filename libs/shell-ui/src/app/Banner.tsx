import { AlertTriangle, ChevronLeft, ChevronRight, Info, Play, Trash2, X } from 'lucide-react';

import type { BannerLevel, SessionBanner, SessionBannerAction, ShellSession } from '../types';
import type { SessionViewPlugin } from './session-plugins/plugin';
import { useSettings } from '../SettingsProvider';

const levelColor: Record<BannerLevel, string> = {
  info: 'var(--accent)',
  warning: 'var(--orange)',
  error: 'var(--red)',
};

const actionIcon = {
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  play: Play,
  trash: Trash2,
} as const;

/**
 * Generic dismissible banner strip. Rendered on top of the session view for
 * session-bound banners (pluginState `banner` key) and at the top of the
 * window for app-level notices — usable anywhere a message needs to surface.
 * Declared `actions` render as small icon buttons next to the message; a
 * banner without `onDismiss` has no ✕ (non-dismissible).
 */
function BannerAction({
  action,
  onAction,
}: {
  action: SessionBannerAction;
  onAction?: (actionId: string) => void;
}) {
  const ActionIcon = action.icon ? actionIcon[action.icon] : undefined;
  return (
    <span className="inline-flex shrink-0" data-tip={action.title ?? action.label ?? action.id}>
      <button
        type="button"
        disabled={action.disabled}
        onClick={() => onAction?.(action.id)}
        className="flex h-6 items-center gap-1 rounded-[var(--radius-md)] bg-[var(--fill-2)] px-2 text-xs text-[var(--text-primary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--hairline-strong)] disabled:pointer-events-none disabled:opacity-40"
      >
        {ActionIcon && <ActionIcon className="h-3 w-3" />}
        {action.label ?? (!ActionIcon ? action.id : null)}
      </button>
    </span>
  );
}

export function Banner({
  level = 'info',
  message,
  detail,
  actions,
  trailingActions,
  onAction,
  onDismiss,
}: {
  level?: BannerLevel;
  message: string;
  detail?: string;
  actions?: SessionBannerAction[];
  trailingActions?: SessionBannerAction[];
  onAction?: (actionId: string) => void;
  onDismiss?: () => void;
}) {
  const { settings } = useSettings();
  const Icon = level === 'info' ? Info : AlertTriangle;
  return (
    <div
      role="status"
      className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs text-[var(--text-primary)] shadow-[inset_0_-1px_0_var(--hairline)]"
      style={{
        zoom: settings.uiZoom ? settings.uiZoom / 100 : undefined,
        // A faint wash in the level colour — enough to read as a notice
        // without competing with the terminal below.
        background: `color-mix(in srgb, ${levelColor[level]} 9%, transparent)`,
      }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: levelColor[level] }} />
      {actions && actions.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {actions.map((a) => (
            <BannerAction key={a.id} action={a} onAction={onAction} />
          ))}
        </span>
      )}
      <span className="min-w-0 shrink truncate" data-tip={message}>
        {message}
      </span>
      {detail ? (
        <span
          className="min-w-0 flex-1 truncate text-[var(--text-secondary)]"
          data-tip={detail}
        >
          {detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {trailingActions && trailingActions.length > 0 && (
        <span className="flex shrink-0 items-center gap-1">
          {trailingActions.map((a) => (
            <BannerAction key={a.id} action={a} onAction={onAction} />
          ))}
        </span>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          data-tip="Dismiss"
          aria-label="Dismiss"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-2)] hover:text-[var(--text-primary)]"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Collect banners raised by enabled plugins on a session. Banners live in
 * the plugin's pluginState under the reserved key `banner`, written via
 * `ctx.setBanner(...)`. The `stateKey`/`plugin` identify the owner for
 * dismissal and action routing.
 */
export function sessionBanners(
  session: ShellSession,
  plugins: readonly SessionViewPlugin[],
): Array<{ plugin: SessionViewPlugin; stateKey: string; banner: SessionBanner }> {
  const out: Array<{ plugin: SessionViewPlugin; stateKey: string; banner: SessionBanner }> = [];
  for (const plugin of plugins) {
    const key = plugin.stateKey ?? plugin.id;
    const state = session.pluginState?.[key] as
      | { banner?: SessionBanner | null }
      | undefined;
    const banner = state?.banner;
    if (banner && typeof banner === 'object' && banner.message) {
      out.push({ plugin, stateKey: key, banner });
    }
  }
  return out;
}
