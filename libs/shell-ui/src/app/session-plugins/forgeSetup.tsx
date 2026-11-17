import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Copy, Globe, Sparkles, SquareTerminal } from 'lucide-react';
import { EmptyState, SetupStep, SetupSteps } from '../EmptyState';
import {
  fieldClass,
  primaryButtonClass,
  quietButtonClass,
  secondaryButtonClass,
} from '../chromeStyles';
import { shellServices } from '../../services';
import type { ShellSession } from '../../types';
import { authCommand, forgeOfRemote, parseRemote, type Forge, type ForgeCli } from './forge';

/**
 * A host worth suggesting for the forge plugin's `hostname` setting: the
 * remote of the selected session (else of any session) when it is not the
 * forge's public default and does not obviously belong to the other forge.
 * GitLab is commonly self-hosted under any name, so every unknown host
 * qualifies there; for GitHub only hosts that name it do (GHES).
 */
export function suggestForgeHost(
  forge: Forge,
  sessions: readonly Pick<ShellSession, 'id' | 'repo'>[],
  selectedSessionId?: string,
): string | undefined {
  const defaultHost = forge === 'gitlab' ? 'gitlab.com' : 'github.com';
  const ordered = [
    ...sessions.filter((s) => s.id === selectedSessionId),
    ...sessions.filter((s) => s.id !== selectedSessionId),
  ];
  for (const session of ordered) {
    const host = parseRemote(session.repo?.remote)?.host;
    if (!host || host === defaultHost) continue;
    const owner = forgeOfRemote(session.repo?.remote, {});
    if (forge === 'gitlab' ? owner !== 'github' : owner === 'github') return host;
  }
  return undefined;
}

/** `https://gitlab.example.com/group/` → `gitlab.example.com`. */
export function normalizeHostInput(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

/**
 * Onboarding for a forge view (merge requests, pull requests) whose CLI is
 * missing or not signed in — three steps instead of an error card: the CLI,
 * the host to ask, the sign-in.
 *
 * The host step exists because the usual cause of "not signed in" on a
 * self-hosted instance is that the CLI asked its public default host. It
 * shows the host that was asked, offers the one found in an open session's
 * remote, and writes the plugin's `hostname` setting through `onUseHost`.
 */
export function ForgeSetup({
  cli,
  forgeName,
  defaultHost,
  installUrl,
  failure,
  host,
  suggestedHost,
  icon,
  onUseHost,
  onRunLogin,
  onRetry,
}: {
  cli: ForgeCli;
  /** Display name: "GitLab", "GitHub". */
  forgeName: string;
  /** The host the CLI asks without a `hostname` setting. */
  defaultHost: string;
  installUrl: string;
  failure: 'missing' | 'signed-out';
  /** The configured host that was asked; `undefined` = the CLI default. */
  host?: string;
  suggestedHost?: string;
  icon: ReactNode;
  /** Store the host in the plugin settings ('' = back to the default). Absent hides the field. */
  onUseHost?: (host: string) => void;
  /** Run the login command in a shell; absent hides the button. */
  onRunLogin?: (command: string) => void;
  onRetry: () => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(host ?? suggestedHost ?? '');
  const [copied, setCopied] = useState(false);
  // Follow the setting when it changes underneath (Settings, plugins.yaml).
  useEffect(() => setDraft(host ?? suggestedHost ?? ''), [host, suggestedHost]);

  const missing = failure === 'missing';
  // A self-hosted remote is open, but the default host is being asked.
  const hostUndecided = !missing && !host && !!suggestedHost && !!onUseHost;
  const hostState = missing ? 'todo' : hostUndecided ? 'current' : 'done';
  const loginState = missing || hostUndecided ? 'todo' : 'current';
  const asked = host ?? defaultHost;
  const draftHost = normalizeHostInput(draft);
  const loginCommand = authCommand(cli, 'login', host);

  const copy = () => {
    void shellServices()?.copyText(loginCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <EmptyState
      icon={icon}
      title={t`Connect ${forgeName}`}
      description={
        <Trans>
          This view lists the requests that wait for you on {forgeName}. It reads them with the{' '}
          <code>{cli}</code> command line tool.
        </Trans>
      }
    >
      <SetupSteps>
        <SetupStep
          index={1}
          state={missing ? 'current' : 'done'}
          title={missing ? t`Install ${cli}` : t`${cli} is installed`}
        >
          {missing && (
            <>
              <Trans>
                The command line tool was not found on this machine. Install it from{' '}
                <span className="select-text font-mono text-[11px] text-[var(--text-primary)]">{installUrl}</span>, then
                check again.
              </Trans>
              <div className="mt-2.5">
                <button type="button" onClick={onRetry} className={secondaryButtonClass}>
                  <Trans>Check again</Trans>
                </button>
              </div>
            </>
          )}
        </SetupStep>

        <SetupStep index={2} state={hostState} title={t`Choose your ${forgeName} host`}>
          {host ? (
            <Trans>
              Asking <b className="font-mono font-medium">{asked}</b>.
            </Trans>
          ) : (
            <Trans>
              Asking <b className="font-mono font-medium">{asked}</b>, the default. Enter another host if yours is
              self-hosted.
            </Trans>
          )}
          {onUseHost && !missing && (
            <>
              <form
                className="mt-2.5 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  onUseHost(draftHost);
                }}
              >
                <span className="relative flex min-w-0 flex-1 items-center">
                  <Globe className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={defaultHost}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label={t`Choose your ${forgeName} host`}
                    className={`${fieldClass} w-full select-text pl-7 font-mono`}
                  />
                </span>
                <button
                  type="submit"
                  disabled={draftHost === (host ?? '')}
                  className={hostUndecided ? primaryButtonClass : secondaryButtonClass}
                >
                  <Trans>Use this host</Trans>
                </button>
              </form>
              {suggestedHost && draftHost === suggestedHost && draftHost !== host && (
                <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                  <Sparkles className="h-3 w-3 shrink-0 text-[var(--accent)]" />
                  <Trans>Found in the remote of an open session</Trans>
                </div>
              )}
            </>
          )}
        </SetupStep>

        <SetupStep index={3} state={loginState} title={t`Sign in`}>
          <Trans>Run the login in a shell, then check again.</Trans>
          <div className="mt-2.5 flex h-8 items-center gap-1 rounded-[var(--radius-md)] bg-[var(--bg)] pl-2.5 pr-1 shadow-[inset_0_0_0_1px_var(--hairline)]">
            <span className="shrink-0 select-none font-mono text-[11px] text-[var(--text-tertiary)]">$</span>
            <code className="min-w-0 flex-1 select-text truncate font-mono text-[11px] text-[var(--text-primary)]">
              {loginCommand}
            </code>
            <button
              type="button"
              onClick={copy}
              data-tip={t`Copy`}
              aria-label={t`Copy`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] transition-colors duration-[var(--dur-1)] hover:bg-[var(--fill-1)] hover:text-[var(--text-primary)]"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-[var(--green)]" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {onRunLogin && (
              <button
                type="button"
                disabled={loginState !== 'current'}
                onClick={() => onRunLogin(loginCommand)}
                className={loginState === 'current' ? primaryButtonClass : secondaryButtonClass}
              >
                <SquareTerminal className="h-3.5 w-3.5" />
                <Trans>Run in a shell tab</Trans>
              </button>
            )}
            <button type="button" onClick={onRetry} className={quietButtonClass}>
              <Trans>Check again</Trans>
            </button>
          </div>
        </SetupStep>
      </SetupSteps>
    </EmptyState>
  );
}
