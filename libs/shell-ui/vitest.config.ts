import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Matches the apps' vite config — compiles Lingui message macros.
    react({
      babel: { plugins: ['@lingui/babel-plugin-lingui-macro'] },
    }),
  ],
  resolve: {
    alias: {
      // Workspace libs are consumed as TS source — mirror the apps' vite
      // aliases so value imports resolve under vitest too.
      '@axn-term/plugin-sdk': fileURLToPath(
        new URL('../plugin-sdk/src/index.ts', import.meta.url),
      ),
      '@axn-term/session-backend': fileURLToPath(
        new URL('../session-backend/src/index.ts', import.meta.url),
      ),
    },
  },
});
