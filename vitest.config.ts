import { defineConfig } from 'vitest/config';

// Root-level `npx vitest` should behave like `nx run-many -t test`:
// delegate to each package's own config so transforms (e.g. the Lingui
// message-macro babel plugin in libs/shell-ui) actually apply. Without
// this, root runs load the raw @lingui/*/macro stubs and every `t` call
// throws "executed outside the context of compilation".
export default defineConfig({
  test: {
    projects: ['libs/*/vitest.config.ts', 'apps/*/vitest.config.ts'],
  },
});
