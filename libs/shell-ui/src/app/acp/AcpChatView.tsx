import { useEffect, useRef, useState } from 'react';
import type { SessionAttention, SessionStatus } from '../../types';
import type { AvailableCommand, PermissionRequest, PlanEntry, ToolCall } from './types';
import { AcpClient, type AcpHandlers, type AcpPipe } from './acpClient';

/**
 * ACP agent-chat view — the shell-less session's main view (and a session
 * sub-view tab). Pattern borrowed from tassistant's ChatInterface, styled
 * on axn-term theme tokens: `var(--accent)`, `var(--text-secondary)`, the
 * panel's inherited text color — so it follows the user's theme/fonts.
 */

type Entry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'agent'; id: number; text: string }
  | { kind: 'thought'; id: number; text: string }
  | { kind: 'plan'; id: number; entries: PlanEntry[] }
  | { kind: 'tool'; id: number; call: ToolCall }
  | { kind: 'permission'; id: number; request: PermissionRequest; answered?: string }
  | { kind: 'system'; id: number; text: string }
  | { kind: 'error'; id: number; text: string };

/** `Omit` that distributes over the `Entry` union (plain Omit collapses it). */
type EntryDraft = Entry extends infer T ? (T extends Entry ? Omit<T, 'id'> : never) : never;

const PLAN_ICON = { pending: '○', in_progress: '▶', completed: '●' } as const;
const STATUS_LABEL = { pending: 'queued', in_progress: 'running', completed: 'done', failed: 'failed' } as const;

function toolText(call: ToolCall): string {
  const diff = call.content?.find((c): c is Extract<typeof c, { type: 'diff' }> => c.type === 'diff');
  if (diff) return `--- ${diff.path}\n+++ ${diff.path}\n${diff.newText}`;
  const block = call.content?.find(
    (c): c is Extract<typeof c, { type: 'content' }> => c.type === 'content',
  );
  return block?.content.text ?? (typeof call.rawOutput === 'string' ? call.rawOutput : '');
}

export function AcpChatView({
  pipe,
  cwd,
  resumeSessionId,
  onSessionId,
  onTurn,
  onPlan,
  onAttention,
  onAxnCommand,
  handlers,
}: {
  pipe: AcpPipe;
  cwd?: string;
  /** Agent→client services (fs/terminal) the agent may call — absent tiers answer -32601. */
  handlers?: AcpHandlers;
  /** Persisted ACP session id — `session/load` is attempted first (falls back to `session/new`). */
  resumeSessionId?: string;
  /** The ACP session id once `session/new`/`session/load` assigned it — for persistence. */
  onSessionId?: (sessionId: string) => void;
  /** ACP turn lifecycle → the tab's `hookStatus` badge. */
  onTurn?: (status: SessionStatus | undefined) => void;
  /** ACP plan entries → the tab's `tasks`/`progress`. */
  onPlan?: (entries: PlanEntry[]) => void;
  /** Pending permission request → the tab's `hookAttention` flag (null clears). */
  onAttention?: (attention: SessionAttention | null) => void;
  /**
   * Route an `/axn-*` composer line to axn-term's command dispatch (the
   * leading slash is stripped before the call). Mirrors the shell prompt's
   * dispatch result: `false` = handled silently, a string = a replacement
   * `echo …` line shown as a system note, `undefined` = unknown command.
   */
  onAxnCommand?: (line: string) => Promise<string | false | undefined>;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [turn, setTurn] = useState<'idle' | 'running' | 'blocked'>('idle');
  const [ready, setReady] = useState(false);
  const [agentCommands, setAgentCommands] = useState<AvailableCommand[]>([]);
  const clientRef = useRef<AcpClient | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const streamId = useRef(0);
  const respondOnce = useRef<((optionId: string) => void) | null>(null);

  const push = (e: EntryDraft) =>
    setEntries((prev) => [...prev, { ...e, id: nextId.current++ } as Entry]);

  useEffect(() => {
    const client = new AcpClient(pipe, {
      onUpdate: (u) => {
        switch (u.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = u.content.text ?? '';
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              return last?.kind === 'agent' && last.id === streamId.current
                ? [...prev.slice(0, -1), { ...last, text: last.text + text }]
                : [...prev, { kind: 'agent', id: (streamId.current = nextId.current++), text }];
            });
            break;
          }
          case 'agent_thought_chunk': {
            const text = u.content.text ?? '';
            setEntries((prev) => {
              const last = prev[prev.length - 1];
              return last?.kind === 'thought'
                ? [...prev.slice(0, -1), { ...last, text: last.text + text }]
                : [...prev, { kind: 'thought', id: nextId.current++, text }];
            });
            break;
          }
          case 'plan':
            push({ kind: 'plan', entries: u.entries });
            onPlan?.(u.entries);
            break;
          case 'tool_call':
            push({ kind: 'tool', call: u });
            break;
          case 'tool_call_update':
            setEntries((prev) =>
              prev.map((e) =>
                e.kind === 'tool' && e.call.toolCallId === u.toolCallId
                  ? { ...e, call: { ...e.call, ...u } }
                  : e,
              ),
            );
            break;
          case 'available_commands_update':
            setAgentCommands(u.availableCommands);
            break;
          default:
            break;
        }
      },
      onPermission: (request, respond) => {
        setTurn('blocked');
        onTurn?.('blocked');
        onAttention?.({
          level: 'critical',
          message: `permission requested: ${request.toolCall.title}`,
        });
        push({ kind: 'permission', request });
        const orig = respond;
        respondOnce.current = (optionId) => {
          setEntries((prev) =>
            prev.map((e) =>
              e.kind === 'permission' && e.request === request ? { ...e, answered: optionId } : e,
            ),
          );
          setTurn('running');
          onTurn?.('running');
          onAttention?.(null);
          orig(optionId);
        };
      },
      onExit: (code) => {
        onTurn?.(undefined);
        onAttention?.(null);
        push({ kind: 'error', text: `agent exited (code ${code ?? '?'})` });
      },
      onError: (m) => push({ kind: 'error', text: m }),
    }, handlers);
    clientRef.current = client;
    respondOnce.current = null;
    void (async () => {
      try {
        await client.initialize();
        if (resumeSessionId) await client.sessionLoad(cwd ?? '/', resumeSessionId);
        else await client.sessionNew(cwd ?? '/');
        onSessionId?.(client.sessionId!);
        setReady(true);
      } catch (e) {
        push({ kind: 'error', text: `ACP init failed: ${String(e)}` });
      }
    })();
    return () => client.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipe]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  const submit = async () => {
    const text = input.trim();
    if (!text || turn === 'running' || !ready) return;
    if (text.startsWith('/axn-') && onAxnCommand) {
      setInput('');
      const res = await onAxnCommand(text.slice(1));
      if (res === false) return;
      const echo = typeof res === 'string' ? /^echo\s+"([\s\S]*)"\s*$/.exec(res) : null;
      push({ kind: 'system', text: echo?.[1] ?? (typeof res === 'string' ? res : `unknown command: ${text}`) });
      return;
    }
    setInput('');
    push({ kind: 'user', text });
    setTurn('running');
    onTurn?.('running');
    try {
      await clientRef.current!.prompt(text);
      setTurn('idle');
      onTurn?.('completed');
    } catch (e) {
      push({ kind: 'error', text: String(e) });
      setTurn('idle');
      onTurn?.('completed');
    }
  };

  return (
    <div className="flex h-full flex-col text-sm" style={{ fontFamily: 'inherit' }}>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {entries.map((e) => {
          switch (e.kind) {
            case 'user':
              return (
                <div key={e.id} className="ml-8 rounded-md px-3 py-2" style={{ background: 'var(--accent)', color: 'var(--accent-fg, #fff)' }}>
                  {e.text}
                </div>
              );
            case 'agent':
              return <div key={e.id} className="mr-8 whitespace-pre-wrap">{e.text}</div>;
            case 'thought':
              return (
                <div key={e.id} className="mr-8 whitespace-pre-wrap italic text-[var(--text-secondary)]">
                  {e.text}
                </div>
              );
            case 'plan':
              return (
                <div key={e.id} className="rounded border border-[var(--border,#8884)] p-2">
                  <div className="mb-1 font-medium text-[var(--text-secondary)]">Plan</div>
                  {e.entries.map((p, i) => (
                    <div key={i} className="flex gap-2">
                      <span className={p.status === 'in_progress' ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>
                        {PLAN_ICON[p.status]}
                      </span>
                      <span className={p.status === 'completed' ? 'text-[var(--text-secondary)] line-through' : ''}>
                        {p.content}
                      </span>
                    </div>
                  ))}
                </div>
              );
            case 'tool': {
              const body = toolText(e.call);
              return (
                <div key={e.id} className="rounded border border-[var(--border,#8884)] p-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{e.call.title}</span>
                    <span className={`text-xs ${e.call.status === 'failed' ? 'text-red-500' : 'text-[var(--text-secondary)]'}`}>
                      {STATUS_LABEL[e.call.status ?? 'pending']}
                    </span>
                  </div>
                  {e.call.locations?.map((l, i) => (
                    <div key={i} className="text-xs text-[var(--text-secondary)]">
                      {l.path}{l.line !== undefined ? `:${l.line}` : ''}
                    </div>
                  ))}
                  {body && (
                    <pre className="mt-1 max-h-60 overflow-auto rounded bg-black/10 p-2 text-xs" style={{ fontFamily: 'var(--shell-font, monospace)' }}>
                      {body}
                    </pre>
                  )}
                </div>
              );
            }
            case 'permission':
              return (
                <div key={e.id} className="rounded border border-[var(--accent)] p-2">
                  <div className="mb-2 font-medium">Allow: {e.request.toolCall.title}</div>
                  <div className="flex gap-2">
                    {e.request.options.map((o) => (
                      <button
                        key={o.optionId}
                        disabled={!!e.answered}
                        onClick={() => respondOnce.current?.(o.optionId)}
                        className="rounded border border-[var(--border,#8884)] px-2 py-1 text-xs disabled:opacity-50"
                        style={e.answered === o.optionId ? { background: 'var(--accent)', color: 'var(--accent-fg, #fff)' } : undefined}
                      >
                        {o.name}
                      </button>
                    ))}
                  </div>
                </div>
              );
            case 'system':
              return (
                <div key={e.id} className="text-xs text-[var(--text-secondary)]">
                  {e.text}
                </div>
              );
            case 'error':
              return <div key={e.id} className="text-red-500">{e.text}</div>;
          }
        })}
        {turn === 'running' && <div className="text-[var(--text-secondary)]">…</div>}
        <div ref={endRef} />
      </div>
      {agentCommands.length > 0 && input.startsWith('/') && (
        <div className="flex flex-wrap gap-1 border-t border-[var(--border,#8884)] px-2 pt-2">
          {agentCommands
            .filter((c) => `/${c.name}`.startsWith(input.trim().split(/\s/)[0] || '/'))
            .map((c) => (
              <button
                key={c.name}
                type="button"
                data-tip={c.description}
                onClick={() => setInput(`/${c.name} `)}
                className="rounded border border-[var(--border,#8884)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
              >
                /{c.name}
              </button>
            ))}
        </div>
      )}
      <div className="flex gap-2 border-t border-[var(--border,#8884)] p-2">
        <textarea
          value={input}
          onChange={(ev) => setInput(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) {
              ev.preventDefault();
              void submit();
            }
          }}
          placeholder={ready ? 'Message the agent… (/ commands)' : 'connecting…'}
          rows={2}
          className="flex-1 resize-none rounded border border-[var(--border,#8884)] bg-transparent px-2 py-1 outline-none focus:border-[var(--accent)]"
        />
        {turn === 'running' ? (
          <button onClick={() => clientRef.current?.cancel()} className="self-end rounded border border-[var(--border,#8884)] px-3 py-1">
            Stop
          </button>
        ) : (
          <button
            onClick={() => void submit()}
            disabled={!input.trim() || !ready}
            className="self-end rounded px-3 py-1 disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg, #fff)' }}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}
