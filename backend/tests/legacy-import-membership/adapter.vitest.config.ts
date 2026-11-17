import { defineConfig } from 'vitest/config';
export default defineConfig({
  cacheDir: 'tests/legacy-import-membership/.cache/adapter',
  test: {
    include: [
      'tests/legacy-import-membership/completion.test.ts',
      'tests/legacy-import-membership/adapter.mysql.test.ts',
      'tests/legacy-import-membership/domain.test.ts',
      'tests/legacy-import-membership/core.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
