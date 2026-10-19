import type { SessionViewPlugin } from './plugin';

/**
 * Remote-link control: pauses/resumes this device's viewport claim on the
 * shared PTY geometry. Paused keeps the connection live — output still
 * streams in — but this device stops pinning the shared terminal size, so a
 * bigger screen elsewhere wins the geometry back. Pinned to the top of the
 * rail and only renders when the backend exposes `setViewportPaused`
 * (remote/hosted mode — absent in local WS mode by design).
 */
function RemoteLinkRailView({
  paused,
  onToggle,
}: {
  paused: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-tip={
        paused
          ? 'Resume viewport — this device shares the terminal size again'
          : 'Pause viewport — let other devices own the terminal size'
      }
      aria-pressed={paused}
      aria-label={paused ? 'Resume viewport' : 'Pause viewport'}
      className={`flex h-8 w-8 items-center justify-center rounded border transition-colors ${
        paused
          ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]'
          : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
      }`}
    >
      {/* Pause-bars icon when active (viewport released), link icon when live. */}
      {paused ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden>
          <rect x="3" y="2" width="3" height="10" rx="1" />
          <rect x="8" y="2" width="3" height="10" rx="1" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M5.5 8.5a2.5 2.5 0 0 0 3.54 0l1.5-1.5a2.5 2.5 0 0 0-3.54-3.54l-.86.86" />
          <path d="M8.5 5.5a2.5 2.5 0 0 0-3.54 0l-1.5 1.5a2.5 2.5 0 0 0 3.54 3.54l.86-.86" />
        </svg>
      )}
    </button>
  );
}

export const remoteLinkPlugin: SessionViewPlugin = {
  id: 'remote-link',
  title: 'Remote link',
  version: '0.1.0',
  defaultEnabled: true,
  pinned: true,
  renderRail: ({ backend, appState, updateAppState }) => {
    if (!backend.setViewportPaused) return null;
    const paused = (appState as { paused?: boolean } | undefined)?.paused === true;
    return (
      <RemoteLinkRailView
        paused={paused}
        onToggle={() => {
          backend.setViewportPaused!(!paused);
          updateAppState({ paused: !paused });
        }}
      />
    );
  },
};
