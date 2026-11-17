import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicScreeningFixture, run } from './native-fixture.js';
import { readPublicScreeningCreation } from '../../src/modules/checkout/screening-writer/proof.js';
import { sourceKey } from '../legacy-import-financial/fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('public Node POS source frame on disposable MySQL', () => {
  let f: Awaited<ReturnType<typeof publicScreeningFixture>>;
  beforeAll(async () => {
    f = await publicScreeningFixture(template!);
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
  });
  it.each([false, true])(
    'commits literal source HP/markers with separate public receipt; unit mode %s',
    async (unitMode) => {
      const prepared = await f.prepare(2, unitMode),
        result = run(prepared.value);
      expect(result).toMatchObject({ result: { method: 14, isValid: true, name: 'placed_order' } });
      const proof = await f.db
        .get('writer')
        .transaction((tx) =>
          readPublicScreeningCreation(tx, prepared.state.busyOperationId!, sourceKey),
        );
      expect(proof).toMatchObject({
        actorId: '1',
        customerId: '77',
        method: 14,
        lineItemsEnabled: unitMode,
      });
      expect(proof?.lines).toHaveLength(unitMode ? 2 : 1);
      const [rows] = await f.connection.query(
        'SELECT data FROM pos_rewrite_import_screening_reservations',
      );
      expect(rows).toMatchObject([
        { data: { kind: 'pos', phase: 'BOUND', markerRows: unitMode ? 2 : 1 } },
      ]);
      const [count] = await f.connection.query(
        'SELECT COUNT(*) AS n FROM pos_rewrite_import_financial_operations',
      );
      expect(count).toMatchObject([{ n: '0' }]);
    },
  );
  it('rolls every literal source commit back on a late failure', async () => {
    const prepared = await f.prepare();
    expect(run({ ...prepared.value, lateFailure: true })).toMatchObject({
      code: 'SCREENING_WRITER_FIXTURE_LATE_FAILURE',
    });
    for (const table of [
      'orders',
      'has_products',
      'spiderman_screening_orders',
      'pos_rewrite_import_screening_reservations',
      'pos_rewrite_public_screening_orders',
      'pos_rewrite_public_screening_effects',
    ]) {
      const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM `' + table + '`');
      expect(rows).toMatchObject([{ n: '0' }]);
    }
  });
  it.each(['contact', 'actor', 'checkin', 'quote', 'busy'] as const)(
    'refuses changed current %s before source writes',
    async (field) => {
      const prepared = await f.prepare();
      if (field === 'contact')
        await f.connection.query("UPDATE users SET telephone='9000000000' WHERE id=77");
      if (field === 'actor') await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      if (field === 'checkin')
        await f.connection.query(
          "UPDATE pos_rewrite_operator_checkins SET expires_at='2026-06-14 23:59:59'",
        );
      if (field === 'quote')
        await f.connection.query(
          "UPDATE pos_rewrite_checkout_sessions SET state=JSON_SET(state,'$.quote.products.items[0].price',26)",
        );
      if (field === 'busy')
        await f.connection.query(
          "UPDATE pos_rewrite_checkout_sessions SET state=JSON_SET(state,'$.busyOperationId',NULL)",
        );
      expect(run(prepared.value)).toMatchObject({ code: 'SCREENING_WRITER_SCOPE_CHANGED' });
      const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM orders');
      expect(rows).toMatchObject([{ n: '0' }]);
    },
  );
});
