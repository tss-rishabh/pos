import { expect, test } from '../support/fixtures';
import type { CheckoutClearance } from '../../src/api/checkout-clearance';
import { signIn } from '../support/login';

for (const interrupted of [false, true]) {
  test(`customer lookup, ${interrupted ? 'interrupted' : 'verified'} registration, connection and detachment preserve the cart contract`, async ({
    page,
    network,
  }) => {
    // The legacy "User Not Found." lookup is a 404 on purpose.
    network.expectFailure({
      method: 'POST',
      path: '/api/v1/stores/1/customer-lookups',
      outcome: 404,
    });
    if (interrupted)
      network.expectFailure({
        method: 'POST',
        path: /^\/api\/v1\/stores\/1\/checkout-sessions\/[0-9a-f-]{36}\/customer-registrations$/,
        outcome: 503,
      });
    const checkoutId = crypto.randomUUID();
    let draftId = '',
      draftVersion = 0,
      version = 0,
      manifest: { productId: string; quantity: number }[] = [],
      registrationId: string | null = null,
      customerId: string | null = null,
      cleared = false,
      creations = 0,
      reconciliations = 0,
      lookups = 0,
      initializations = 0;
    let phase: 'open' | 'cleared' = 'open',
      lastClear: CheckoutClearance | null = null;
    let registration: {
      id: string;
      status: string;
      expiresAt: number;
      retryAt: number;
      attemptsRemaining: number;
      customerId: string | null;
      verifiedAt: number | null;
      deliveries: { channel: string; status: string }[];
    } | null = null;
    const operations = new Map<string, { status: string; errorCode?: string }>();
    const cart = () => ({
      products: {
        items: cleared
          ? []
          : [{ prod_id: manifest[0]?.productId || '1', quantity: 1, prod_type: 1 }],
      },
      giftvouchers: { items: [] },
      meta: { items: [{ name: 'calculations', products_total: 100, total: 100 }] },
    });
    const state = () => ({
      id: checkoutId,
      draftId,
      draftVersion,
      draftImport: {
        lineItems: manifest,
        completedProductIds: version ? manifest.map((line) => line.productId) : [],
        status: version ? 'complete' : 'pending',
      },
      storeId: '1',
      counterId: '1',
      version,
      customerId,
      registrationId,
      verifiedCustomerUntil: customerId ? Date.now() + 15 * 60000 : null,
      phase,
      lastClear,
      orderId: null,
      busyOperationId: null,
      giftCards: {},
      cart: version ? cart() : null,
      quote: null,
    });
    await page.route('**/api/v1/stores/1/customer-lookups', async (route) => {
      lookups++;
      expect(route.request().method()).toBe('POST');
      expect(new URL(route.request().url()).search).toBe('');
      // Legacy "Fetch the User" posts mobile and email together (create_order.html:2905-3033).
      expect(route.request().postDataJSON()).toEqual({
        counterId: '1',
        telephone: '',
        email: 'lookup@example.com',
      });
      return route.fulfill({
        status: 404,
        json: { error: { code: 'CUSTOMER_NOT_FOUND', message: 'User Not Found.' } },
      });
    });
    await page.route('**/api/v1/stores/1/checkout-sessions**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (request.method() === 'GET') {
        if (path.includes('/operations/'))
          return route.fulfill({
            json: operations.get(path.split('/').at(-1)!) || { status: 'inflight' },
          });
        if (path.endsWith('/discount-approval'))
          return route.fulfill({
            json: {
              status: 'not-required',
              amount: '0.00',
              productsTotal: '100.00',
              challengeId: null,
              expiresAt: null,
              retryAt: null,
              delivered: 0,
              pending: 0,
            },
          });
        if (registration?.status === 'pending')
          registration.deliveries = [
            { channel: 'sms', status: 'delivered' },
            { channel: 'whatsapp', status: 'pending' },
          ];
        return route.fulfill({
          json: { ...state(), registration, registrationRequestRecovery: false },
        });
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      if (path.endsWith('/checkout-sessions')) {
        draftId = String(body.draftId);
        draftVersion = Number(body.draftVersion);
        manifest = body.lineItems as typeof manifest;
        return route.fulfill({ status: 201, json: state() });
      }
      expect(body.expectedVersion).toBe(version);
      const operationId = String(body.operationId);
      if (path.endsWith('/draft-initializations')) initializations++;
      else if (path.endsWith('/customer-registration-challenges')) {
        expect(body.details).toEqual({
          name: 'New Browser Customer',
          telephone: '9000000001',
          email: '',
          birthdate: '1990-01-02',
          customerType: 'B2B',
          gstin: '29ABCDE1234F1Z5',
        });
        expect(body).not.toHaveProperty('self_verify');
        registrationId = operationId;
        registration = {
          id: registrationId,
          status: 'pending',
          expiresAt: Date.now() + 600000,
          retryAt: Date.now() + 60000,
          attemptsRemaining: 5,
          customerId: null,
          verifiedAt: null,
          deliveries: [
            { channel: 'sms', status: 'pending' },
            { channel: 'whatsapp', status: 'pending' },
          ],
        };
      } else if (path.endsWith('/customer-registration-challenges/verifications')) {
        expect(body.code).toBe('111111');
        expect(registration?.deliveries[0]?.status).toBe('delivered');
        registration!.status = 'verified';
        registration!.verifiedAt = Date.now();
      } else if (path.endsWith('/customer-registrations')) {
        creations++;
        expect(registration?.status).toBe('verified');
        if (interrupted) {
          registration!.status = 'uncertain';
          operations.set(operationId, {
            status: 'rejected',
            errorCode: 'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN',
          });
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'CUSTOMER_REGISTRATION_OUTCOME_UNCERTAIN',
                message: 'Registration may have completed. Reconcile its saved reference.',
              },
            },
          });
        }
        registration!.status = 'registered';
        registration!.customerId = '8101';
      } else if (path.endsWith('/customer-registration-reconciliations')) {
        reconciliations++;
        expect(creations).toBe(1);
        expect(registration?.status).toBe('uncertain');
        registration!.status = 'registered';
        registration!.customerId = '8101';
      } else if (path.endsWith('/customer')) {
        expect(request.method()).toBe('PUT');
        expect(body.customerId).toBe('8101');
        customerId = '8101';
      } else if (path.endsWith('/customer-detachments')) {
        customerId = null;
        registration = null;
        registrationId = null;
        cleared = true;
        phase = 'cleared';
        lastClear = {
          status: 'cleared',
          checkoutId,
          operationId,
          operatorId: request.headers()['x-operator-id'] || '1',
          storeId: '1',
          counterId: '1',
          draftId,
          draftVersion,
          reason: 'customer-detach',
          clearedAt: Date.now(),
        };
      } else throw new Error('Unexpected customer fixture mutation.');
      version++;
      operations.set(operationId, { status: 'succeeded' });
      return route.fulfill({
        json: { status: 'succeeded', state: state(), result: registration ? { registration } : {} },
      });
    });
    await page.goto('/');
    await signIn(page);
    await page
      .getByRole('button', { name: /^Add .+ to sale$/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Review sale', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm prices online' }).click();
    await page.getByText('Customer and verification', { exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill('lookup@example.com');
    const findCustomer = page.getByRole('button', { name: 'Fetch the User', exact: true });
    // A dispatched click does not wait for the async lookup or its route handler.
    const lookupResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/stores/1/customer-lookups',
    );
    await findCustomer.click();
    const response = await lookupResponse;
    // An unknown customer is the legacy "User Not Found." (users/views.py:656-659).
    expect(response.status()).toBe(404);
    expect(await response.finished()).toBeNull();
    await expect(page.getByText('User Not Found.', { exact: false })).toBeVisible();
    await expect(findCustomer).toBeEnabled();
    expect(lookups).toBe(1);
    await page.getByText('Create a customer account', { exact: true }).click();
    await page.getByLabel('Customer name', { exact: true }).fill('New Browser Customer');
    await page.getByLabel('Customer mobile', { exact: true }).fill('9000000001');
    await page.getByLabel('Date of birth (optional)', { exact: true }).fill('1990-01-02');
    await page.getByLabel('Customer type', { exact: true }).selectOption('B2B');
    await page.getByLabel('Customer GSTIN', { exact: true }).fill('29ABCDE1234F1Z5');
    await page.getByRole('button', { name: 'Get OTP', exact: true }).click();
    await expect(page.getByText('Registration pending.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Check registration status', exact: true }).click();
    await page.getByLabel('One Time Password (OTP)', { exact: true }).fill('111111');
    // Legacy "Verify with OTP" verifies, registers and connects in one action
    // (create_order.html:4954-5024).
    await page.getByRole('button', { name: 'Verify with OTP', exact: true }).click();
    if (interrupted) {
      await expect(
        page.getByText('Registration may have completed. Reconcile its saved reference.', {
          exact: false,
        }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Check action status', exact: false }).click();
      await page.getByRole('button', { name: 'Close checkout' }).click();
      await page.reload();
      await page.getByRole('button', { name: 'Review sale', exact: true }).click();
      // Reconciliation connects the registered customer, as the original action would have.
      await page.getByRole('button', { name: 'Reconcile registration', exact: true }).click();
    }
    const dialog = page.getByRole('dialog', { name: 'Confirm the sale' });
    await expect(dialog.getByText('Customer 8101', { exact: false })).toBeVisible();
    expect(cart().products.items[0]?.quantity).toBe(1);
    await page.getByText('Customer and verification', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Detach customer and clear checkout', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByText('Checkout cleared. Ready for a new sale.', { exact: true }),
    ).toBeVisible();
    expect(cart().products.items).toEqual([]);
    const persisted = await page.evaluate(() => Object.values(localStorage).join('\n'));
    for (const sensitive of ['9000000001', 'New Browser Customer', '29ABCDE1234F1Z5', '111111'])
      expect(persisted).not.toContain(sensitive);
    // Recheck after the complete registration/recovery/clear lifecycle so a
    // delayed duplicate lookup cannot pass the earlier response barrier.
    expect(lookups).toBe(1);
    expect(initializations).toBe(1);
    expect(creations).toBe(1);
    expect(reconciliations).toBe(interrupted ? 1 : 0);
  });
}
