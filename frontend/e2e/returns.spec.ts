import { test, expect } from '@playwright/test';
import { eligibleLine } from './support/eligibility';

test('return confirmation without a customer OTP and reload recovery never repeat an uncertain refund', async ({
  page,
}) => {
  let returnId = '',
    posts = 0,
    phase = 'uncertain';
  const receipt = () => ({
    id: returnId,
    storeId: '1',
    orderId: '8801',
    lineId: '88011',
    phase,
    uncertainStage: phase === 'uncertain' ? 'refund' : null,
    creditNote: phase === 'completed' ? 'CN-FIXTURE' : null,
    returnAmount: phase === 'completed' ? '999.00' : null,
    errorCode: phase === 'uncertain' ? 'RETURN_OUTCOME_UNCERTAIN' : null,
    createdAt: '2026-11-16 10:00:00',
    updatedAt: '2026-11-16 10:00:00',
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    // Scope and authentication are fixed alongside the financial responses.
    // Accelerated sibling tests share a server quota, including on page reload.
    if (path === '/api/v1/auth/sessions/current') {
      await route.fulfill({
        json: {
          user: {
            id: '900001',
            name: 'Fixture operator',
            email: 'operator@example.test',
            role: 4,
            userType: 1,
            storeIds: ['1'],
          },
          sessionExpiresAt: Date.now() + 3_600_000,
        },
      });
    } else if (path === '/api/v1/stores') {
      await route.fulfill({
        json: {
          data: [
            {
              id: '1',
              name: 'Fixture store',
              locationCode: 'FIX1',
              city: 'Fixture city',
              active: true,
            },
          ],
        },
      });
    } else if (path.endsWith('/counters') && request.method() === 'GET') {
      await route.fulfill({ json: { data: [{ id: '1', storeId: '1', name: 'Fixture counter' }] } });
    } else if (path.endsWith('/orders/8801/return-lines'))
      await route.fulfill({
        json: {
          data: [
            {
              id: '88011',
              productId: '1001',
              name: 'Fixture T-shirt',
              parentId: '1000',
              quantity: '1',
              status: 'DELIVERED',
              returnStatus: 0,
            },
          ],
          nextCursor: null,
        },
      });
    else if (path.endsWith('/orders/8801/line-items/88011/return-eligibility')) {
      expect(new URL(request.url()).searchParams.get('kind')).toBe('return');
      await route.fulfill({
        json: eligibleLine({ orderId: '8801', lineId: '88011', kind: 'return' }),
      });
    } else if (path.endsWith('/return-reasons'))
      await route.fulfill({ json: { data: [{ id: '1', reason: 'Quality' }] } });
    else if (path.endsWith('/sub-reasons'))
      await route.fulfill({ json: { data: [{ id: '9', sub_reason: 'Stitching' }] } });
    else if (path.endsWith('/refund-preview'))
      await route.fulfill({ json: { pay_mode: 'other', pay_amt: 999, is_exchange_order: false } });
    else if (path.endsWith('/line-items/88011/returns')) {
      posts++;
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({
        counterId: '1',
        reasonId: '1',
        subReasonId: '9',
        qualityConfirmed: true,
        tagConfirmed: true,
        saleable: false,
        refundMode: 'tss-money',
      });
      returnId = String(body.operationId);
      await route.fulfill({ status: 202, json: receipt() });
    } else if (path.includes('/returns/') && path.endsWith('/continuations')) {
      phase = 'completed';
      await route.fulfill({ json: receipt() });
    } else if (path.includes('/returns/')) await route.fulfill({ json: receipt() });
    else await route.abort('blockedbyclient');
  });
  await page.goto('/returns');
  await page.getByRole('combobox', { name: 'Current counter' }).selectOption('1');
  await page.getByLabel('Return order ID').fill('8801');
  await page.getByRole('button', { name: 'Find order' }).click();
  await page.getByRole('button', { name: 'Fixture T-shirt' }).click();
  await page.getByLabel('Return reason', { exact: true }).selectOption('1');
  await page.getByLabel('Return sub-reason').selectOption('9');
  await page.getByLabel('Comment', { exact: true }).fill('PRIVATE-COMMENT-CANARY');
  await page.getByRole('checkbox', { name: 'I checked the item’s condition' }).check();
  await page.getByRole('checkbox', { name: 'I checked the original tag' }).check();
  await page.getByRole('button', { name: 'Confirm return & refund' }).click();
  await expect(
    page.getByText('The warehouse or refund outcome needs reconciliation.'),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(
    'PRIVATE-COMMENT-CANARY',
  );
  await page.reload();
  await expect(
    page.getByText('The warehouse or refund outcome needs reconciliation.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue confirmed return' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check return status' }).click();
  expect(posts).toBe(1);
  phase = 'refund-confirmed';
  await page.getByRole('button', { name: 'Check return status' }).click();
  await page.getByRole('button', { name: 'Continue confirmed return' }).click();
  await expect(page.getByRole('heading', { name: 'Return completed' })).toBeVisible();
  expect(posts).toBe(1);
});
