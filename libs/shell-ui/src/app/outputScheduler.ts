/**
 * Paces the writes into the sessions' headless xterm buffers.
 *
 * Every session owns a headless terminal that parses its PTY output so the
 * screen can be read and repainted without a mounted view. xterm parses a
 * write asynchronously, in time slices of its own — N terminals all fed at
 * once (a restore starts every shell together) take turns on the one main
 * thread and starve it: the app freezes for seconds although each handler
 * returns in microseconds.
 *
 * The scheduler allows at most `maxConcurrent` writes to be in flight across
 * all buffers (a write is in flight until xterm reports it parsed). While a
 * permit is free a chunk goes straight through — no queue, no delay, so
 * ordinary use and the selected session behave as before. When all permits
 * are taken the chunk waits in its session's queue; permits go to the
 * priority session (the one on screen) first, then round-robin. The
 * throughput that decides between the two is simply "are permits left" — no
 * thresholds to tune, and it relaxes by itself once the storm is over.
 *
 * Order within a session is never changed and nothing is dropped. A session
 * whose queue grows past `highWater` pauses its PTY until it is back under
 * `lowWater` (the producer slows to what the parser can take).
 */

export interface BufferTarget {
  /** Like xterm's `Terminal.write`: `done` fires once the data is parsed. */
  write(data: Uint8Array, done?: () => void): void;
}

export interface OutputSchedulerOptions {
  /** Writes in flight at once, across all sessions. */
  maxConcurrent?: number;
  /** Largest batch handed to one write when draining a queue. */
  maxBatchBytes?: number;
  /** Queued bytes per session at which its PTY is paused… */
  highWater?: number;
  /** …and resumed again. */
  lowWater?: number;
  /** Yields between drained batches (default: setTimeout 0). */
  defer?: (fn: () => void) => void;
  pause?: (id: string) => void;
  resume?: (id: string) => void;
}

interface Entry {
  target: BufferTarget;
  queue: Uint8Array[];
  queued: number;
  paused: boolean;
}

export interface OutputScheduler {
  register(id: string, target: BufferTarget): void;
  unregister(id: string): void;
  push(id: string, bytes: Uint8Array): void;
  /** The session whose output goes first (the one on screen). */
  setPriority(id: string | undefined): void;
  /** Hand everything queued for `id` to its buffer now (before reading it). */
  drain(id: string): void;
  stats(): { inFlight: number; queuedBytes: number; peakQueuedBytes: number; queuedSessions: number };
}

export function createOutputScheduler(options: OutputSchedulerOptions = {}): OutputScheduler {
  const maxConcurrent = options.maxConcurrent ?? 2;
  const maxBatch = options.maxBatchBytes ?? 64 * 1024;
  const high = options.highWater ?? 4 * 1024 * 1024;
  const low = options.lowWater ?? 1024 * 1024;
  const defer = options.defer ?? ((fn) => void setTimeout(fn, 0));
  const entries = new Map<string, Entry>();
  let inFlight = 0;
  let priority: string | undefined;
  let rotation = 0;
  let pumpScheduled = false;
  let peak = 0;

  const queuedTotal = () => {
    let n = 0;
    for (const e of entries.values()) n += e.queued;
    return n;
  };

  /** Let the producer run again once the queue is back under the low watermark. */
  function maybeResume(id: string, entry: Entry): void {
    if (entries.get(id) === entry && entry.paused && entry.queued < low) {
      entry.paused = false;
      options.resume?.(id);
    }
  }

  function release(id: string, entry: Entry): void {
    inFlight -= 1;
    maybeResume(id, entry);
    schedulePump();
  }

  function startWrite(id: string, entry: Entry, data: Uint8Array): void {
    inFlight += 1;
    let settled = false;
    entry.target.write(data, () => {
      if (settled) return;
      settled = true;
      release(id, entry);
    });
  }

  /** Concatenate queued chunks up to the batch size (always at least one). */
  function takeBatch(entry: Entry): Uint8Array {
    if (entry.queue.length === 1 || entry.queue[0].length >= maxBatch) {
      const first = entry.queue.shift()!;
      entry.queued -= first.length;
      return first;
    }
    let size = 0;
    let count = 0;
    while (count < entry.queue.length && size + entry.queue[count].length <= maxBatch) {
      size += entry.queue[count].length;
      count += 1;
    }
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of entry.queue.splice(0, count)) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    entry.queued -= size;
    return out;
  }

  /** The next session to serve: the priority one, else round-robin. */
  function nextWaiting(): [string, Entry] | undefined {
    if (priority) {
      const e = entries.get(priority);
      if (e && e.queue.length > 0) return [priority, e];
    }
    const ids = [...entries.keys()];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[(rotation + i) % ids.length];
      const e = entries.get(id)!;
      if (e.queue.length > 0) {
        rotation = (rotation + i + 1) % ids.length;
        return [id, e];
      }
    }
    return undefined;
  }

  function pump(): void {
    pumpScheduled = false;
    while (inFlight < maxConcurrent) {
      const next = nextWaiting();
      if (!next) return;
      startWrite(next[0], next[1], takeBatch(next[1]));
      maybeResume(next[0], next[1]);
    }
  }

  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    defer(pump);
  }

  return {
    register(id, target) {
      const current = entries.get(id);
      if (current) {
        current.target = target;
        return;
      }
      entries.set(id, { target, queue: [], queued: 0, paused: false });
    },
    unregister(id) {
      const e = entries.get(id);
      if (!e) return;
      entries.delete(id);
      if (e.paused) options.resume?.(id);
    },
    push(id, bytes) {
      const e = entries.get(id);
      if (!e || bytes.length === 0) return;
      // A free permit and nothing waiting ahead of this chunk: straight through.
      if (e.queue.length === 0 && inFlight < maxConcurrent) {
        startWrite(id, e, bytes);
        return;
      }
      e.queue.push(bytes);
      e.queued += bytes.length;
      peak = Math.max(peak, queuedTotal());
      if (!e.paused && e.queued > high) {
        e.paused = true;
        options.pause?.(id);
      }
      schedulePump();
    },
    setPriority(id) {
      priority = id;
    },
    drain(id) {
      const e = entries.get(id);
      if (!e) return;
      while (e.queue.length > 0) {
        const data = takeBatch(e);
        e.target.write(data);
      }
      if (e.paused) {
        e.paused = false;
        options.resume?.(id);
      }
    },
    stats() {
      let sessions = 0;
      for (const e of entries.values()) if (e.queue.length > 0) sessions += 1;
      return { inFlight, queuedBytes: queuedTotal(), peakQueuedBytes: peak, queuedSessions: sessions };
    },
  };
}
