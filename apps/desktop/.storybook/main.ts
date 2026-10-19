import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

const mock = (name: string) => fileURLToPath(new URL(`./mocks/${name}`, import.meta.url));

// Tauri APIs don't exist in a plain browser — alias them to stubs so app
// components can render in Storybook.
const tauriAliases: Record<string, string> = {
  '@tauri-apps/api/core': mock('tauri-core.ts'),
  '@tauri-apps/api/event': mock('tauri-event.ts'),
};

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)', '../../../libs/shell-ui/src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: '@storybook/react-vite',
  viteFinal: (config) => {
    config.resolve ??= {};
    const alias = config.resolve.alias;
    if (Array.isArray(alias)) {
      for (const [find, replacement] of Object.entries(tauriAliases)) {
        alias.push({ find, replacement });
      }
    } else {
      config.resolve.alias = { ...(alias ?? {}), ...tauriAliases };
    }
    // Behind the scenario's port mapping the container-internal port is
    // unreachable; the HMR websocket must dial the published host port.
    const clientPort = process.env.SCENARIO_PORT
      ? Number(process.env.SCENARIO_PORT)
      : undefined;
    if (clientPort) {
      config.server ??= {};
      config.server.hmr = {
        ...(typeof config.server.hmr === 'object' ? config.server.hmr : {}),
        clientPort,
      };
    }
    return config;
  },
};

export default config;
