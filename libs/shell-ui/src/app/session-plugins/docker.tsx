import { useEffect, useState } from 'react';
import type { SessionViewPlugin } from './plugin';
import type { SessionAttention, ShellSession } from '../../types';
import { ptyIdOf } from '../../types';
import { useSessionBackend } from '../../services';
import { pressureColor } from './ram';

/**
 * Official Docker whale mark (simple-icons), rendered in currentColor so it
 * follows the rail's text colors.
 */
function DockerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
    </svg>
  );
}

export interface DockerStats {
  /** Containers in state `running`. */
  running: number;
  /** Containers in any other state (exited, created, paused, dead, …). */
  stopped: number;
  /** Bytes held by docker objects — the `docker system df` size total. */
  usedBytes: number;
  /**
   * Free bytes on docker's backing filesystem (`df` of `DockerRootDir`,
   * falling back to `/` — e.g. on macOS where the root dir lives inside the
   * docker VM). `null` when the df line could not be parsed.
   */
  freeBytes: number | null;
}

/**
 * One `sh -c` probe producing the three labelled sections
 * `parseDockerStats` consumes. Exits non-zero (→ exec rejects → rail hides)
 * when docker is absent or the daemon unreachable.
 */
const DOCKER_STATS_CMD = `
command -v docker >/dev/null 2>&1 || exit 1
root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
[ -n "$root" ] || exit 1
echo '==states=='
docker ps -a --format '{{.State}}' 2>/dev/null
echo '==sizes=='
docker system df --format '{{.Size}}' 2>/dev/null
echo '==disk=='
{ df -k "$root" 2>/dev/null || df -k / 2>/dev/null; } | tail -n 1
`.trim();

/** Docker's humanized sizes (`12.3GB`, `456kB`, `0B`) → bytes. */
export function parseDockerSize(text: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]{0,3})\s*$/i.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const mult: Record<string, number> = {
    '': 1,
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    pb: 1e15,
    eb: 1e18,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    pib: 1024 ** 5,
    eib: 1024 ** 6,
  };
  const k = mult[m[2].toLowerCase()];
  return k === undefined ? null : Math.round(value * k);
}

function sectionLines(output: string, name: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    const marker = /^==(.+)==$/.exec(line);
    if (marker) {
      inside = marker[1] === name;
      continue;
    }
    if (inside && line) lines.push(line);
  }
  return lines;
}

/** Parse the `DOCKER_STATS_CMD` output; `null` when the markers are absent. */
export function parseDockerStats(output: string): DockerStats | null {
  if (!/^==states==$/m.test(output)) return null;
  const states = sectionLines(output, 'states');
  const running = states.filter((s) => s === 'running').length;
  const usedBytes = sectionLines(output, 'sizes').reduce(
    (sum, line) => sum + (parseDockerSize(line) ?? 0),
    0,
  );
  const diskLines = sectionLines(output, 'disk');
  const diskFields = diskLines[diskLines.length - 1]?.split(/\s+/);
  const freeKb = diskFields && diskFields.length >= 4 ? parseInt(diskFields[3], 10) : NaN;
  return {
    running,
    stopped: states.length - running,
    usedBytes,
    freeBytes: Number.isNaN(freeKb) ? null : freeKb * 1024,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** Attention flag for docker disk pressure — same thresholds as RAM. */
function diskAttention(usedPct: number): SessionAttention | null {
  if (usedPct >= 90) {
    return { level: 'critical', message: `docker disk ${usedPct}% used` };
  }
  if (usedPct >= 80) return { level: 'warning', message: `docker disk ${usedPct}% used` };
  return null;
}

function DockerRail({
  sessions,
  pluginSettings,
  setAppAttention,
}: {
  sessions: ShellSession[];
  pluginSettings: unknown;
  setAppAttention: (attention: SessionAttention | null) => void;
}) {
  const backend = useSessionBackend();
  const [stats, setStats] = useState<DockerStats | null>(null);
  const intervalSec =
    (pluginSettings as { refreshIntervalSeconds?: number } | undefined)
      ?.refreshIntervalSeconds ?? 15;
  // The rail is session-less: on desktop `plugin_exec` ignores the id and runs
  // on the host; over WS the probe runs in the first session's host. With no
  // sessions, desktop still works (empty id) while web execs reject → hidden.
  const target = sessions.length > 0 ? ptyIdOf(sessions[0]) : '';

  useEffect(() => {
    const exec = backend.exec?.bind(backend);
    if (!exec) return;
    let cancelled = false;
    // `docker system df` can take seconds — never stack overlapping polls.
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const out = await exec(target, DOCKER_STATS_CMD);
        if (!cancelled) setStats(parseDockerStats(out));
      } catch {
        // Docker absent/daemon down or no connected session → hide.
        if (!cancelled) setStats(null);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const id = setInterval(poll, Math.max(5, intervalSec) * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [backend, target, intervalSec]);

  const totalBytes =
    stats?.freeBytes != null ? stats.usedBytes + stats.freeBytes : 0;
  const usedPct =
    totalBytes > 0 ? Math.min(100, Math.round(((stats?.usedBytes ?? 0) / totalBytes) * 100)) : 0;

  useEffect(() => {
    setAppAttention(stats && stats.freeBytes != null ? diskAttention(usedPct) : null);
  }, [setAppAttention, stats, usedPct]);

  if (!stats) return null;
  const title = [
    `docker — ${stats.running} running, ${stats.stopped} stopped`,
    stats.freeBytes != null
      ? `disk ${formatBytes(stats.usedBytes)} used · ${formatBytes(stats.freeBytes)} free`
      : `disk ${formatBytes(stats.usedBytes)} used`,
  ].join('\n');
  return (
    <div data-tip={title} className="flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-0.5">
        <div className="flex flex-col items-center gap-0.5">
          <span
            className={`select-none text-[8px] font-bold leading-none ${
              stats.running > 0 ? 'text-[var(--green)]' : 'text-[var(--text-secondary)]'
            }`}
            data-tip="running containers"
          >
            {stats.running}
          </span>
          <span
            className="select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]"
            data-tip="stopped containers"
          >
            {stats.stopped}
          </span>
        </div>
        <DockerIcon className="h-3.5 w-3.5 text-[var(--text-secondary)]" />
      </div>
      {stats.freeBytes != null && (
        <>
          <div className="mt-0.5 flex h-3 w-7 items-center overflow-hidden rounded-sm border border-[var(--border)] bg-[var(--surface)]">
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${usedPct}%`, background: pressureColor(usedPct, 0) }}
            />
          </div>
          <span
            className="select-none text-[8px] font-bold leading-none text-[var(--text-secondary)]"
            data-tip="disk used by docker objects"
          >
            {formatBytes(stats.usedBytes)}
          </span>
        </>
      )}
    </div>
  );
}

export const dockerPlugin: SessionViewPlugin = {
  id: 'docker',
  title: 'Docker',
  version: '0.1.0',
  settings: [
    {
      key: 'refreshIntervalSeconds',
      label: 'Refresh interval (seconds)',
      description: 'How often container and disk stats are polled.',
      type: 'number',
      default: 15,
    },
  ],
  renderRail: ({ sessions, pluginSettings, setAppAttention }) => (
    <DockerRail
      sessions={sessions}
      pluginSettings={pluginSettings}
      setAppAttention={setAppAttention}
    />
  ),
};
