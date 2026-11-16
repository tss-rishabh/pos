import { expect, test, type Page } from '@playwright/test';
import {
  walletAdjustmentSchema,
  type WalletAdjustmentInput,
  type WalletAdjustmentReceipt,
} from '../../src/offline/benefits/contracts';
import {
  walletAdjustmentContract,
  walletCorrectionPatchHash,
} from '../../src/offline/benefits/fields';

async function savedCommands(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('souled-pos-v1'),
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Could not open the wallet fixture.'));
      });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const read = database
          .transaction('walletCommands', 'readonly')
          .objectStore('walletCommands')
          .getAll();
        read.onsuccess = () => resolve(read.result as unknown[]);
        read.onerror = () => reject(new Error('Could not read the wallet fixture.'));
      });
    } finally {
      database.close();
    }
  });
}
for (const loss of ['none', 'committed', 'uncommitted', 'offline'] as const) {
  test(`global wallet review and ${loss === 'none' ? 'Money/Points completion' : loss === 'offline' ? 'offline mutation refusal' : loss + ' response recovery'}`, async ({
    page,
    context,
  }) => {
    const requests: WalletAdjustmentInput[] = [],
      receipts = new Map<string, WalletAdjustmentReceipt>(),
      email = 'wallet-customer@example.test';
    let proofAvailable = loss !== 'committed',
      money = 100,
      points = 80;
    await context.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (path === '/api/v1/auth/sessions/current')
        return route.fulfill({
          json: {
            user: {
              id: '44',
              name: 'Fixture administrator',
              email: 'operator@example.test',
              role: 2,
              userType: 1,
              storeIds: ['1'],
            },
            sessionExpiresAt: Date.now() + 3600000,
          },
        });
      if (path === '/api/v1/stores')
        return route.fulfill({
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
      if (path === '/api/v1/stores/1/counters')
        return route.fulfill({
          json: { data: [{ id: '1', storeId: '1', name: 'Fixture counter' }] },
        });
      if (path === '/api/v1/wallet-adjustment-capabilities')
        return route.fulfill({
          json: {
            enabled: true,
            contract: walletAdjustmentContract,
            patchHash: walletCorrectionPatchHash,
          },
        });
      if (path === '/api/v1/benefit-customer-lookups') {
        expect(request.method()).toBe('POST');
        expect(request.postDataJSON()).toEqual({ email });
        expect(request.url()).not.toContain(email);
        return route.fulfill({
          json: {
            id: '9007199254740993',
            name: 'Fixture wallet customer',
            money: money.toFixed(2),
            points: points.toFixed(2),
          },
        });
      }
      if (path === '/api/v1/wallet-adjustments') {
        expect(request.headers()['x-operator-id']).toBe('44');
        const body = walletAdjustmentSchema.parse(request.postDataJSON() as unknown);
        requests.push(body);
        const old = receipts.get(body.operationId);
        if (old) return route.fulfill({ json: old });
        if (requests.length === 1 && loss === 'uncommitted') return route.abort('failed');
        const before = body.adjustment.asset === 'money' ? money : points,
          after =
            before +
            Number(body.adjustment.amount) * (body.adjustment.direction === 'subtract' ? -1 : 1);
        if (body.adjustment.asset === 'money') money = after;
        else points = after;
        const receipt: WalletAdjustmentReceipt = {
          operationId: body.operationId,
          operatorId: '44',
          customerId: body.customerId,
          asset: body.adjustment.asset,
          direction: body.adjustment.direction,
          amount: Number(body.adjustment.amount).toFixed(2),
          balanceBefore: before.toFixed(2),
          balanceAfter: after.toFixed(2),
          historyId: '9007199254740994',
          consumedHistories: body.adjustment.direction === 'subtract' ? 1 : 0,
          contract: walletAdjustmentContract,
          patchHash: walletCorrectionPatchHash,
          createdAt: '2026-11-16 10:00:00',
        };
        receipts.set(body.operationId, receipt);
        if (requests.length === 1 && loss === 'committed') return route.abort('failed');
        return route.fulfill({ json: receipt });
      }
      if (path.startsWith('/api/v1/wallet-adjustments/')) {
        const result = receipts.get(path.split('/').pop()!);
        return result && proofAvailable
          ? route.fulfill({ json: result })
          : route.fulfill({
              status: 404,
              json: {
                error: {
                  code: 'WALLET_ADJUSTMENT_NOT_FOUND',
                  message: 'Fixture result is not yet confirmed.',
                },
              },
            });
      }
      return route.fulfill({
        status: 503,
        json: {
          error: {
            code: 'UNEXPECTED_FIXTURE_REQUEST',
            message: 'Unexpected wallet fixture request.',
          },
        },
      });
    });
    await page.goto('/wallet-adjustments');
    await page.getByLabel('Customer email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Find benefit customer', exact: true }).click();
    await page.getByLabel('Adjustment amount', { exact: true }).fill('10.00');
    await page.getByLabel('Earning expiry', { exact: true }).fill('2027-12-31');
    await page.getByRole('button', { name: 'Review wallet adjustment', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Review wallet adjustment', exact: true }),
    ).toContainText('Fixture wallet customer');
    if (loss === 'offline') {
      await context.setOffline(true);
      await expect(
        page.getByRole('button', { name: 'Confirm wallet adjustment', exact: true }),
      ).toBeDisabled();
      expect(requests).toEqual([]);
      expect(await savedCommands(page)).toEqual([]);
      return;
    }
    await page.getByRole('button', { name: 'Confirm wallet adjustment', exact: true }).click();
    if (loss !== 'none') {
      await expect(
        page.getByRole('button', { name: 'Retry saved wallet adjustment', exact: true }),
      ).toBeEnabled();
      expect(requests).toHaveLength(1);
      proofAvailable = true;
      await page.reload();
      if (loss === 'uncommitted') {
        await expect(
          page.getByRole('button', { name: 'Retry saved wallet adjustment', exact: true }),
        ).toBeEnabled();
        await page
          .getByRole('button', { name: 'Check wallet adjustment status', exact: true })
          .click();
        expect(requests).toHaveLength(1);
        await page
          .getByRole('button', { name: 'Retry saved wallet adjustment', exact: true })
          .click();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[1]).toEqual(requests[0]);
      }
    }
    await expect(
      page.getByRole('heading', { name: 'Wallet adjustment confirmed', exact: true }),
    ).toBeVisible();
    const records = await savedCommands(page);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(email);
    expect(JSON.stringify(records)).not.toContain('Fixture wallet customer');
    expect(money).toBe(110);
    if (loss === 'none') {
      await page.getByRole('button', { name: 'New wallet adjustment', exact: true }).click();
      await page.getByLabel('Customer email', { exact: true }).fill(email);
      await page.getByRole('button', { name: 'Find benefit customer', exact: true }).click();
      await page
        .getByRole('combobox', { name: 'Benefit wallet', exact: true })
        .selectOption('points');
      await page
        .getByRole('combobox', { name: 'Adjustment operation', exact: true })
        .selectOption('subtract');
      await page.getByLabel('Adjustment amount', { exact: true }).fill('5.25');
      await page.getByRole('button', { name: 'Review wallet adjustment', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm wallet adjustment', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Wallet adjustment confirmed', exact: true }),
      ).toBeVisible();
      expect(points).toBe(74.75);
      expect(money).toBe(110);
      expect(await savedCommands(page)).toHaveLength(2);
      expect(requests).toHaveLength(2);
    } else expect(requests).toHaveLength(loss === 'uncommitted' ? 2 : 1);
  });
}
