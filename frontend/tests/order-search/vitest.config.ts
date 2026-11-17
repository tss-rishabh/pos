import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  cacheDir: fileURLToPath(new URL('./.cache/vitest', import.meta.url)),
  test: { include: ['tests/order-search/*.test.ts'] },
});
