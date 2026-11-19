import { defineConfig } from '@playwright/test';

if (process.versions.node.split('.')[0] !== '24')
  throw new Error('Playwright fixtures require the installed Node 24 runtime.');

/**
 * W26: the macOS desktop app (real Electron, dev build) against the UAT environment. The stack is
 * started separately and stays up across specs (`backend/tools/uat-e2e/uat-stack.ts`, see its
 * header): it runs the real backend + worker on UAT MySQL/Redis/API-v2 behind the egress guards.
 * Credentials are read at run time from ~/.config/pos-uat/uat.env and are never printed.
 * Real UAT data: specs never seed, never clean up and record every write they cause.
 */
export default defineConfig({
  testDir: 'e2e-uat',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300000,
  expect: { timeout: 30000 },
  outputDir: '../.tmp/w26/pw-results',
  reporter: [['list'], ['json', { outputFile: '../.tmp/w26/pw-report.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
