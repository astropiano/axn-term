/**
 * Perf-trace mark for the perf flows. The desktop app injects
 * `window.__AXN_PERF__` only while `AXN_TERM_PERF_TRACE` is set; otherwise
 * this is a no-op property read.
 */
export function perfMark(name: string, detail?: string): void {
  (globalThis as { __AXN_PERF__?: (name: string, detail?: string) => void }).__AXN_PERF__?.(
    name,
    detail,
  );
}
