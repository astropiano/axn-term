import type { Meta, StoryObj } from '@storybook/react-vite';
import { dump } from 'js-yaml';
import type { KnownServer, RemoteConsoleSnapshot } from '@axn-term/session-backend';
import type { RemoteStatus } from '@axn-term/session-backend/remote';
import { registerShellPlatform, type ShellPlatform } from '../../platform';
import { ShellPlatformProvider } from '../../services';
import { SettingsProvider } from '../../SettingsProvider';
import type { AppSettings } from '../../themes';
import { remoteLinkPlugin } from './remoteLink';

/**
 * The desktop's Remote panel through its setup states — what a user sees
 * from "nothing configured" to "publishing, scan this with your phone",
 * and the refused state with the server's reason.
 */

const server: KnownServer = {
  id: '0ec41de6a5964511a6108ef10d204c36',
  name: 'fedora.local',
  url: 'https://192.168.1.41:18092',
  endpoints: [
    { label: 'public', gateway: 'https://192.168.1.41:18092/gw', issuer: 'https://192.168.1.41:18092/auth/realms/axn-term' },
    { label: 'lan', gateway: 'https://fedora.local:18092/gw', issuer: 'https://fedora.local:18092/auth/realms/axn-term' },
  ],
  clients: { web: 'axn-term', desktop: 'axn-term-desktop', mobile: 'axn-term-mobile' },
  features: { remote: true, cloud: false },
  lastGateway: 'https://192.168.1.41:18092/gw',
};

const connected: Partial<AppSettings> = {
  remoteEnabled: true,
  remoteServer: server,
  remoteAuthorityUrl: 'wss://192.168.1.41:18092/gw/remote',
  remoteAuthIssuer: 'https://192.168.1.41:18092/auth/realms/axn-term',
  remoteAuthClientId: 'axn-term-desktop',
};

type Auth = ReturnType<NonNullable<ShellPlatform['remoteAuth']>['get']>;
type Publish = { state: 'idle' | 'connecting' | 'connected' | 'failed'; error?: string };

function hostSnapshot(publishing: boolean): RemoteConsoleSnapshot {
  return {
    role: 'authority',
    state: publishing ? 'ready' : 'idle',
    hostName: 'fedora',
    hostDevice: 'desktop',
    ptys: publishing ? [{ id: 'local-1', name: 'zsh' }] : [],
    claims: {},
    viewers: publishing ? { 'phone-1': { name: 'Pixel', platform: 'android' } } : {},
  };
}

function platform(opts: { auth: Auth; publish: Publish; status?: RemoteStatus }): ShellPlatform {
  const snapshot = hostSnapshot(opts.publish.state === 'connected');
  return {
    remoteConsole: { get: () => snapshot, subscribe: () => () => {} },
    remoteAuth: {
      get: () => opts.auth,
      subscribe: () => () => {},
      signIn: async () => {},
      signOut: async () => {},
    },
    remoteAuthorityStatus: { get: () => opts.publish, subscribe: () => () => {} },
    remoteServer: {
      connect: async () => connected,
      pairingLink: (s: KnownServer) =>
        `axnterm://connect?server=${encodeURIComponent(s.lastGateway ?? s.url)}&sid=${s.id}&name=${s.name}`,
      status: async () =>
        opts.status ?? { account: { sub: 's', user: 'demo' }, sessions: [], attempts: [] },
    },
  } as unknown as ShellPlatform;
}

function Panel({ settings, ...opts }: { settings: Partial<AppSettings> } & Parameters<typeof platform>[0]) {
  const p = platform(opts);
  registerShellPlatform(p);
  const yaml = dump(settings);
  const store = { load: async () => yaml, save: async () => {} };
  return (
    <div className="h-[640px] w-[420px] overflow-hidden rounded border border-[var(--border)]">
      <ShellPlatformProvider platform={p}>
        <SettingsProvider configStore={store}>{remoteLinkPlugin.renderView?.({} as never)}</SettingsProvider>
      </ShellPlatformProvider>
    </div>
  );
}

const meta = { title: 'app/RemotePanel', component: Panel } satisfies Meta<typeof Panel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NotConnected: Story = {
  args: { settings: { remoteEnabled: true }, auth: { state: 'signedOut' }, publish: { state: 'idle' } },
};

export const SignedOut: Story = {
  args: {
    settings: connected,
    auth: { state: 'signedOut' },
    publish: { state: 'idle', error: 'Sign in to publish this desktop' },
  },
};

export const SigningIn: Story = {
  args: {
    settings: connected,
    auth: {
      state: 'pending',
      userCode: 'WXYZ-ABCD',
      verificationUri: 'https://192.168.1.41:18092/auth/realms/axn-term/device',
    },
    publish: { state: 'idle', error: 'Sign in to publish this desktop' },
  },
};

export const Publishing: Story = {
  args: { settings: connected, auth: { state: 'signedIn', user: 'demo' }, publish: { state: 'connected' } },
};

export const Refused: Story = {
  args: {
    settings: connected,
    auth: { state: 'signedIn', user: 'demo' },
    publish: { state: 'failed', error: 'hello denied' },
    status: {
      account: { sub: 's', user: 'demo' },
      sessions: [],
      attempts: [
        {
          at: new Date().toISOString(),
          role: 'Authority',
          accepted: false,
          reason: 'signed in at https://fedora.local:18093/realms/axn-term, which this server does not accept',
        },
      ],
    },
  },
};
