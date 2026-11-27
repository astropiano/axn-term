import { useEffect, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Copy, ExternalLink, LoaderCircle } from 'lucide-react';
import { actionButtonClass } from '../PathActionMenu';
import { useShellServices } from '../services';
import type { TargetAction, TextTarget } from './textTargets';

/**
 * The hover card of a text target (`app/textTargets.ts`) — the terminal's
 * link card and the chip popover render the same thing. Order is fixed:
 * "Open link" first whenever there is a URL, then the plugins' actions, then
 * a copy button. `url` overrides the target's own (the hovered link itself).
 */
export function TargetCard({
  target,
  actions,
  url,
  onDismiss,
}: {
  target: TextTarget;
  actions: TargetAction[];
  url?: string;
  onDismiss?: () => void;
}) {
  const { t } = useLingui();
  const { services } = useShellServices();
  const [summary, setSummary] = useState(target.summary);
  const [running, setRunning] = useState<string | null>(null);
  const link = url ?? target.url;

  useEffect(() => {
    setSummary(target.summary);
    if (target.summary || !target.resolveSummary) return;
    let live = true;
    void target
      .resolveSummary()
      .then((s) => {
        if (live && s) setSummary(s);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [target]);

  const run = (action: TargetAction) => {
    if (running) return;
    setRunning(action.id);
    void Promise.resolve()
      .then(() => action.run())
      .catch(() => {})
      .finally(() => {
        setRunning(null);
        onDismiss?.();
      });
  };

  return (
    <div className="px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {link && (
          <button
            type="button"
            onClick={() => {
              onDismiss?.();
              services.openExternal(link);
            }}
            className={actionButtonClass}
          >
            <ExternalLink className="h-3 w-3" />
            <Trans>Open link</Trans>
          </button>
        )}
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={running !== null}
            onClick={() => run(action)}
            data-tip={action.tip}
            className={`${actionButtonClass} disabled:opacity-60`}
          >
            {running === action.id ? <LoaderCircle className="h-3 w-3 animate-spin" /> : action.icon}
            {action.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            void services.copyText(link && url ? link : target.key);
          }}
          data-tip={link && url ? t`Copy URL` : t`Copy key`}
          className={actionButtonClass}
        >
          <Copy className="h-3 w-3" />
          {link && url ? t`Copy URL` : t`Copy key`}
        </button>
      </div>
      <div className="mt-1.5 text-[11px] leading-tight text-[var(--text-secondary)] select-text">
        <span className="font-mono text-[var(--text-primary)]">{target.key}</span>
        {summary && <span> · {summary}</span>}
      </div>
      {url && (
        <div className="mt-1 break-all font-mono text-[11px] leading-tight text-[var(--text-secondary)] select-text">
          {url}
        </div>
      )}
    </div>
  );
}
