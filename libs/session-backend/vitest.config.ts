import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// RAMPHASTOS_LOCAL_DEPS=1 → resolve ramphastos-client from the sibling
// checkout (../ramphastos next to axn-term) instead of the published npm
// package — same switch as the .NET ProjectReferences and vite configs.
const ramphastosLocalDeps: Record<string, string> = process.env
  .RAMPHASTOS_LOCAL_DEPS
  ? {
      'ramphastos-client': fileURLToPath(
        new URL(
          '../../../ramphastos/src/client/ramphastos-client',
          import.meta.url,
        ),
      ),
    }
  : {};

export default defineConfig({
  resolve: { alias: ramphastosLocalDeps },
});
