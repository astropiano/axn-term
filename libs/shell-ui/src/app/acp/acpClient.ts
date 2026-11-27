import type { ProcessPipe } from '@axn-term/session-backend';
import type {
  ContentBlock,
  JsonRpcMessage,
  PermissionRequest,
  SessionUpdate,
  StopReason,
} from './types';

/**
 * A stdio pipe to a spawned ACP agent — the transport seam. Backends
 * fill it via `SessionBackend.spawnProcess` (desktop: the `acp_*` Tauri
 * commands; the web story rides a backend stream later).
 */
export type AcpPipe = ProcessPipe;

/**
 * Client-side services an agent may call back into (the ACP "client
 * methods"). Absent tiers answer `-32601` for their methods; `acpHandlers`
 * builds these over the session backend (fs port + invisible PTYs).
 */
export interface AcpHandlers {
  fs?: {
    readTextFile(path: string): Promise<string>;
    writeTextFile(path: string, contents: string): Promise<void>;
  };
  terminal?: {
    /** Spawn an agent-owned terminal; resolves the terminal id. */
    create(params: { command: string; cwd?: string }): Promise<string>;
    output(terminalId: string): Promise<{
      output: string;
      truncated?: boolean;
      exit_status?: { exit_code: number | null };
    }>;
    kill(terminalId: string): Promise<void>;
    release(terminalId: string): Promise<void>;
    waitForExit(terminalId: string): Promise<{ exit_code: number | null }>;
  };
}

export interface AcpClientEvents {
  /** session/update notifications, in order. */
  onUpdate(update: SessionUpdate & { sessionId: string }): void;
  /** Agent asks for tool permission — resolve with an optionId. */
  onPermission(request: PermissionRequest, respond: (optionId: string) => void): void;
  /** Agent→client fs/terminal requests we decline for now (M2). */
  onExit?(code: number | null): void;
  onError?(message: string): void;
}

/**
 * Minimal ACP client: NDJSON JSON-RPC framing, id-matched requests,
 * notifications dispatched to `events`. Client→agent methods are the
 * session lifecycle; agent→client requests (fs/terminal) are answered
 * with a generic error until those surfaces land (M2/M3).
 */
export class AcpClient {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  sessionId?: string;

  constructor(
    private pipe: AcpPipe,
    private events: AcpClientEvents,
    private handlers: AcpHandlers = {},
  ) {
    pipe.onLine((line) => this.handleLine(line));
    pipe.onExit?.((code) => {
      for (const [, p] of this.pending) p.reject(new Error(`agent exited (code ${code})`));
      this.pending.clear();
      events.onExit?.(code);
    });
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (msg.method === 'session/update') {
      // The update payload is nested: params = {sessionId, update: {sessionUpdate, …}}.
      const p = msg.params as { sessionId: string; update: SessionUpdate };
      this.events.onUpdate({ ...p.update, sessionId: p.sessionId });
      return;
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const req = msg.params as PermissionRequest;
      const id = msg.id;
      this.events.onPermission(req, (optionId) =>
        this.respond(id, { result: { outcome: { outcome: 'selected', optionId } } }),
      );
      return;
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    // Agent→client requests (fs/*, terminal/*, …) — served by `handlers`
    // where a tier exists, else a method-not-found error so the agent
    // never hangs.
    if (msg.id !== undefined && msg.method) {
      void this.dispatchAgentRequest(msg.id, msg.method, msg.params);
    }
  }

  private async dispatchAgentRequest(
    id: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    const h = this.handlers;
    const p = (params ?? {}) as Record<string, string>;
    try {
      let result: unknown;
      if (method === 'fs/read_text_file' && h.fs) {
        result = { content: await h.fs.readTextFile(p.path) };
      } else if (method === 'fs/write_text_file' && h.fs) {
        await h.fs.writeTextFile(p.path, p.content);
        result = {};
      } else if (method === 'terminal/create' && h.terminal) {
        result = { terminalId: await h.terminal.create({ command: p.command, cwd: p.cwd }) };
      } else if (method === 'terminal/output' && h.terminal) {
        result = await h.terminal.output(p.terminalId);
      } else if (method === 'terminal/kill' && h.terminal) {
        await h.terminal.kill(p.terminalId);
        result = {};
      } else if (method === 'terminal/release' && h.terminal) {
        await h.terminal.release(p.terminalId);
        result = {};
      } else if (method === 'terminal/wait_for_exit' && h.terminal) {
        result = await h.terminal.waitForExit(p.terminalId);
      } else {
        this.respond(id, { error: { code: -32601, message: `${method} not supported` } });
        return;
      }
      this.respond(id, { result });
    } catch (e) {
      this.respond(id, {
        error: { code: -32603, message: String(e instanceof Error ? e.message : e) },
      });
    }
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.pipe.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private respond(id: number, resultOrError: unknown): void {
    this.pipe.write(JSON.stringify({ jsonrpc: '2.0', id, ...(resultOrError as object) }));
  }

  async initialize(): Promise<{ protocolVersion?: number; authMethods?: unknown[] }> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: !!this.handlers.fs,
          writeTextFile: !!this.handlers.fs,
        },
        terminal: !!this.handlers.terminal,
      },
    });
  }

  async sessionNew(cwd: string): Promise<string> {
    const res = await this.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] });
    this.sessionId = res.sessionId;
    return res.sessionId;
  }

  /** Resume a persisted ACP session — falls back to `session/new` when the agent cannot load it. */
  async sessionLoad(cwd: string, sessionId: string): Promise<string> {
    try {
      await this.request('session/load', { cwd, sessionId, mcpServers: [] });
      this.sessionId = sessionId;
      return sessionId;
    } catch {
      return this.sessionNew(cwd);
    }
  }

  async prompt(text: string): Promise<{ stopReason: StopReason }> {
    const content: ContentBlock[] = [{ type: 'text', text }];
    return this.request('session/prompt', { sessionId: this.sessionId, prompt: content });
  }

  cancel(): void {
    this.pipe.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } }),
    );
  }

  dispose(): void {
    this.pipe.close();
  }
}
