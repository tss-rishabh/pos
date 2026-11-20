import { expect, test } from '@playwright/test';
import { closeDesktop, launchDesktop, ledger, signIn, uat } from './support';

/**
 * One-off: clear a checkout an interrupted UAT run left open, exactly as the app's "Clear checkout
 * and start a new sale" does (POST …/clear as the same operator). This releases the customer's
 * cart lease. The checkout id comes from W26_CLEAR_CHECKOUT.
 */
test('clear an abandoned UAT checkout', async () => {
  const checkoutId = process.env.W26_CLEAR_CHECKOUT ?? '';
  expect(checkoutId).toMatch(/^[0-9a-f-]{36}$/);
  const desktop = await launchDesktop('clear-abandoned');
  try {
    await signIn(desktop.page);
    await expect(desktop.page.getByRole('heading', { name: 'The counter.' })).toBeVisible();
    const result = await desktop.page.evaluate(
      async ([id, operatorId, storeId]) => {
        const base = `/api/v1/stores/${storeId}/checkout-sessions/${id}`;
        const headers = { 'content-type': 'application/json', 'X-Operator-ID': operatorId };
        const state = (await (await fetch(base, { headers, credentials: 'include' })).json()) as {
          data?: { version?: number; phase?: string };
          version?: number;
          phase?: string;
        };
        const before = state.data?.phase ?? state.phase ?? null;
        const reply = await fetch(base + '/clear', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            expectedVersion: state.data?.version ?? state.version,
          }),
        });
        const body = (await reply.json().catch(() => null)) as { status?: string } | null;
        return { before, status: reply.status, outcome: body?.status ?? null };
      },
      [checkoutId, uat.operatorId, uat.storeId] as const,
    );
    ledger({ kind: 'checkout-clear', checkoutId, store: uat.storeId, ...result });
    console.log(JSON.stringify(result));
    expect(result.status).toBeLessThan(300);
  } finally {
    await closeDesktop(desktop);
  }
});
