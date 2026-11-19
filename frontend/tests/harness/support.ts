import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type Response } from '@playwright/test';
import { z } from 'zod';
import { signIn } from '../../e2e/support/login';

export const harnessOperatorId = '900001';
const backend = fileURLToPath(new URL('../../../backend/', import.meta.url));

/** The verifier's loopback E2E server, with a schema owned by the harness stack only. */
export function harnessDatabaseUrl() {
  const raw = process.env.E2E_MYSQL_URL ?? '';
  if (!raw) throw new Error('Set E2E_MYSQL_URL to an isolated loopback MySQL server.');
  const url = new URL(raw);
  if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Error('The harness stack only runs against a loopback MySQL server.');
  url.pathname = '/pos_rewrite_e2e_harness';
  return url.href;
}

const manifest = z.object({
  set: z.enum(['orders', 'reports']),
  today: z.iso.date().optional(),
  orders: z.array(
    z.object({
      id: z.string().regex(/^\d+$/),
      reference: z.string(),
      amount: z.number(),
      created: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      stores: z.array(z.string()),
    }),
  ),
});
export type HarnessManifest = z.infer<typeof manifest>;

/** Writes the harness rows through backend/tools/e2e/harness-fixtures.ts (ORM, synthetic only). */
export function applyFixtures(set: 'orders' | 'reports'): HarnessManifest {
  const output = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'tools/e2e/harness-fixtures.ts', set],
    {
      cwd: backend,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        E2E_MYSQL_URL: harnessDatabaseUrl(),
      },
    },
  );
  return manifest.parse(JSON.parse(output.trim().split('\n').at(-1) ?? '') as unknown);
}

/**
 * Real sign-in through the login page. The production rollout (COCO) can raise the day-close
 * reminder over any page in its nag windows; an operator answers "Not now" exactly as at a counter.
 */
export async function enter(page: Page, path: string) {
  await page.addLocatorHandler(
    page.getByRole('heading', { name: /^Day close (pending|needs redoing)$/ }),
    async () => {
      await page.getByRole('button', { name: 'Not now', exact: true }).click();
    },
  );
  await page.goto(path);
  await signIn(page);
}

export const isSearch = (response: Response) =>
  response.request().method() === 'POST' &&
  new URL(response.url()).pathname === '/api/v1/stores/1/orders/searches';

/** Collects page errors so every harness ends with an uncaught-exception check. */
export function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return {
    assertNone: () => expect(errors).toEqual([]),
  };
}
