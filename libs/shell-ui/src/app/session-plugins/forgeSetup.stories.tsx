import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitMerge, GitPullRequest } from 'lucide-react';
import { ForgeSetup } from './forgeSetup';
import { StoryShellProviders } from '../storyMocks';

const meta = {
  title: 'app/Forge setup',
  component: ForgeSetup,
  decorators: [
    (Story) => (
      <StoryShellProviders>
        <div className="w-[480px] rounded-[var(--radius-lg)] bg-[var(--bg)] p-3 shadow-[0_0_0_1px_var(--hairline)]">
          <Story />
        </div>
      </StoryShellProviders>
    ),
  ],
  args: {
    cli: 'glab',
    forgeName: 'GitLab',
    defaultHost: 'gitlab.com',
    installUrl: 'https://gitlab.com/gitlab-org/cli',
    failure: 'signed-out',
    icon: <GitMerge />,
    onUseHost: () => {},
    onRunLogin: () => {},
    onRetry: () => {},
  },
} satisfies Meta<typeof ForgeSetup>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The usual first run on a self-hosted instance: the CLI asked its public
 * default host, and an open session's remote points somewhere else — the
 * host step is the one to act on.
 */
export const SelfHostedRemoteFound: Story = {
  args: { suggestedHost: 'gitlab.example.com' },
};

/** A host is configured — only the sign-in is left. */
export const HostConfigured: Story = {
  args: { host: 'gitlab.example.com' },
};

/** Nothing self-hosted in sight: the default host is fine, sign in. */
export const DefaultHost: Story = {};

/** The CLI itself is missing. */
export const CliMissing: Story = {
  args: { failure: 'missing' },
};

export const GitHub: Story = {
  args: {
    cli: 'gh',
    forgeName: 'GitHub',
    defaultHost: 'github.com',
    installUrl: 'https://cli.github.com',
    icon: <GitPullRequest />,
  },
};
