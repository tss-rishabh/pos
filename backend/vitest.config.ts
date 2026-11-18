import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These tools use node:test and run as explicit verifier prerequisites.
    // Keep Vitest's normal discovery everywhere else.
    exclude: [
      ...configDefaults.exclude,
      'tools/dependency-security/verify.test.mjs',
      'tools/verification/check.test.ts',
    ],
  },
});
