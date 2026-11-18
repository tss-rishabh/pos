import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  chromium,
  expect as browserExpect,
  type Browser,
  type BrowserContext,
} from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { z } from 'zod';
import {
  candidatePostalReply,
  countryReply,
  mappedPostal,
  readyMessage,
} from '../../../backend/tools/lookup-workflow/contracts.js';

const enabled = process.env.LOOKUP_WORKFLOW_BROWSER_TESTS === 'true';
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const backend = resolve(frontend, '../backend');
type Ready = z.infer<typeof readyMessage>;
function message(child: ChildProcess, kind: string, timeout = 45000): Promise<unknown> {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Lookup fixture IPC deadline.'));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('exit', exit);
    }
    function receive(value: unknown) {
      const envelope = z
        .object({
          kind: z.string(),
          code: z.string().optional(),
          errorKind: z.string().optional(),
          driverCode: z.string().nullable().optional(),
          location: z.string().nullable().optional(),
        })
        .safeParse(value);
      if (!envelope.success) return;
      if (envelope.data.kind === 'error') {
        cleanup();
        reject(
          new Error(
            [
              envelope.data.code ?? 'Lookup fixture failed.',
              envelope.data.errorKind,
              envelope.data.driverCode,
              envelope.data.location,
            ]
              .filter(Boolean)
              .join(' '),
          ),
        );
      } else if (envelope.data.kind === kind) {
        cleanup();
        accept(value);
      }
    }
    function exit() {
      cleanup();
      reject(new Error('Lookup fixture exited before its reply.'));
    }
    child.on('message', receive);
    child.on('exit', exit);
  });
}

describe.skipIf(!enabled)(
  'pinned Django → native rows → actual authenticated API → lookup UI',
  () => {
    let server: ViteDevServer,
      browser: Browser,
      child: ChildProcess,
      ready: Ready,
      origin: string,
      temporary: string;
    const observations = {
      countryUiComparisons: 0,
      roleTypeComparisons: 0,
      postalUiComparisons: 0,
      rejectedRequests: 0,
      interceptedResponses: 0,
      lookupRowsUnchanged: false,
    };
    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), 'pos-lookup-workflow-'));
      let apiOrigin = '';
      server = await createServer({
        root: frontend,
        configFile: false,
        cacheDir: join(temporary, 'vite'),
        plugins: [react()],
        appType: 'custom',
        server: {
          host: '127.0.0.1',
          port: 0,
          fs: { allow: [frontend, realpathSync(join(frontend, 'node_modules')), temporary] },
        },
      });
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0] ?? '';
        if (path.startsWith('/api/v1/')) {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
            const headers = new Headers();
            for (const [name, value] of Object.entries(request.headers)) {
              if (
                value !== undefined &&
                !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)
              )
                headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            const body = Buffer.concat(chunks);
            const upstream = await fetch(apiOrigin + request.url, {
              method: request.method,
              headers,
              ...(body.length ? { body } : {}),
              redirect: 'manual',
            });
            response.statusCode = upstream.status;
            for (const [name, value] of upstream.headers)
              if (
                !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(
                  name,
                )
              )
                response.setHeader(name, value);
            response.end(Buffer.from(await upstream.arrayBuffer()));
          } catch {
            response.statusCode = 502;
            response.end('Synthetic API transport failed.');
          }
          return;
        }
        if (path !== '/__lookups__') {
          next();
          return;
        }
        try {
          const html = await server.transformIndexHtml(
            '/__lookups__',
            '<!doctype html><html><body><div id="root"></div><script type="module" src="/tests/lookup-workflow/harness.tsx"></script></body></html>',
          );
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        } catch (error) {
          next(error);
        }
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Lookup UI did not bind.');
      origin = `http://127.0.0.1:${address.port}`;
      child = fork(join(backend, 'tools/lookup-workflow/server.ts'), [], {
        cwd: backend,
        execPath: process.execPath,
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', TZ: 'UTC' },
      });
      child.stdout?.resume();
      child.stderr?.resume();
      await message(child, 'awaiting-initialization');
      const response = message(child, 'ready');
      // No inherited provider/database/credential environment reaches the child.
      child.send({
        kind: 'initialize',
        database: process.env.LOOKUP_WORKFLOW_MYSQL_URL,
        webOrigin: origin,
        sourceRoot: process.env.LOOKUP_WORKFLOW_SOURCE_ROOT,
        python: process.env.LOOKUP_WORKFLOW_PYTHON,
      });
      ready = readyMessage.parse(await response);
      apiOrigin = ready.apiOrigin;
      browser = await chromium.launch({ headless: true });
    }, 60000);
    afterAll(async () => {
      try {
        await browser?.close();
        if (child?.connected) {
          const closing = message(child, 'closed', 15000);
          child.send({ kind: 'close' });
          const result = z.object({ lookupRowsUnchanged: z.boolean() }).parse(await closing);
          observations.lookupRowsUnchanged = result.lookupRowsUnchanged;
        }
      } finally {
        if (child?.exitCode === null)
          await new Promise<void>((done) => {
            const timer = setTimeout(() => {
              child.kill('SIGTERM');
              done();
            }, 2000);
            child.once('exit', () => {
              clearTimeout(timer);
              done();
            });
          });
        await server?.close();
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
      if (ready && process.env.LOOKUP_WORKFLOW_EVIDENCE) {
        const evidence = {
          scope: ['core/urls.py:31', 'core/urls.py:167'],
          sourceCommit: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
          sourceHashes: ready.source.sourceHashes,
          sourceNativeSelects: ready.source.nativeSelects,
          sourceNativeWrites: ready.source.nativeWrites,
          sourceAnonymousStatuses: ready.source.anonymous,
          nativeLookupRows: ready.nativeLookupRows,
          observations,
          runtime: {
            node: process.versions.node,
            python: ready.source.pythonVersion,
            django: ready.source.djangoVersion,
            mysql: ready.mysqlVersion,
          },
          realApplicationFactory: 'backend/src/app.ts:buildApp',
          authentication:
            'Native mysqlSessions credentials, signed cookies, actual registerAuth/identity/operator binding',
          transport:
            'Local byte-forwarding HTTP proxy; zero API response interception or replacement',
          entireStoreAdministrationCertified: false,
          passwordLoginCertified: false,
          productionReady: false,
        };
        await writeFile(
          process.env.LOOKUP_WORKFLOW_EVIDENCE,
          JSON.stringify(evidence, null, 2) + '\n',
          { mode: 0o600, flag: 'wx' },
        );
      }
    }, 20000);
    async function context(account = ready.accounts[0]!) {
      const value = await browser.newContext();
      await value.addCookies([
        {
          name: 'pos_session',
          value: account.cookie,
          url: origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
      return value;
    }
    async function post(
      current: BrowserContext,
      path: string,
      body: unknown,
      operator = ready.accounts[0]!.user.id,
    ) {
      return current.request.post(origin + path, {
        data: body,
        headers: { Origin: origin, 'X-Operator-ID': operator },
      });
    }
    it('renders every pinned native country search through the actual page and body-only POST route', async () => {
      const current = await context(),
        page = await current.newPage();
      const urls: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/v1/')) urls.push(request.url());
      });
      try {
        await page.goto(origin + '/__lookups__');
        await browserExpect(
          page.getByRole('heading', { name: 'Secondary country lookup' }),
        ).toBeVisible();
        for (const [index, search] of ready.searches.entries()) {
          if (search === null) continue;
          const response = page.waitForResponse((value) =>
            value.url().endsWith('/api/v1/countries/secondary/search'),
          );
          await page.getByLabel('Country name', { exact: true }).fill(search);
          await page.getByRole('button', { name: 'Search countries', exact: true }).click();
          const reply = await response;
          expect(reply.request().method()).toBe('POST');
          expect(reply.status()).toBe(200);
          expect(reply.headers()['cache-control']).toBe('private, no-store');
          expect(countryReply.parse((await reply.json()) as unknown)).toEqual(
            ready.source.countries[index],
          );
          const rows = ready.source.countries[index]!.data.country;
          if (rows?.length) {
            const rendered = page
              .getByRole('table', { name: 'Matching secondary countries' })
              .locator('tbody tr');
            await browserExpect(rendered).toHaveCount(rows.length);
            expect(
              await rendered.evaluateAll((items) =>
                items.map((row) =>
                  Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent),
                ),
              ),
            ).toEqual(rows.map((row) => [row.id, row.text]));
          } else if (rows)
            await browserExpect(
              page.getByText('No matching secondary countries.', { exact: true }),
            ).toBeVisible();
          else
            await browserExpect(
              page.getByText('Enter a country name to search.', { exact: true }),
            ).toBeVisible();
          observations.countryUiComparisons++;
        }
        expect(
          urls
            .filter((url) => url.includes('/countries/secondary/search'))
            .every((url) => new URL(url).search === ''),
        ).toBe(true);
      } finally {
        await current.close();
      }
    }, 30000);
    it('uses native current sessions for every valid role/user type and refuses unauthenticated, stale or malformed transport', async () => {
      for (const account of ready.accounts) {
        const current = await context(account);
        try {
          const country = await post(
            current,
            '/api/v1/countries/secondary/search',
            { search: 'INDIA' },
            account.user.id,
          );
          expect(country.status()).toBe(200);
          expect(countryReply.parse((await country.json()) as unknown)).toEqual(
            ready.source.countries[3],
          );
          const postal = await post(
            current,
            '/api/v1/locations/postal-code-lookups',
            { postalCode: '400001' },
            account.user.id,
          );
          expect(postal.status()).toBe(200);
          expect(candidatePostalReply.parse((await postal.json()) as unknown)).toEqual(
            mappedPostal(ready.source.postals[2]!),
          );
          observations.roleTypeComparisons++;
        } finally {
          await current.close();
        }
      }
      const current = await context(),
        anonymous = await browser.newContext();
      try {
        const cases = [
          [await post(anonymous, '/api/v1/countries/secondary/search', { search: 'India' }), 401],
          [
            await post(anonymous, '/api/v1/locations/postal-code-lookups', {
              postalCode: '400001',
            }),
            401,
          ],
          [await current.request.get(origin + '/api/v1/countries/secondary/search'), 404],
          [await current.request.get(origin + '/api/v1/locations/postal-code-lookups'), 404],
          [
            await post(current, '/api/v1/countries/secondary/search?q=India', { search: 'India' }),
            400,
          ],
          [
            await post(current, '/api/v1/countries/secondary/search', {
              search: 'India',
              unknown: true,
            }),
            400,
          ],
          [await post(current, '/api/v1/countries/secondary/search', { search: null }), 400],
          [await post(current, '/api/v1/countries/secondary/search', []), 400],
          [
            await post(current, '/api/v1/locations/postal-code-lookups', {
              postalCode: "400001' OR 1=1",
            }),
            400,
          ],
          [await post(current, '/api/v1/locations/postal-code-lookups', { postalCode: '' }), 400],
          [
            await post(current, '/api/v1/locations/postal-code-lookups?postalCode=400001', {
              postalCode: '400001',
            }),
            400,
          ],
          [
            await post(
              current,
              '/api/v1/countries/secondary/search',
              { search: 'India' },
              '900999',
            ),
            409,
          ],
          [
            await current.request.post(origin + '/api/v1/countries/secondary/search', {
              data: { search: 'India' },
              headers: {
                Origin: 'http://127.0.0.1:1',
                'X-Operator-ID': ready.accounts[0]!.user.id,
              },
            }),
            403,
          ],
        ] as const;
        for (const [response, status] of cases) {
          expect(response.status()).toBe(status);
          observations.rejectedRequests++;
        }
        const missing = await post(current, '/api/v1/countries/secondary/search', {});
        expect(countryReply.parse((await missing.json()) as unknown)).toEqual(
          ready.source.countries[0],
        );
      } finally {
        await current.close();
        await anonymous.close();
      }
    }, 30000);
    it('autofills the actual store editor from the first native source postal row while preserving existing references', async () => {
      const current = await context(),
        page = await current.newPage();
      const urls: string[] = [],
        messages: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/api/v1/')) urls.push(request.url());
      });
      page.on('console', (message) => messages.push(message.text()));
      try {
        await page.goto(origin + '/__lookups__?view=postal');
        await page.getByRole('button', { name: 'Create store', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Address', { exact: true }).fill('Preserved synthetic address');
        await dialog.getByLabel('City reference', { exact: true }).fill('7');
        for (const postal of ['999999', '400001']) {
          const response = page.waitForResponse((value) =>
            value.url().endsWith('/api/v1/locations/postal-code-lookups'),
          );
          await dialog.getByLabel('PIN code', { exact: true }).fill(postal);
          await dialog.getByRole('button', { name: 'Look up PIN code', exact: true }).click();
          const reply = await response;
          expect(reply.request().method()).toBe('POST');
          expect(reply.status()).toBe(200);
          const body = candidatePostalReply.parse((await reply.json()) as unknown);
          const expected = mappedPostal(ready.source.postals[postal === '400001' ? 2 : 3]!);
          expect(body).toEqual(expected);
          if (expected.data === null) {
            await browserExpect(dialog.getByRole('alert')).toContainText('No location was found');
          } else {
            const source = expected.data;
            for (const [label, value] of [
              ['City', source.city],
              ['State', source.state],
              ['Country', source.countryId],
              ['State reference', source.stateId],
              ['Latitude', source.latitude],
              ['Longitude', source.longitude],
            ] as const)
              await browserExpect(dialog.getByLabel(label, { exact: true })).toHaveValue(value);
          }
          await browserExpect(dialog.getByLabel('City reference', { exact: true })).toHaveValue(
            '7',
          );
          await browserExpect(dialog.getByLabel('Address', { exact: true })).toHaveValue(
            'Preserved synthetic address',
          );
          observations.postalUiComparisons++;
        }
        expect(urls.join('\n')).not.toMatch(/400001|999999|Preserved/);
        expect(messages.join('\n')).not.toMatch(/400001|999999|Preserved/);
      } finally {
        await current.close();
      }
    }, 30000);
    it('rechecks writer-current operator revocation and leaves every native lookup row unchanged', async () => {
      const account = ready.accounts[0]!,
        current = await context(account);
      try {
        const disabled = message(child, 'disabled');
        child.send({ kind: 'disable', operatorId: account.user.id });
        await disabled;
        for (const [path, body] of [
          ['/api/v1/countries/secondary/search', { search: 'India' }],
          ['/api/v1/locations/postal-code-lookups', { postalCode: '400001' }],
        ] as const) {
          expect((await post(current, path, body)).status()).toBe(401);
          observations.rejectedRequests++;
        }
        const reply = message(child, 'fingerprint');
        child.send({ kind: 'fingerprint' });
        expect(
          z.object({ lookupRowsUnchanged: z.boolean() }).parse(await reply).lookupRowsUnchanged,
        ).toBe(true);
      } finally {
        await current.close();
      }
    });
  },
);
