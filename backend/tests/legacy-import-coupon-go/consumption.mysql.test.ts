import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { couponFixture, sourceKey } from './fixture.js';
import {
  benefitReceiptHash,
  couponActivationSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { assertNativeCsvBenefits } from '../../src/modules/legacy-order-imports/benefit-profile/native.js';
import { financialImportSourceReceipts } from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template || !process.env.POS_IMPORT_COUPON_GO_BINARY)(
  'real Go coupon deduction and immutable source consumption',
  () => {
    let f: Awaited<ReturnType<typeof couponFixture>>;
    beforeAll(async () => {
      f = await couponFixture(template!);
    }, 30000);
    beforeEach(async () => {
      await f.reset();
    });
    afterAll(async () => {
      await f?.close();
    });
    async function counts() {
      const [rows] = await f.connection.query(
        'SELECT CAST(id AS CHAR) AS id,CAST(coupon_used_count AS CHAR) AS used FROM coupons_users ORDER BY id',
      );
      return rows;
    }
    async function receipts() {
      return f.db.get('writer').select().from(financialImportSourceReceipts);
    }
    async function activation(staged: Awaited<ReturnType<typeof f.stage>>) {
      const all = await receipts(),
        consumed = all.find((row) => row.kind === 'coupon-consume'),
        confirmed = all.find((row) => row.kind === 'confirmation');
      expect(consumed).toBeDefined();
      expect(confirmed).toBeDefined();
      const value = couponActivationSchema.parse(consumed!.proof);
      expect(consumed!.proofHash).toBe(benefitReceiptHash('coupon-consumption', value, sourceKey));
      expect(value.sourceConfirmationHash).toBe(confirmed!.proofHash);
      expect(value.stagedReceiptHash).toBe(staged.coupon.seal);
      await f.db.get('writer').transaction((tx) =>
        assertNativeCsvBenefits(tx, {
          ...staged,
          sourceProofKey: sourceKey,
          phase: 'settled',
          activation: {
            value,
            seal: consumed!.proofHash,
            confirmationHash: confirmed!.proofHash,
          },
        }),
      );
      return value;
    }
    it.each([false, true])(
      'captures actual pinned Python stage → original Go Apply → strict Node verification (unit mode=%s)',
      async (unitMode) => {
        const staged = await f.stage({ unitMode });
        expect(f.go(staged)).toEqual({ sourceCalls: 1, created: 1, refused: 0 });
        const value = await activation(staged);
        expect(value.changes).toMatchObject([{ id: '9007199254741500', before: '0', after: '1' }]);
        expect(await counts()).toEqual([{ id: '9007199254741500', used: '1' }]);
        expect(f.go(staged, { replay: true })).toEqual({ sourceCalls: 0, created: 0, refused: 0 });
        const [logs] = await f.connection.query('SELECT COUNT(*) AS n FROM order_coupon_log');
        expect(logs).toMatchObject([{ n: '1' }]);
        const [native] = await f.connection.query('SELECT payment_status,order_status FROM orders');
        expect(native).toMatchObject([{ payment_status: 1, order_status: 1 }]); // source confirmation, not a paid receipt
      },
      30000,
    );
    it('serializes20 confirmation contenders with one actual source deduction and one receipt', async () => {
      const staged = await f.stage({ duplicates: true });
      expect(f.go(staged, { contenders: 20 })).toEqual({ sourceCalls: 1, created: 1, refused: 0 });
      expect((await activation(staged)).changes).toMatchObject([
        { before: '0', after: '1' },
        { before: '3', after: '4' },
      ]);
      expect(await counts()).toEqual([
        { id: '9007199254741500', used: '1' },
        { id: '9007199254741501', used: '4' },
      ]);
    }, 30000);
    it('retains the source non-user-specific zero-assignment/log behavior', async () => {
      const staged = await f.stage({ empty: true });
      expect(f.go(staged)).toHaveProperty('created', 1);
      expect((await activation(staged)).changes).toEqual([]);
    });
  it('preserves native counters above 2^53 as exact decimal strings', async () => {
      const staged = await f.stage({ used: '9007199254740993' });
      expect(f.go(staged)).toHaveProperty('created', 1);
      expect((await activation(staged)).changes).toMatchObject([
        { before: '9007199254740993', after: '9007199254740994' },
      ]);
      expect(f.go(staged, { replay: true })).toEqual({ sourceCalls: 0, created: 0, refused: 0 });
    });
    it.each([
      'unselected',
      'missing-stage',
      'stage-hash',
      'scope',
      'control',
      'counter',
      'extra-assignment',
      'existing-log',
    ] as const)('refuses %s before source work', async (change) => {
      const staged = await f.stage();
      if (change === 'missing-stage')
        await f.connection.query(
          "DELETE FROM pos_rewrite_import_financial_source_receipts WHERE kind='coupon-benefit'",
        );
      if (change === 'stage-hash')
        await f.connection.query(
          "UPDATE pos_rewrite_import_financial_source_receipts SET proof_hash=REPEAT('f',64) WHERE kind='coupon-benefit'",
        );
      if (change === 'scope') {
        const changed = {
          ...staged.coupon.value,
          scope: { ...staged.coupon.value.scope, counterId: '3' },
        };
        await f.db
          .get('writer')
          .update(financialImportSourceReceipts)
          .set({ proof: changed, proofHash: benefitReceiptHash('coupon', changed, sourceKey) })
          .where(
            and(
              eq(financialImportSourceReceipts.operationId, staged.state.scope.operationId),
              eq(financialImportSourceReceipts.kind, 'coupon-benefit'),
            ),
          );
      }
      if (change === 'control')
        await f.connection.query('UPDATE coupons SET voucher_val=11 WHERE id=222');
      if (change === 'counter')
        await f.connection.query('UPDATE coupons_users SET coupon_used_count=1');
      if (change === 'extra-assignment')
        await f.native.insert('coupons_users', {
          id: '9007199254741501',
          user_id: 77,
          c_id: 222,
          coupon_allowed_count: 5,
          coupon_used_count: 0,
          coupon_month_allowed_count: 5,
        });
      if (change === 'existing-log')
        await f.native.insert('order_coupon_log', {
          id: 1,
          user_id: 77,
          order_id: 5001,
          coupon_id: 222,
          status: 1,
        });
      expect(f.go(staged, { reject: true, selected: change !== 'unselected' })).toEqual({
        sourceCalls: 0,
        created: 0,
        refused: 1,
      });
      const [stock] = await f.connection.query('SELECT stock FROM product_store ORDER BY id');
      expect(stock).toEqual([{ stock: 100 }, { stock: 100 }]);
      expect(
        (await receipts()).filter(
          (row) => row.kind === 'coupon-consume' || row.kind === 'confirmation',
        ),
      ).toHaveLength(0);
    });
    it.each([
      'double-deduction',
      'missing-log',
      'wrong-log',
      'header',
      'line',
      'allowance',
    ] as const)('rolls back late %s alongside stock/status/projections', async (mutation) => {
      const staged = await f.stage();
      expect(f.go(staged, { mutation, reject: true })).toEqual({
        sourceCalls: 1,
        created: 0,
        refused: 1,
      });
      expect(await counts()).toEqual([{ id: '9007199254741500', used: '0' }]);
      const [stock] = await f.connection.query('SELECT stock FROM product_store ORDER BY id');
      expect(stock).toEqual([{ stock: 100 }, { stock: 100 }]);
      for (const table of [
        'pos_rewrite_checkout_projections',
        'pos_rewrite_checkout_projection_lines',
        'order_coupon_log',
      ]) {
        const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM ' + table);
        expect(rows).toMatchObject([{ n: '0' }]);
      }
      const [order] = await f.connection.query('SELECT order_status,payment_status FROM orders');
      expect(order).toMatchObject([{ order_status: 0, payment_status: 0 }]);
      expect(
        (await receipts()).filter(
          (row) => row.kind === 'coupon-consume' || row.kind === 'confirmation',
        ),
      ).toHaveLength(0);
    });
    it('rolls back the original deduction when the final immutable consumption insert fails', async () => {
      const staged = await f.stage();
      await f.connection.query(
        "CREATE TRIGGER coupon_proof_failure BEFORE INSERT ON pos_rewrite_import_financial_source_receipts FOR EACH ROW BEGIN IF NEW.kind='coupon-consume' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated proof rollback'; END IF; END",
      );
      try {
        expect(f.go(staged, { reject: true })).toEqual({ sourceCalls: 1, created: 0, refused: 1 });
      } finally {
        await f.connection.query('DROP TRIGGER coupon_proof_failure');
      }
      expect(await counts()).toEqual([{ id: '9007199254741500', used: '0' }]);
      expect(
        (await receipts()).filter(
          (row) => row.kind === 'confirmation' || row.kind === 'coupon-consume',
        ),
      ).toHaveLength(0);
    });
    it('rechecks a concurrently committed native coupon use after waiting for the customer lock', async () => {
      const staged = await f.stage();
      await f.connection.beginTransaction();
      await f.connection.query('SELECT id FROM users WHERE id=77 FOR UPDATE');
      await f.connection.query('UPDATE coupons_users SET coupon_used_count=1');
      const pending = f.goAsync(staged, { reject: true });
      try {
        await new Promise((resolve) => setTimeout(resolve, 120));
        await f.connection.commit();
        expect(await pending).toContain('"sourceCalls":0');
      } catch (error) {
        await f.connection.rollback();
        throw error;
      }
      expect(await counts()).toEqual([{ id: '9007199254741500', used: '1' }]);
    });
    it('does not upgrade the shared coupon control lock held by another customer reader', async () => {
      const staged = await f.stage();
      await f.connection.beginTransaction();
      try {
        await f.connection.query('SELECT id FROM coupons WHERE id=222 FOR SHARE');
        expect(await f.goAsync(staged)).toContain('"created":1');
      } finally {
        await f.connection.rollback();
      }
      await activation(staged);
    });
    it('reconciles original consumption after unrelated later coupon use without a second deduction', async () => {
      const staged = await f.stage();
      f.go(staged);
      await f.connection.query('UPDATE coupons_users SET coupon_used_count=2');
      expect(f.go(staged, { replay: true })).toEqual({ sourceCalls: 0, created: 0, refused: 0 });
      const value = await receipts();
      expect(value.filter((row) => row.kind === 'coupon-consume')).toHaveLength(1);
      expect(await counts()).toEqual([{ id: '9007199254741500', used: '2' }]);
    });
    it.each(['missing', 'hash', 'delta', 'confirmation-body'] as const)(
      'rejects changed %s replay evidence without reapplying source',
      async (change) => {
        const staged = await f.stage();
        f.go(staged);
        if (change === 'missing')
          await f.connection.query(
            "DELETE FROM pos_rewrite_import_financial_source_receipts WHERE kind='coupon-consume'",
          );
        if (change === 'hash')
          await f.connection.query(
            "UPDATE pos_rewrite_import_financial_source_receipts SET proof_hash=REPEAT('f',64) WHERE kind='coupon-consume'",
          );
        if (change === 'confirmation-body')
          await f.connection.query(
            "UPDATE pos_rewrite_import_financial_source_receipts SET proof=JSON_SET(proof,'$.confirmedAt',1) WHERE kind='confirmation'",
          );
        if (change === 'delta') {
          const row = (await receipts()).find((row) => row.kind === 'coupon-consume')!,
            value = couponActivationSchema.parse(row.proof);
          value.changes[0]!.after = '2';
          await f.db
            .get('writer')
            .update(financialImportSourceReceipts)
            .set({
              proof: value,
              proofHash: benefitReceiptHash('coupon-consumption', value, sourceKey),
            })
            .where(eq(financialImportSourceReceipts.id, row.id));
        }
        expect(f.go(staged, { reject: true, replay: true })).toEqual({
          sourceCalls: 0,
          created: 0,
          refused: 1,
        });
        expect(await counts()).toEqual([{ id: '9007199254741500', used: '1' }]);
      },
    );
    it('never sends Shopify method15 through ordinary confirmation or creates coupon consumption', async () => {
      const staged = await f.stage({ kind: 'shopify' });
      expect(f.go(staged, { reject: true })).toHaveProperty('sourceCalls', 0);
      expect(await counts()).toEqual([{ id: '9007199254741500', used: '0' }]);
      const [logs] = await f.connection.query('SELECT COUNT(*) AS n FROM order_coupon_log');
      expect(logs).toMatchObject([{ n: '0' }]);
    });
  },
);
