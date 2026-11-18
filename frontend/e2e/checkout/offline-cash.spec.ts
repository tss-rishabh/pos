import { generateKeyPairSync } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  cashDigest,
  offlineCashSigner,
  verifyDeviceCashReceipt,
} from '../../../backend/src/modules/checkout/offline-cash/crypto';
import {
  cashPriceSnapshotSchema,
  devicePublicKeySchema,
  signedCashReceiptSchema,
  type DevicePublicKey,
  type CashReceiptAcceptance,
} from '../../../backend/src/modules/checkout/offline-cash/contracts';
import type { LocalCashReceipt, LocalCashSync } from '../../src/offline/cash/storage-types';
import type { CashOrderImportRequest } from '../../src/offline/cash/client';

async function savedCash(page: Page) {
  return page.evaluate(async () => {
    const open = indexedDB.open('souled-pos-v1'),
      database = await new Promise<IDBDatabase>((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(new Error('Could not open the cash fixture.'));
      });
    try {
      const names = ['offlineCashReceipts', 'offlineCashSync', 'drafts', 'completedSales'],
        transaction = database.transaction(names, 'readonly');
      const rows = await Promise.all(
        names.map(
          (name) =>
            new Promise<unknown[]>((resolve, reject) => {
              const request = transaction.objectStore(name).getAll();
              request.onsuccess = () => resolve(request.result as unknown[]);
              request.onerror = () => reject(new Error('Could not read the cash fixture.'));
            }),
        ),
      );
      return {
        receipts: rows[0] as LocalCashReceipt[],
        jobs: rows[1] as LocalCashSync[],
        drafts: rows[2] as { id: string; lines: { quantity: number }[] }[],
        paid: rows[3],
      };
    } finally {
      database.close();
    }
  });
}

for (const scenario of [
  { name: 'manager stock conflict', interrupted: false, clean: false, loss: 'none' },
  {
    name: 'lost cash acknowledgment with newer cart conservation',
    interrupted: true,
    clean: false,
    loss: 'none',
  },
  { name: 'automatic clean order import', interrupted: false, clean: true, loss: 'none' },
  {
    name: 'lost committed import GET recovery',
    interrupted: false,
    clean: true,
    loss: 'committed',
  },
  {
    name: 'explicit exact retry after an unconfirmed import',
    interrupted: false,
    clean: true,
    loss: 'uncommitted',
  },
]) {
  test(`offline cash completes, prints and reprints before ${scenario.name}`, async ({
    page,
    context,
  }) => {
    const { interrupted, clean, loss } = scenario;
    // Keep the committed result unavailable until after the uncertain record
    // has survived a reload. An immediate background GET can otherwise recover
    // the result before the polling assertion observes the intermediate state.
    let committedImportReadAvailable = loss !== 'committed';
    const signer = offlineCashSigner(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    let deviceKey: DevicePublicKey | null = null,
      registrations = 0,
      authorizations = 0,
      uploads = 0;
    const imports: CashOrderImportRequest[] = [];
    const server = new Map<string, string>(),
      productName = 'A'.repeat(150) + ' <script>window.cashReceiptInjection=true</script>';
    const acknowledgments = new Map<string, CashReceiptAcceptance>(),
      windows = new Map<
        string,
        { issuedAt: number; expiresAt: number; businessDate: string; timeZone: string }
      >();
    // Bootstrap scope and catalog are isolated from accelerated sibling tests'
    // shared demo quotas. This also proves the non-manager cashier path.
    await context.route('**/api/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/v1/auth/sessions/current')
        return route.fulfill({
          json: {
            user: {
              id: '44',
              name: 'Fixture cashier',
              email: 'cashier@example.test',
              role: 5,
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
      if (path === '/api/v1/stores/1/catalog/products')
        return route.fulfill({
          json: {
            data: [
              {
                id: '9007199254740993',
                name: 'Fixture product',
                erpName: 'Fixture SKU',
                barcode: 'FIXTURE',
                parentId: '9007199254740994',
                type: '1',
                price: '100.00',
                specialPrice: '100.00',
                exclusivePrice: null,
                stock: 10,
                gst: 0,
                image: null,
              },
            ],
            nextCursor: null,
          },
        });
      return route.continue();
    });
    await context.route('**/api/v1/stores/1/offline-cash-devices', async (route) => {
      registrations++;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      deviceKey = devicePublicKeySchema.parse(body.publicKey);
      return route.fulfill({
        status: 201,
        json: { deviceId: body.deviceId, keyHash: cashDigest(deviceKey) },
      });
    });
    await context.route('**/api/v1/stores/1/offline-cash-authorizations', async (route) => {
      authorizations++;
      const body = route.request().postDataJSON() as {
          deviceId: string;
          counterId: string;
          productIds: string[];
        },
        issuedAt = Date.now(),
        expiresAt = issuedAt + 600000,
        id = crypto.randomUUID();
      const snapshot = cashPriceSnapshotSchema.parse({
        version: 1,
        id: crypto.randomUUID(),
        storeId: '1',
        counterId: body.counterId,
        businessDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
          issuedAt,
        ),
        issuedAt,
        expiresAt,
        sourceContract: 'pos-offline-cash-prices-v1',
        sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
        sourceSettingsHash: 'a'.repeat(64),
        locationSettingsHash: 'b'.repeat(64),
        lineItemsEnabled: true,
        excludedProductIds: [],
        products: body.productIds.map((productId) => ({
          productId,
          name: productName,
          barcode: 'FIXTURE',
          hsn: '6109',
          cachedStock: 10,
          quantities: Array.from({ length: 20 }, (_value, index) => ({
            quantity: index + 1,
            unitPrice: '100.00',
            mainSubtotalCents: 10000 * (index + 1),
            taxableCents: 10000 * (index + 1),
            taxCents: 0,
            invoiceGst: '0',
          })),
        })),
      });
      const envelope = signer.authorize({
        version: 1,
        id,
        deviceId: body.deviceId,
        deviceKeyHash: cashDigest(deviceKey),
        operatorId: route.request().headers()['x-operator-id'] || '1',
        operatorAuthVersion: 'c'.repeat(64),
        operatorCustomerId: '777',
        storeId: '1',
        counterId: body.counterId,
        businessDate: snapshot.businessDate,
        issuedAt,
        expiresAt,
        snapshotId: snapshot.id,
        snapshotHash: cashDigest(snapshot),
        stockPolicy: 'cached-stock-manager',
        mode: 'cash-only',
        currency: 'INR',
        receiptPrefix: 'OC-' + id.replace(/-/g, '').toUpperCase(),
        receiptCount: 100,
        maxReceiptUnits: 1000,
        maxReceiptCents: 1000000,
        maxTotalCents: 10000000,
      });
      windows.set(id, {
        issuedAt,
        expiresAt,
        businessDate: snapshot.businessDate,
        timeZone: 'Asia/Kolkata',
      });
      return route.fulfill({
        status: 201,
        json: { envelope, snapshot, serverKey: signer.publicKey },
      });
    });
    await context.route('**/api/v1/stores/1/offline-cash-receipts', async (route) => {
      uploads++;
      const envelope = signedCashReceiptSchema.parse(route.request().postDataJSON() as unknown),
        receipt = envelope.receipt;
      expect(deviceKey && verifyDeviceCashReceipt(deviceKey, envelope)).toBe(true);
      const original = server.get(receipt.id);
      if (original) expect(JSON.stringify(envelope)).toBe(original);
      else server.set(receipt.id, JSON.stringify(envelope));
      const accepted: CashReceiptAcceptance = acknowledgments.get(receipt.id) || {
        receiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
        operatorId: receipt.operatorId,
        storeId: receipt.storeId,
        counterId: receipt.counterId,
        businessDate: receipt.businessDate,
        completedAt: receipt.completedAt,
        acceptedAt: Date.now(),
        importedAt: null,
        payableCents: receipt.payableCents,
        cashReceivedCents: receipt.cashReceivedCents,
        changeCents: receipt.changeCents,
        status: clean ? 'accepted' : 'conflicted',
        conflicts: clean ? [] : ['stock-shortage'],
        orderId: null,
        version: 1,
      };
      acknowledgments.set(receipt.id, accepted);
      if (interrupted && uploads === 1) return route.abort('failed');
      return route.fulfill({ status: 201, json: accepted });
    });
    await context.route('**/api/v1/stores/1/offline-cash-receipts/*', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/').pop()!,
        accepted = acknowledgments.get(id),
        raw = server.get(id);
      if (!accepted || !raw)
        return route.fulfill({ status: 404, json: { error: { code: 'FIXTURE_NOT_FOUND' } } });
      if (accepted.status === 'imported' && !committedImportReadAvailable)
        return route.abort('failed');
      const envelope = signedCashReceiptSchema.parse(JSON.parse(raw) as unknown);
      return route.fulfill({
        status: 200,
        json: {
          ...accepted,
          envelope,
          authorizationWindow: windows.get(envelope.receipt.authorizationId),
          auditEvents: [
            {
              operationId: id,
              kind: 'accepted',
              actorId: accepted.operatorId,
              receiptVersion: 1,
              createdAt: accepted.acceptedAt,
            },
          ],
          activeApproval: null,
        },
      });
    });
    await context.route(
      '**/api/v1/stores/1/offline-cash-receipts/*/order-imports',
      async (route) => {
        expect(clean).toBe(true);
        expect(route.request().headers()['x-operator-id']).toBe('44');
        const input = route.request().postDataJSON() as CashOrderImportRequest,
          id = new URL(route.request().url()).pathname.split('/').at(-2)!,
          accepted = acknowledgments.get(id)!;
        imports.push(input);
        expect(Object.keys(input).sort()).toEqual(['expectedVersion', 'operationId']);
        expect(input.operationId).toMatch(/^[a-f0-9-]{36}$/);
        expect(input.expectedVersion).toBe(1);
        if (imports.length > 1) expect(input).toEqual(imports[0]);
        if (imports.length === 1 && loss === 'uncommitted') return route.abort('failed');
        const result: CashReceiptAcceptance = {
          ...accepted,
          status: 'imported',
          conflicts: [],
          orderId: '9007199254740995',
          importedAt: accepted.acceptedAt + 1000,
          version: 2,
        };
        acknowledgments.set(id, result);
        if (imports.length === 1 && loss === 'committed') return route.abort('failed');
        return route.fulfill({ json: result });
      },
    );
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Current counter' }).selectOption('1');
    const add = page.getByRole('button', { name: /^Add .+ to sale$/ }).first(),
      originalName = (await add.getAttribute('aria-label'))!
        .replace(/^Add /, '')
        .replace(/ to sale$/, '');
    await add.click();
    const originalDraftId = await page.locator('[data-cart-id]').getAttribute('data-cart-id');
    await page.getByRole('button', { name: 'Enable offline cash', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Offline cash enabled', exact: true }),
    ).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller)
        await new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), {
            once: true,
          }),
        );
    });
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Complete cash offline', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Complete cash sale', exact: true }),
    ).toBeVisible();
    if (interrupted) {
      const editor = await context.newPage();
      await editor.goto('/');
      await editor.getByRole('button', { name: `Increase ${originalName}`, exact: true }).click();
      await expect
        .poll(async () => (await savedCash(editor)).drafts[0]?.lines[0]?.quantity)
        .toBe(2);
      await editor.close();
    }
    await page.getByLabel('Offline cash received', { exact: true }).fill('500.00');
    await page.getByRole('button', { name: 'Record cash and complete sale', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Saved cash receipt', exact: true }),
    ).toBeVisible();
    expect(
      await page
        .getByRole('article', { name: 'Cash receipt', exact: true })
        .evaluate((element) => element.scrollWidth <= element.getBoundingClientRect().width + 1),
    ).toBe(true);
    const print = page.getByRole('button', { name: 'Print cash receipt', exact: true });
    await expect(print).toBeEnabled();
    const frame = page.frameLocator('iframe[title="Cash receipt print document"]');
    await expect(frame.locator('.offline-cash-receipt')).toContainText(productName);
    expect(await frame.locator('script').count()).toBe(0);
    expect(await frame.locator('img').count()).toBe(0);
    await expect
      .poll(() =>
        frame
          .locator('.offline-cash-receipt')
          .evaluate((element) => getComputedStyle(element).fontFamily.includes('monospace')),
      )
      .toBe(true);
    expect(
      await frame
        .locator('.offline-cash-receipt')
        .evaluate((element) => element.scrollWidth <= element.getBoundingClientRect().width + 1),
    ).toBe(true);
    await frame.locator('body').evaluate((body) => {
      const view = body.ownerDocument.defaultView!;
      view.print = () => {
        body.setAttribute('data-printed', 'yes');
      };
    });
    await print.click();
    await expect(frame.locator('body')).toHaveAttribute('data-printed', 'yes');
    const first = await savedCash(page),
      number = first.receipts[0]!.envelope.receipt.receiptNumber,
      receiptId = first.receipts[0]!.receiptId;
    expect(first.receipts).toHaveLength(1);
    expect(first.paid).toEqual([]);
    expect(first.jobs[0]!.state).toBe('pending');
    expect(first.receipts[0]!.envelope.receipt).toMatchObject({
      payableCents: 10000,
      cashReceivedCents: 50000,
      changeCents: 40000,
    });
    expect(first.drafts[0]!.id).not.toBe(originalDraftId);
    expect(first.drafts[0]!.lines).toEqual(
      interrupted ? [expect.objectContaining({ quantity: 2 })] : [],
    );
    expect(uploads).toBe(0);
    await page.getByRole('button', { name: 'Close cash receipt' }).click();
    await page.reload();
    await page.getByText('Saved cash receipts', { exact: false }).click();
    await page.getByRole('button', { name: /100\.00/ }).click();
    await expect(
      page.getByRole('dialog', { name: 'Saved cash receipt', exact: true }),
    ).toContainText(number);
    await expect(page.getByRole('button', { name: 'Print cash receipt' })).toBeEnabled();
    expect((await savedCash(page)).receipts[0]!.receiptId).toBe(receiptId);
    await page.getByRole('button', { name: 'Close cash receipt' }).click();
    await context.setOffline(false);
    if (interrupted) {
      await expect.poll(async () => (await savedCash(page)).jobs[0]?.state).toBe('retry');
      await expect
        .poll(async () => (await savedCash(page)).jobs[0]!.nextAttemptAt <= Date.now())
        .toBe(true);
      await page.getByRole('button', { name: 'Synchronize cash receipts', exact: true }).click();
    }
    if (!clean) {
      await expect
        .poll(async () => (await savedCash(page)).receipts[0]?.syncState)
        .toBe('conflicted');
      expect(imports).toEqual([]);
    } else {
      if (loss !== 'none') {
        await expect
          .poll(async () => (await savedCash(page)).jobs[0]?.orderImport?.state)
          .toBe('uncertain');
        expect(imports).toHaveLength(1);
        await page.reload();
        await page.getByText('Saved cash receipts', { exact: false }).click();
        await page.getByRole('button', { name: /100\.00/ }).click();
        if (loss === 'committed') {
          expect((await savedCash(page)).jobs[0]?.orderImport?.state).toBe('uncertain');
          committedImportReadAvailable = true;
          await page.getByRole('button', { name: 'Check cash order status', exact: true }).click();
          expect(imports).toHaveLength(1);
        }
        if (loss === 'uncommitted') {
          await expect(
            page.getByRole('button', { name: 'Retry saved order synchronization', exact: true }),
          ).toBeEnabled();
          await page.getByRole('button', { name: 'Check cash order status', exact: true }).click();
          expect(imports).toHaveLength(1);
          await page
            .getByRole('button', { name: 'Retry saved order synchronization', exact: true })
            .click();
          await expect.poll(() => imports.length).toBe(2);
          expect(imports[1]).toEqual(imports[0]);
        }
      }
      await expect
        .poll(async () => (await savedCash(page)).receipts[0]?.syncState)
        .toBe('imported');
      expect((await savedCash(page)).jobs[0]?.orderImport?.state).toBe('confirmed');
      expect(imports).toHaveLength(loss === 'uncommitted' ? 2 : 1);
      expect((await savedCash(page)).receipts[0]?.acceptance?.orderId).toBe('9007199254740995');
      expect((await savedCash(page)).paid).toEqual([]);
    }
    expect((await savedCash(page)).receipts[0]!.envelope).toEqual(first.receipts[0]!.envelope);
    expect(server.size).toBe(1);
    expect(uploads).toBe(interrupted ? 2 : 1);
    expect(registrations).toBe(1);
    expect(authorizations).toBe(1);
  });
}
