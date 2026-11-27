import type { Meta, StoryObj } from '@storybook/react-vite';
import type { AcpPipe } from './acpClient';
import { AcpChatView } from './AcpChatView';
import { StoryShellProviders } from '../storyMocks';

const SESSION_ID = 'demo-acp-1';

/**
 * A scripted ACP agent: answers initialize/session-new/session-prompt like a
 * real agent over NDJSON — thought + plan + tool calls + a permission
 * request + streaming message chunks, then end_turn.
 */
function demoPipe(): AcpPipe {
  let onLine: ((line: string) => void) | undefined;
  const send = (msg: object, delay = 0) =>
    setTimeout(() => onLine?.(JSON.stringify(msg)), delay);
  const result = (id: number, result: unknown, delay = 0) =>
    send({ jsonrpc: '2.0', id, result }, delay);
  const update = (u: object, delay = 0) =>
    send(
      { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update: u } },
      delay,
    );

  return {
    write(line) {
      const msg = JSON.parse(line);
      switch (msg.method) {
        case 'initialize':
          result(msg.id, {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, embeddedContext: true },
            },
            agentInfo: { name: 'demo-agent', title: 'Demo ACP Agent', version: '0.0.0-story' },
          });
          break;
        case 'session/new':
        case 'session/load':
          result(msg.id, { sessionId: SESSION_ID });
          // Canned backlog, like a resumed conversation.
          update(
            {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Why is restore so slow with ten sessions?' },
            },
            60,
          );
          update(
            {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'The restore map fans out unbounded — every session PTY and headless buffer starts parsing at once. Let me check the queue.',
              },
            },
            120,
          );
          update(
            {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                { name: 'explain', description: 'Explain the current plan' },
                { name: 'verbose', description: 'Toggle verbose tool output' },
              ],
            },
            150,
          );
          break;
        case 'session/prompt': {
          const t = (ms: number, f: () => void) => setTimeout(f, ms);
          t(120, () =>
            update({
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'Let me look at the restore path first.' },
            }),
          );
          t(300, () =>
            update({
              sessionUpdate: 'plan',
              entries: [
                { content: 'Find where restore writes to the PTY', status: 'completed' },
                { content: 'Reproduce the pacing failure', status: 'in_progress' },
                { content: 'Bound the restore concurrency', status: 'pending' },
              ],
            }),
          );
          t(500, () =>
            update({
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-1',
              title: 'Read useShellSessions.ts',
              kind: 'read',
              status: 'in_progress',
              locations: [{ path: 'libs/shell-ui/src/app/useShellSessions.ts', line: 412 }],
            }),
          );
          t(900, () =>
            update({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc-1',
              status: 'completed',
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: 'const restored = sessions.map(restoreSession);\nawait Promise.all(restored); // unbounded',
                  },
                },
              ],
            }),
          );
          t(1200, () =>
            update({
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-2',
              title: 'Edit useShellSessions.ts',
              kind: 'edit',
              status: 'in_progress',
              locations: [{ path: 'libs/shell-ui/src/app/useShellSessions.ts', line: 412 }],
              content: [
                {
                  type: 'diff',
                  path: 'libs/shell-ui/src/app/useShellSessions.ts',
                  oldText: 'await Promise.all(restored);',
                  newText: 'await restoreQueue.run(restored);',
                },
              ],
            }),
          );
          t(1500, () =>
            send({
              jsonrpc: '2.0',
              id: 9001,
              method: 'session/request_permission',
              params: {
                sessionId: SESSION_ID,
                toolCall: { toolCallId: 'tc-3', title: 'Run `pnpm test restore`', kind: 'execute' },
                options: [
                  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
                  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ],
              },
            }),
          );
          t(1500, () =>
            update({
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-3',
              title: 'Run `pnpm test restore`',
              kind: 'execute',
              status: 'pending',
            }),
          );
          t(1800, () =>
            update({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Found it — the restore map fans out unbounded. I queued it through `restoreQueue` instead; the failing tests should pass once the run finishes.',
              },
            }),
          );
          t(2100, () => result(msg.id, { stopReason: 'end_turn' }));
          break;
        }
        case 'session/cancel':
          break;
        default:
          break;
      }
    },
    onLine(cb) {
      onLine = cb;
    },
    onExit() {},
    close() {},
  };
}

function Chat({ height = 480 }: { height?: number }) {
  return (
    <StoryShellProviders>
      <div style={{ height, width: '100%', border: '1px solid var(--border)' }}>
        <AcpChatView pipe={demoPipe()} cwd="/repo/axn-term" />
      </div>
    </StoryShellProviders>
  );
}

const meta = {
  title: 'app/AcpChatView',
  component: AcpChatView,
} satisfies Meta<typeof AcpChatView>;
export default meta;
type Story = StoryObj;

/** Type a message — the demo agent answers with a full scripted turn. */
export const ScriptedAgent: Story = {
  render: () => <Chat />,
};

/** The composer placeholder stays 'connecting…' until initialize resolves. */
export const Connecting: Story = {
  render: () => (
    <StoryShellProviders>
      <div style={{ height: 300, border: '1px solid var(--border)' }}>
        <AcpChatView
          pipe={{ write() {}, onLine() {}, onExit() {}, close() {} }}
          cwd="/repo/axn-term"
        />
      </div>
    </StoryShellProviders>
  ),
};
