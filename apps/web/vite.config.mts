/// <reference types='vitest' />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import monacoEditorPlugin from 'vite-plugin-monaco-editor-esm';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

export default defineConfig(() => {
  const proxyTarget = process.env.VITE_AXN_BACKEND_URL
    ?? `http://localhost:${process.env.AXN_BACKEND_PORT ?? '8083'}`;

  return ({
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/apps/web',
    server: {
      port: Number(process.env.VITE_PORT ?? 5175),
      host: 'localhost',
      // LAN scenarios front this dev server through a reverse proxy whose
      // Host header carries the deployment domain (e.g.
      // axn-term.192.168.x.x.nip.io); vite's DNS-rebinding check 403s it.
      // ".domain" covers the service subdomains (axn-term-*, …);
      // AXN_LAN_IP allows raw-IP access (https://<ip>:<port>), AXN_LAN_NAME
      // the mDNS <host>.local name.
      allowedHosts: (() => {
        const hosts = [
          ...(process.env.AXN_DOMAIN ? [`.${process.env.AXN_DOMAIN}`] : []),
          ...(process.env.AXN_LAN_IP ? [process.env.AXN_LAN_IP] : []),
          ...(process.env.AXN_LAN_NAME ? [process.env.AXN_LAN_NAME] : []),
          // mDNS (<host>.local) — dev server only fronts LAN scenarios.
          '.local',
        ];
        return hosts.length ? hosts : undefined;
      })(),
      fs: {
        allow: [
          '../..',
          // Sibling-repo ramphastos-client sources (sibling checkout next to axn-term).
          fileURLToPath(new URL('../../../ramphastos', import.meta.url)),
        ],
      },
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port: Number(process.env.VITE_PORT ?? 5175),
      host: 'localhost',
    },
    plugins: [
      // Workers are prebuilt with esbuild instead of going through the Rollup
      // pipeline; keep this in sync with the feature languages in
      // libs/shell-ui/src/app/monaco.main.ts. The plugin resolves entries
      // against <cwd>/node_modules, which misses the per-package
      // apps/web/node_modules — hand it absolute paths instead.
      monacoEditorPlugin({
        languageWorkers: [],
        customWorkers: [
          'vs/editor/editor.worker.js',
          'vs/language/typescript/ts.worker.js',
          'vs/language/json/json.worker.js',
          'vs/language/css/css.worker.js',
          'vs/language/html/html.worker.js',
        ].map((p) => ({
          label: p.includes('editor.worker')
            ? 'editorWorkerService'
            : p.split('/')[2],
          entry: fileURLToPath(
            new URL(`./node_modules/monaco-editor/esm/${p}`, import.meta.url),
          ),
        })),
      }),
      react({
        babel: {
          // Lingui message macros (`t`/`Trans` from `@lingui/*/macro`).
          plugins: ['@lingui/babel-plugin-lingui-macro'],
        },
      }),
      tailwindcss(),
      nxViteTsPaths(),
      nxCopyAssetsPlugin(['*.md']),
    ],
    resolve: {
      alias: {
        // monaco-editor's exports map blocks deep `esm/` imports; resolve them
        // straight to the filesystem so monaco.main.ts can pick a trimmed
        // language set.
        'monaco-editor/esm': fileURLToPath(
          new URL('./node_modules/monaco-editor/esm', import.meta.url),
        ),
      },
    },
    build: {
      outDir: '../../dist/apps/web',
      emptyOutDir: true,
      reportCompressedSize: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    test: {
      name: 'shell',
      watch: false,
      // No app-level tests yet (the UI is covered by libs/shell-ui); keep
      // `nx run-many -t test` green instead of failing on an empty run.
      // The default node environment is used because jsdom is not a
      // dependency — add happy-dom (as libs/shell-ui does) with the first
      // DOM test.
      passWithNoTests: true,
      globals: true,
      include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
      reporters: ['default'],
      coverage: {
        reportsDirectory: '../../coverage/apps/web',
        provider: 'v8' as const,
      },
    },
  });
});
