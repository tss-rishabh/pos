import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('../../../backend', import.meta.url)),
  test: {
    include: [fileURLToPath(new URL('./native-workflow.test.ts', import.meta.url))],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
