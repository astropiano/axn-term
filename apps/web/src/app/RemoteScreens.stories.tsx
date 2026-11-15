import type { Meta, StoryObj } from '@storybook/react-vite';
import type { KnownServer } from '@axn-term/session-backend';
import { LoginScreen } from './LoginScreen';
import { RemoteWaitingView } from './RemoteWaiting';
import { ConnectScreen, UnreachableScreen } from '../mobile/ConnectScreen';

/**
 * The viewer's full-screen states (browser and mobile app): sign-in, the
 * device-code wait, "no desktop yet", refused/offline/unreachable, and the
 * app's connect and unreachable screens. Phone-sized frame.
 */

function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-[720px] w-[390px] overflow-hidden rounded-lg border border-[var(--border)] [transform:translateZ(0)]">
      {children}
    </div>
  );
}

const meta = { title: 'web/RemoteScreens', component: Phone } satisfies Meta<typeof Phone>;
export default meta;
type Story = StoryObj<typeof meta>;
const noop = () => {};

const server: KnownServer = {
  id: 'srv',
  name: 'fedora.local',
  url: 'https://192.168.1.41:18092',
  endpoints: [
    { label: 'lan', gateway: 'https://fedora.local:18092/gw', issuer: 'https://fedora.local:18092/auth/realms/axn-term' },
    { label: 'lan-ip', gateway: 'https://192.168.1.41:18092/gw', issuer: 'https://192.168.1.41:18092/auth/realms/axn-term' },
    { label: 'tailnet', gateway: 'https://fedora.taila3c9a7.ts.net/gw', issuer: 'https://fedora.taila3c9a7.ts.net/auth/realms/axn-term' },
  ],
  clients: {},
  features: { remote: true, cloud: false },
};

export const Login: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <LoginScreen onLogin={noop} loginLabel="Sign in" serverName="fedora.local" onChangeServer={noop} />
    </Phone>
  ),
};

export const LoginPendingCode: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <LoginScreen
        onLogin={noop}
        pending={{ userCode: 'WXYZ-ABCD', verificationUri: 'https://192.168.1.41:18092/auth/realms/axn-term/device', open: noop }}
        onCancel={noop}
        serverName="fedora.local"
        onChangeServer={noop}
      />
    </Phone>
  ),
};

export const LoginFailed: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <LoginScreen
        onLogin={noop}
        loginLabel="Sign in"
        authError="Sign-in failed: cannot reach the sign-in server (Failed to fetch)"
        serverName="fedora.local"
        onChangeServer={noop}
      />
    </Phone>
  ),
};

export const NoDesktopYet: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <RemoteWaitingView
        summary={{ kind: 'waiting', title: 'No desktop is publishing for demo yet', detail: '' }}
        user="demo"
        onSignOut={noop}
      />
    </Phone>
  ),
};

export const DesktopRefused: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <RemoteWaitingView
        summary={{
          kind: 'denied',
          title: 'Your desktop was refused',
          detail:
            'It tried to connect 2 min ago: sign-in expired — sign in again. In axn-term on the computer, open Remote and sign in again with this same account.',
        }}
        onSignOut={noop}
      />
    </Phone>
  ),
};

export const DesktopOffline: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <RemoteWaitingView
        summary={{
          kind: 'offline',
          title: 'Your desktop is offline',
          detail: 'It was connected before. Check that axn-term is running on the computer and has network.',
        }}
        onSignOut={noop}
      />
    </Phone>
  ),
};

export const HubUnreachable: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <RemoteWaitingView summary={null} error="Cannot reach the server's remote hub (Failed to fetch)." onSignOut={noop} />
    </Phone>
  ),
};

export const AppConnect: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <ConnectScreen
        onPaired={noop}
        native
        discover={async () => [
          { server: 'https://fedora.local:18092/gw', serverId: 'srv', desktopId: 'host-1', name: 'fedora' },
          { server: 'https://192.168.1.50:18092/gw', serverId: 'srv2', desktopId: 'host-2', name: 'studio-mac' },
        ]}
      />
    </Phone>
  ),
};

export const AppConnectNothingFound: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <ConnectScreen onPaired={noop} native discover={async () => []} />
    </Phone>
  ),
};

export const AppUnreachable: Story = {
  args: { children: null },
  render: () => (
    <Phone>
      <UnreachableScreen server={server} retrying={false} onRetry={noop} onChangeServer={noop} />
    </Phone>
  ),
};
