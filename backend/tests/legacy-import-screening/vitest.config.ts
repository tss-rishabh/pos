import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: 'tests/legacy-import-screening/.cache/vite',
  test: {
    include: ['tests/legacy-import-screening/**/*.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
