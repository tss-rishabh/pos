import { installInvoicePrintProbe } from './invoice-print-probe';
import {
  invoicePreviewHtml,
  invoicePreviewPolicy,
} from '../../../backend/src/modules/invoice-documents/presentation';
import { sanitizeInvoiceHtml } from '../../../backend/src/modules/checkout/invoices';
import { test, expect, sandboxedFrameTrace } from '../support/fixtures';
import { exchangeRecoverySchema } from '../../src/pages/returns/client';
import { eligibleLine } from '../support/eligibility';
import { signIn } from '../support/login';

test.use(sandboxedFrameTrace);

test('exchange preserves stored picks after rejection and reload without retrying an uncertain child', async ({
  page,
  network,
}) => {
  // The fixture rejects the first replacement on purpose.
  network.expectFailure({
    method: 'POST',
    path: '/api/v1/stores/1/orders/8802/line-items/88021/exchanges',
    outcome: 422,
  });
  let exchangeId = '',
    phase = 'replacement-rejected',
    starts = 0,
    retries = 0,
    continuations = 0,
    reconciliations = 0,
    invoiceReads = 0,
    ownerId = '',
    recoveryReads = 0,
    eligibilityReads = 0;
  await installInvoicePrintProbe(page);
  await page.route('**/api/v1/operators/*/stores/1/orders/9901/invoices/store/preview', (route) => {
    invoiceReads++;
    expect(new URL(route.request().url()).pathname).toBe(
      `/api/v1/operators/${ownerId}/stores/1/orders/9901/invoices/store/preview`,
    );
    return route.fulfill({
      contentType: 'text/html',
      headers: { 'Content-Security-Policy': invoicePreviewPolicy, 'Cache-Control': 'no-store' },
      body: invoicePreviewHtml(
        sanitizeInvoiceHtml('<h1>Confirmed replacement tax invoice</h1>'),
        { operatorId: ownerId, storeId: '1', orderId: '9901', kind: 'store' },
        'EXCHANGE-INVOICE',
      ),
    });
  });
  const receipt = () => ({
    id: exchangeId,
    kind: 'exchange',
    storeId: '1',
    orderId: '8802',
    lineId: '88021',
    phase,
    uncertainStage: phase === 'uncertain' ? 'replacement' : null,
    creditNote: 'CN-EXCHANGE-FIXTURE',
    returnAmount: null,
    newOrderId: ['replacement-confirmed', 'completed'].includes(phase) ? '9901' : null,
    replacement: {
      productId: '1002',
      size: 'L',
      salespersonId: '5',
      reasonId: '2',
      subReasonId: '21',
    },
    errorCode:
      phase === 'replacement-rejected'
        ? 'EXCHANGE_REPLACEMENT_REJECTED'
        : phase === 'uncertain'
          ? 'EXCHANGE_OUTCOME_UNCERTAIN'
          : null,
    createdAt: '2026-11-16 10:00:00',
    updatedAt: '2026-11-16 10:00:00',
  });
  await page.route('**/api/v1/stores/1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    const actor = req.headers()['x-operator-id'];
    if (actor) {
      if (ownerId) expect(actor).toBe(ownerId);
      else ownerId = actor;
    }
    if (
      req.method() === 'GET' &&
      path.endsWith('/orders/8802/line-items/88021/exchange-recovery')
    ) {
      const query = new URL(req.url()).searchParams;
      expect(query.get('counterId')).toBe('1');
      expect(query.has('verificationId')).toBe(false);
      recoveryReads++;
      return route.fulfill({
        json: exchangeRecoverySchema.parse({
          revision: 'f'.repeat(64),
          state: 'none',
          operation: null,
          newSize: null,
        }),
      });
    }
    if (
      req.method() === 'GET' &&
      path.endsWith('/orders/8802/line-items/88021/return-eligibility')
    ) {
      const query = new URL(req.url()).searchParams;
      expect(query.get('counterId')).toBe('1');
      expect(query.has('verificationId')).toBe(false);
      expect(query.get('kind')).toBe('exchange');
      eligibilityReads++;
      return route.fulfill({
        json: eligibleLine({ orderId: '8802', lineId: '88021', kind: 'exchange' }),
      });
    }
    if (path.endsWith('/orders/8802/return-lines'))
      return route.fulfill({
        json: {
          data: [
            {
              id: '88021',
              productId: '1001',
              name: 'Fixture exchange T-shirt',
              parentId: '1000',
              quantity: '1',
              status: 'DELIVERED',
              returnStatus: 0,
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith('/exchange-reasons'))
      return route.fulfill({
        json: {
          data: [
            { id: 2, reason: 'Size swap', sub_reason: [{ id: 21, sub_reason: 'Larger size' }] },
          ],
        },
      });
    if (path.endsWith('/exchange-sizes'))
      return route.fulfill({
        json: {
          data: [
            { prod_id: '1001', size: 'M', stock: 5 },
            { prod_id: '1002', size: 'L', stock: 3 },
            { prod_id: '1003', size: 'XL', stock: 0 },
          ],
        },
      });
    if (path.endsWith('/salespeople'))
      return route.fulfill({
        json: {
          data: [
            {
              id: '5',
              name: 'Fixture Specialist',
            },
          ],
          nextCursor: null,
        },
      });
    if (path.endsWith('/line-items/88021/exchanges')) {
      starts++;
      const body = req.postDataJSON() as Record<string, unknown>;
      exchangeId = String(body.operationId);
      expect(body).toMatchObject({
        counterId: '1',
        replacementProductId: '1002',
        salespersonId: '5',
        reasonId: '2',
        subReasonId: '21',
        qualityConfirmed: true,
        tagConfirmed: true,
        saleable: false,
      });
      expect(body).not.toHaveProperty('refundMode');
      return route.fulfill({
        status: 422,
        json: {
          error: {
            code: 'EXCHANGE_REPLACEMENT_REJECTED',
            message: 'The replacement request was rejected.',
          },
        },
      });
    }
    if (path.includes('/exchanges/') && path.endsWith('/retries')) {
      retries++;
      expect(req.postDataJSON()).toEqual({ salespersonId: '5' });
      phase = 'uncertain';
      return route.fulfill({ status: 202, json: receipt() });
    }
    if (path.includes('/exchanges/') && path.endsWith('/continuations')) {
      continuations++;
      phase = 'completed';
      return route.fulfill({ json: receipt() });
    }
    if (path.includes('/exchanges/') && path.endsWith('/reconciliations')) {
      reconciliations++;
      expect(req.postDataJSON()).toEqual({});
      phase = 'replacement-confirmed';
      return route.fulfill({ json: receipt() });
    }
    if (path.includes('/exchanges/')) return route.fulfill({ json: receipt() });
    return route.continue();
  });
  await page.goto('/');
  await signIn(page);
  await page.getByRole('link', { name: 'Returns', exact: true }).click();
  await page.getByRole('button', { name: 'Exchange', exact: true }).click();
  await page.getByLabel('Return order ID').fill('8802');
  await page.getByRole('button', { name: 'Find order' }).click();
  await page.getByRole('button', { name: 'Fixture exchange T-shirt' }).click();
  await expect(page.getByRole('button', { name: 'XL · 0 in stock' })).toBeDisabled();
  await page.getByRole('button', { name: 'L · 3 in stock', exact: true }).click();
  await page.getByLabel('Exchange salesperson').selectOption('5');
  await page.getByLabel('Exchange reason', { exact: true }).selectOption('2');
  await page.getByLabel('Exchange sub-reason').selectOption('21');
  await page.getByLabel('Comment', { exact: true }).fill('PRIVATE-EXCHANGE-COMMENT');
  await page.getByRole('checkbox', { name: 'I checked the item’s condition' }).check();
  await page.getByRole('checkbox', { name: 'I checked the original tag' }).check();
  expect(recoveryReads).toBeGreaterThan(0);
  expect(eligibilityReads).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Confirm exchange', exact: true }).click();
  await expect(page.getByText('Stored replacement: size L · SKU 1002')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry stored replacement' })).toBeEnabled();
  expect(starts).toBe(1);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    'PRIVATE-EXCHANGE-COMMENT',
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry stored replacement' })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry stored replacement' }).click();
  await expect(
    page.getByText('The return or replacement outcome needs reconciliation.'),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry stored replacement' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue confirmed exchange' })).toHaveCount(0);
  expect(retries).toBe(1);
  expect(starts).toBe(1);
  // The client-side replacement reconcile button was deleted with the replacement-proof flow
  // (2babb90f); the backend has no exchange reconciliation route. The server's settled outcome
  // is read with "Check exchange status".
  phase = 'replacement-confirmed';
  await page.getByRole('button', { name: 'Check exchange status' }).click();
  await page.getByRole('button', { name: 'Continue confirmed exchange' }).click();
  await expect(page.getByRole('heading', { name: 'Exchange completed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tax invoice', exact: true })).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title=\"Tax invoice for order 9901\"]')
      .getByRole('heading', { name: 'Confirmed replacement tax invoice' }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-invoice-print-count', '1');
  expect(invoiceReads).toBe(1);
  await page.getByRole('button', { name: 'Close invoice' }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Exchange completed' })).toBeVisible();
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(invoiceReads).toBe(1);
  expect(continuations).toBe(1);
  expect(starts).toBe(1);
  expect(retries).toBe(1);
  expect(reconciliations).toBe(0);
});
