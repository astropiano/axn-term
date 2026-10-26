import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import monacoEditorPlugin from "vite-plugin-monaco-editor-esm";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// Allow the Docker builder to keep the Vite dep-optimization cache on a
// persistent volume instead of inside the ephemeral build directory.
// @ts-expect-error process is a nodejs global
const cacheDir = process.env.VITE_CACHE_DIR;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    monacoEditorPlugin({
      // Workers are prebuilt with esbuild instead of going through the Rollup
      // pipeline; keep this in sync with the feature languages in
      // src/app/monaco.main.ts.
      languageWorkers: ["editorWorkerService", "typescript", "json", "css", "html"],
    }),
    react({
      babel: {
        // Lingui message macros (`t`/`Trans` from `@lingui/*/macro`).
        plugins: ['@lingui/babel-plugin-lingui-macro'],
      },
    }),
  ],
  resolve: {
    alias: {
      // Shared workspace libs — source-consumed (same scheme as tsconfig paths).
      // Subpath aliases must come first: object-alias entries are tried in
      // order and the bare package name would otherwise swallow them.
      "@axn-term/session-backend/tauri": fileURLToPath(
        new URL("../../libs/session-backend/src/tauri.ts", import.meta.url),
      ),
      "@axn-term/session-backend/remote": fileURLToPath(
        new URL("../../libs/session-backend/src/remote.ts", import.meta.url),
      ),
      "@axn-term/session-backend": fileURLToPath(
        new URL("../../libs/session-backend/src/index.ts", import.meta.url),
      ),
      "@axn-term/shell-ui": fileURLToPath(
        new URL("../../libs/shell-ui/src/index.ts", import.meta.url),
      ),
      "@axn-term/plugin-sdk": fileURLToPath(
        new URL("../../libs/plugin-sdk/src/index.ts", import.meta.url),
      ),
      // Sibling checkout (dev/libraries/ramphastos); containers mount
      // the same tree at /libraries — the relative depth resolves there.
      "@ramphastos/ramphastos-client": fileURLToPath(
        new URL(
          "../../../ramphastos/src/client/ramphastos-client",
          import.meta.url,
        ),
      ),
      // monaco-editor's exports map blocks deep `esm/` imports; resolve them
      // straight to the filesystem so src/app/monaco.main.ts can pick a
      // trimmed language set.
      "monaco-editor/esm": fileURLToPath(
        new URL("./node_modules/monaco-editor/esm", import.meta.url),
      ),
    },
  },
  cacheDir: cacheDir || undefined,

  test: {
    setupFiles: ["./vitest.setup.ts"],
    // No app-level tests yet (the UI is covered by libs/shell-ui); keep
    // `nx run-many -t test` green instead of failing on an empty run.
    passWithNoTests: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
