import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: 'tests/legacy-import-screening/.cache/financial-regression',
  test: {
    include: [
      'tests/legacy-import-financial/**/*.test.ts',
      'tests/legacy-order-imports/runtime-options.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
