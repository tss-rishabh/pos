import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { z } from 'zod';

describe.skipIf(process.env.ADMINISTRATION_BROWSER_TESTS !== 'true')(
  'selected GroupAdmin deletion in Chromium',
  () => {
    let server: ViteDevServer, browser: Browser, origin: string;
    beforeAll(async () => {
      server = await createServer({
        configFile: false,
        cacheDir: 'node_modules/.vite-administration-group-bulk-tests',
        plugins: [react()],
        appType: 'custom',
        server: { host: '127.0.0.1', port: 0 },
      });
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__administration-test__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__administration-test__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/administration/browser-harness.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html');
          response.setHeader(
            'Content-Security-Policy',
            `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${origin.replace('http:', 'ws:')}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'`,
          );
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string')
        throw new Error('Local group fixture failed to bind.');
      origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
    }, 20000);
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });
    async function fixture(page: Page) {
      page.setDefaultTimeout(5000);
      const state = {
        groups: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'First fixture group',
            version: 'a'.repeat(64),
            memberCount: '2',
            permissionCount: 1,
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Second fixture group',
            version: 'b'.repeat(64),
            memberCount: '1',
            permissionCount: 2,
          },
        ],
        dropAfterCommit: false,
        conflictOnce: false,
        previews: [] as unknown[],
        mutations: [] as {
          operationId: string;
          groups: { id: string; expectedVersion: string }[];
        }[],
        headers: [] as string[],
        receipts: new Map<
          string,
          { id: string; status: 'success'; message: string; reauthenticate: boolean }
        >(),
      };
      await page.route('**/api/v1/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        state.headers.push(request.headers()['x-operator-id'] || '');
        if (url.search || request.headers()['x-operator-id'] !== '1') {
          await route.fulfill({
            status: 403,
            json: { error: { code: 'ACTOR_CHANGED', message: 'The signed-in operator changed.' } },
          });
          return;
        }
        if (url.pathname === '/api/v1/admin/access/capabilities') {
          await route.fulfill({
            json: {
              reconciled: true,
              canManage: true,
              staff: true,
              superuser: true,
              internal: true,
              canViewGroups: true,
              canViewOperators: true,
            },
          });
          return;
        }
        if (url.pathname === '/api/v1/admin/access/groups/search') {
          const body = z.object({ search: z.string() }).parse(request.postDataJSON() as unknown);
          await route.fulfill({
            json: {
              data: state.groups
                .filter((group) => group.name.toLowerCase().includes(body.search.toLowerCase()))
                .map(({ id, name }) => ({ id, name })),
              nextCursor: null,
            },
          });
          return;
        }
        if (url.pathname === '/api/v1/admin/access/group-deletion-previews') {
          const input = z
            .object({ groupIds: z.array(z.uuid()) })
            .parse(request.postDataJSON() as unknown);
          state.previews.push(input);
          const groups = state.groups.filter((group) => input.groupIds.includes(group.id));
          if (groups.length !== input.groupIds.length) {
            await route.fulfill({
              status: 404,
              json: {
                error: {
                  code: 'ADMIN_GROUP_NOT_FOUND',
                  message: 'One or more selected groups no longer exist.',
                },
              },
            });
            return;
          }
          await route.fulfill({
            json: {
              groups,
              membershipCount: groups.reduce(
                (count, group) => count + Number(group.memberCount),
                0,
              ),
              permissionAssignmentCount: groups.reduce(
                (count, group) => count + group.permissionCount,
                0,
              ),
              operatorAccountsDeleted: 0,
            },
          });
          return;
        }
        if (url.pathname === '/api/v1/admin/access/group-deletions') {
          const input = z
            .object({
              operationId: z.uuid(),
              groups: z.array(z.object({ id: z.uuid(), expectedVersion: z.string() })),
            })
            .parse(request.postDataJSON() as unknown);
          state.mutations.push(input);
          const previous = state.receipts.get(input.operationId);
          if (previous) {
            await route.fulfill({ json: previous });
            return;
          }
          if (state.conflictOnce) {
            state.conflictOnce = false;
            state.groups[0]!.version = 'c'.repeat(64);
            await route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'ADMIN_ACCESS_CHANGED',
                  message: 'Access changed. Reload the deletion preview before confirming again.',
                },
              },
            });
            return;
          }
          if (
            input.groups.some(
              (expected) =>
                state.groups.find((group) => group.id === expected.id)?.version !==
                expected.expectedVersion,
            )
          ) {
            await route.fulfill({
              status: 409,
              json: {
                error: {
                  code: 'ADMIN_ACCESS_CHANGED',
                  message: 'Access changed. Reload the deletion preview before confirming again.',
                },
              },
            });
            return;
          }
          const result = {
            id: input.operationId,
            status: 'success' as const,
            message: 'Selected groups deleted.',
            reauthenticate: false,
          };
          state.groups = state.groups.filter(
            (group) => !input.groups.some((selected) => selected.id === group.id),
          );
          state.receipts.set(input.operationId, result);
          if (state.dropAfterCommit) {
            state.dropAfterCommit = false;
            await route.abort('failed');
            return;
          }
          await route.fulfill({ json: result });
          return;
        }
        await route.fulfill({
          status: 404,
          json: { error: { code: 'FIXTURE_NOT_FOUND', message: 'Fixture route not found.' } },
        });
      });
      await page.goto(origin + '/__administration-test__?screen=group-access');
      await browserExpect(
        page.getByRole('checkbox', { name: 'Select group First fixture group', exact: true }),
      ).toBeVisible();
      return state;
    }
    it('confirms hidden selections and safely retries a lost committed response with the same operation', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.dropAfterCommit = true;
        await page
          .getByRole('checkbox', { name: 'Select group First fixture group', exact: true })
          .check();
        await page
          .getByRole('checkbox', { name: 'Select group Second fixture group', exact: true })
          .check();
        await page.getByLabel('Find administration group', { exact: true }).fill('Second');
        await browserExpect(
          page.getByRole('checkbox', { name: 'Select group First fixture group', exact: true }),
        ).toHaveCount(0);
        await page.getByRole('button', { name: 'Delete selected groups (2)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Delete selected administration groups' });
        await browserExpect(
          dialog.getByText('First fixture group: 2 memberships, 1 permissions.', { exact: true }),
        ).toBeVisible();
        await browserExpect(dialog).toContainText(
          'Operator accounts and financial identities are retained.',
        );
        await dialog.getByRole('button', { name: 'Delete selected groups', exact: true }).click();
        await browserExpect(dialog.getByRole('alert')).toBeVisible();
        await dialog.getByRole('button', { name: 'Delete selected groups', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.mutations).toHaveLength(2);
        expect(state.mutations[0]).toEqual(state.mutations[1]);
        expect(state.receipts.size).toBe(1);
        expect(state.groups).toEqual([]);
        expect(state.headers.every((actor) => actor === '1')).toBe(true);
        await browserExpect(
          page.getByRole('button', { name: 'Delete selected groups (0)', exact: true }),
        ).toBeDisabled();
      } finally {
        await page.close();
      }
    }, 15000);
    it('requires a refreshed confirmation after scope changes and binds a new operation to the new version', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        state.conflictOnce = true;
        await page
          .getByRole('checkbox', { name: 'Select group First fixture group', exact: true })
          .check();
        await page.getByRole('button', { name: 'Delete selected groups (1)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Delete selected administration groups' });
        await browserExpect(
          dialog.getByRole('button', { name: 'Delete selected groups', exact: true }),
        ).toBeVisible();
        await dialog.getByRole('button', { name: 'Delete selected groups', exact: true }).click();
        await browserExpect(dialog.getByRole('alert')).toContainText('Access changed.');
        expect(state.receipts.size).toBe(0);
        expect(state.groups).toHaveLength(2);
        await dialog.getByRole('button', { name: 'Reload deletion preview', exact: true }).click();
        await browserExpect.poll(() => state.previews.length).toBeGreaterThanOrEqual(2);
        await browserExpect(
          dialog.getByRole('button', { name: 'Delete selected groups', exact: true }),
        ).toBeVisible();
        await dialog.getByRole('button', { name: 'Delete selected groups', exact: true }).click();
        await browserExpect(dialog).toHaveCount(0);
        expect(state.mutations).toHaveLength(2);
        expect(state.mutations[0]!.operationId).not.toBe(state.mutations[1]!.operationId);
        expect(state.mutations[1]!.groups[0]!.expectedVersion).toBe('c'.repeat(64));
        expect(state.groups.map((group) => group.name)).toEqual(['Second fixture group']);
      } finally {
        await page.close();
      }
    }, 15000);
    it('prevents an old actor from submitting a loaded bulk confirmation', async () => {
      const page = await browser.newPage();
      try {
        const state = await fixture(page);
        await page
          .getByRole('checkbox', { name: 'Select group First fixture group', exact: true })
          .check();
        await page.getByRole('button', { name: 'Delete selected groups (1)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Delete selected administration groups' });
        await browserExpect(
          dialog.getByRole('button', { name: 'Delete selected groups', exact: true }),
        ).toBeVisible();
        await page.evaluate(
          "import('/src/api/client.ts').then(({setRequestOperator})=>setRequestOperator('2'))",
        );
        await dialog.getByRole('button', { name: 'Delete selected groups', exact: true }).click();
        await browserExpect(dialog.getByRole('alert')).toBeVisible();
        expect(state.mutations).toEqual([]);
        expect(state.groups).toHaveLength(2);
      } finally {
        await page.close();
      }
    }, 15000);
  },
);
