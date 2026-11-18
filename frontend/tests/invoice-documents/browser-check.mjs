// Controlled UI/transport fixtures; native/source authorization has separate tests.
import { chromium, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
const base = new URL(process.env.POS_INVOICE_BROWSER_BASE_URL || 'http://127.0.0.1:4496');
if (!['127.0.0.1', 'localhost'].includes(base.hostname))
  throw new Error('LOOPBACK_INVOICE_FIXTURE_REQUIRED');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'darwin' && existsSync(chrome) ? chrome : undefined);
const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  }),
  checks = [],
  requests = [],
  unexpected = [],
  pageErrors = [];
try {
  async function fixture({
    mismatch = false,
    hold = false,
    available = true,
    global = false,
  } = {}) {
    const context = await browser.newContext({ serviceWorkers: 'block' }),
      page = await context.newPage();
    let deny = false,
      resolveHold;
    const gate = new Promise((resolve) => {
      resolveHold = resolve;
    });
    page.on('pageerror', (error) => pageErrors.push(error.name));
    await context.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        path = url.pathname;
      requests.push({ method: request.method(), path });
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      const capability = /^\/api\/v1\/stores\/(\d+)\/orders\/(\d+)\/invoices\/capabilities$/.exec(
        path,
      );
      if (capability) {
        expect(request.method()).toBe('GET');
        expect(['44', '55']).toContain(request.headers()['x-operator-id']);
        if (hold && capability[2] === '12346' && request.headers()['x-operator-id'] === '44') {
          await gate;
          try {
            return await json({
              storeId: '1',
              orderId: '12346',
              actions: [{ kind: 'express', available: true }],
            });
          } catch {
            return;
          }
        }
        return json({
          ...(url.searchParams.get('access') === 'global-online'
            ? { access: 'global-online' }
            : {}),
          storeId: capability[1],
          orderId: mismatch ? '999' : capability[2],
          actions: [
            { kind: 'online', available: true },
            { kind: 'same-day', available: true },
            ...(url.searchParams.has('access') ? [] : [{ kind: 'express', available }]),
          ],
        });
      }
      const preview =
        /^\/api\/v1\/operators\/(\d+)\/stores\/(\d+)\/orders\/(\d+)\/invoices\/(online|same-day|express)\/preview$/.exec(
          path,
        );
      if (preview) {
        expect(request.method()).toBe('GET');
        expect([...url.searchParams]).toEqual(global ? [['access', 'global-online']] : []);
        if (deny) {
          deny = false;
          return json(
            { error: { code: 'STORE_ACCESS_DENIED', message: 'Invoice access changed.' } },
            403,
          );
        }
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          headers: {
            'Cache-Control': 'no-store',
            'Content-Security-Policy':
              "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-same-origin allow-modals",
          },
          body: `<!doctype html><html><head><meta name="pos-invoice" content="sanitized"><meta name="pos-invoice-scope" content="${preview[1]}:${preview[2]}:${preview[3]}:${preview[4]}${global ? ':global-online' : ''}"><meta name="pos-invoice-number" content="FIXTURE/INV/1"><style>body{font-size:12px}</style></head><body><h1>Selected fixture invoice</h1><p>STORE1_SELECTED</p></body></html>`,
        });
      }
      const document =
        /^\/api\/v1\/stores\/(\d+)\/orders\/(\d+)\/invoices\/(online|same-day)$/.exec(path);
      if (document && global) {
        expect([...url.searchParams]).toEqual([['access', 'global-online']]);
        return json({
          access: 'global-online',
          kind: document[3],
          storeId: document[1],
          orderId: document[2],
          number: null,
          filename: `${document[3]}-tax-invoice-${document[2]}.html`,
          html: '<html><head><meta name="pos-invoice" content="sanitized"></head><body>GLOBAL_CONTEXT_ONLY</body></html>',
        });
      }
      unexpected.push({ method: request.method(), path });
      return route.abort('blockedbyclient');
    });
    await page.goto(
      new URL('/tests/invoice-documents/harness.html' + (global ? '?global=1' : ''), base).href,
    );
    await expect(page.getByRole('heading', { name: 'Invoice options fixture' })).toBeVisible();
    return {
      context,
      page,
      deny: () => {
        deny = true;
      },
      valid: () => {
        mismatch = false;
      },
      release: () => resolveHold(),
    };
  }
  {
    const f = await fixture();
    await expect(
      f.page.getByRole('button', { name: 'SDD tax invoice', exact: true }),
    ).toBeEnabled();
    await f.page.getByRole('button', { name: 'SDD tax invoice', exact: true }).click();
    const dialog = f.page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /SDD tax invoice FIXTURE/ })).toBeVisible();
    await expect(dialog.frameLocator('iframe').getByText('STORE1_SELECTED')).toBeVisible();
    checks.push('writer-derived-sdd-action-and-protected-actor-frame');
    f.deny();
    await dialog.getByRole('button', { name: 'Print invoice', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Invoice access changed.');
    await expect(dialog.locator('iframe')).toHaveCount(0);
    checks.push('denied-fresh-manual-print-removes-prior-content');
    await dialog.getByRole('button', { name: 'Close invoice' }).click();
    await f.page.getByRole('button', { name: 'Store shipment tax invoice', exact: true }).click();
    await expect(f.page.frameLocator('iframe').getByText('STORE1_SELECTED')).toBeVisible();
    await expect(f.page.frameLocator('iframe').locator('body')).not.toContainText('FOREIGN');
    checks.push('selected-express-document-action');
    await f.page.getByRole('button', { name: 'Close invoice' }).click();
    await f.page.getByRole('button', { name: 'Toggle connection' }).click();
    await expect(f.page.getByRole('button', { name: 'SDD tax invoice', exact: true })).toHaveCount(
      0,
    );
    checks.push('offline-does-not-expose-current-document-actions');
    await f.context.close();
  }
  {
    const f = await fixture({ mismatch: true });
    await expect(f.page.getByRole('button', { name: 'Retry invoice options' })).toBeVisible();
    await expect(
      f.page.getByRole('button', { name: 'Online tax invoice', exact: true }),
    ).toHaveCount(0);
    f.valid();
    await f.page.getByRole('button', { name: 'Retry invoice options' }).click();
    await expect(
      f.page.getByRole('button', { name: 'Online tax invoice', exact: true }),
    ).toBeVisible();
    checks.push('capability-order-mismatch-is-not-rendered-and-can-refresh');
    await f.context.close();
  }
  {
    const f = await fixture({ hold: true, available: false });
    await expect(
      f.page.getByRole('button', { name: 'Store shipment tax invoice', exact: true }),
    ).toBeDisabled();
    checks.push('unqualified-provider-action-remains-disabled');
    await f.page.getByRole('button', { name: 'Change order' }).click();
    await f.page.getByRole('button', { name: 'Change operator' }).click();
    await expect(f.page.getByText('Current operator 55')).toBeVisible();
    f.release();
    await expect(
      f.page.getByRole('button', { name: 'Online tax invoice', exact: true }),
    ).toBeVisible();
    await f.page.getByRole('button', { name: 'Online tax invoice', exact: true }).click();
    await expect(f.page.locator('iframe')).toHaveAttribute(
      'src',
      '/api/v1/operators/55/stores/1/orders/12346/invoices/online/preview',
    );
    await expect(f.page.frameLocator('iframe').getByText('STORE1_SELECTED')).toBeVisible();
    checks.push('late-old-actor-capability-cannot-authorize-new-actor-document');
    await f.page.getByRole('button', { name: 'Close invoice' }).click();
    await f.page.getByRole('button', { name: 'Change store' }).click();
    await expect(
      f.page.getByRole('button', { name: 'Online tax invoice', exact: true }),
    ).toHaveCount(0);
    checks.push('unassigned-store-clears-old-actions');
    await f.context.close();
  }
  {
    const f = await fixture({ global: true });
    await f.page.getByRole('button', { name: 'Online tax invoice', exact: true }).click();
    const dialog = f.page.getByRole('dialog');
    await expect(dialog.frameLocator('iframe').getByText('STORE1_SELECTED')).toBeVisible();
    await expect(dialog.locator('iframe')).toHaveAttribute('src', /access=global-online$/);
    const download = f.page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download invoice', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('online-tax-invoice-12345.html');
    checks.push('explicit-global-context-preview-and-fresh-download-access-identity');
    await f.page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Change invoice access')
        .click(),
    );
    await expect(f.page.locator('iframe')).toHaveCount(0);
    checks.push('scope-switch-cannot-retain-or-reinterpret-global-frame');
    await f.context.close();
  }
  expect(unexpected).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
  const directory = new URL('../../../backend/parity/evidence/invoice-documents/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL('global-browser.json.tmp', directory),
    JSON.stringify(
      {
        scope:
          'Controlled invoice UI/capability/preview fixtures; not deployed provider or physical printer qualification',
        checks,
        readOnlyRequests: requests.length,
        unexpected: unexpected.length,
        pageErrors: pageErrors.length,
      },
      null,
      2,
    ) + '\n',
  );
  await rename(
    new URL('global-browser.json.tmp', directory),
    new URL('global-browser.json', directory),
  );
  console.log(JSON.stringify({ checks: checks.length, unexpected: 0, pageErrors: 0 }));
} finally {
  await browser.close();
}
