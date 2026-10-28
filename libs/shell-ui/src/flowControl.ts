/** Pause the PTY once this much output is waiting in xterm's write queue… */
export const FLOW_HIGH_WATERMARK = 512 * 1024;
/** …and resume once it is down to this. */
export const FLOW_LOW_WATERMARK = 128 * 1024;

export interface FlowControl {
  /**
   * Account for `bytes` handed to `term.write`; returns the write callback
   * that releases them once xterm has parsed them.
   */
  track(bytes: number): () => void;
  /** Resume if paused — call when the terminal goes away. */
  dispose(): void;
}

/**
 * xterm.js watermark flow control: a flood can no longer queue megabytes
 * ahead of the parser, so Ctrl-C shows up on screen right away.
 */
export function createFlowControl(
  pause: () => void,
  resume: () => void,
  high = FLOW_HIGH_WATERMARK,
  low = FLOW_LOW_WATERMARK,
): FlowControl {
  let pending = 0;
  let paused = false;
  let disposed = false;
  return {
    track(bytes) {
      pending += bytes;
      if (!paused && !disposed && pending > high) {
        paused = true;
        pause();
      }
      return () => {
        pending -= bytes;
        if (paused && !disposed && pending < low) {
          paused = false;
          resume();
        }
      };
    },
    dispose() {
      disposed = true;
      if (paused) {
        paused = false;
        resume();
      }
    },
  };
}
