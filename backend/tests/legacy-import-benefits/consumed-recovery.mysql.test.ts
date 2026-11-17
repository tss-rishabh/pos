import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AdministrationTransaction } from '../../src/modules/administration/checkins.js';
import { legacyOrderImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-adapter.js';
import {
  financialImportOperations,
  financialImportProofs,
  financialImportSourceReceipts,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import {
  benefitReceiptHash,
  couponActivationSchema,
} from '../../src/modules/legacy-order-imports/benefit-profile/contracts.js';
import { financialClock, sourceKey } from '../legacy-import-financial/fixture.js';
import { benefitFinancialFixture } from './financial-fixture.js';
import {
  correctedGoImport,
  installOriginalGoFixture,
  originalGoConfirmation,
} from './go-recovery-fixture.js';

const supplied = process.env.CHECKOUT_MYSQL_TEST_URL,
  binary = process.env.POS_IMPORT_COUPON_GO_BINARY;
describe.skipIf(!supplied || !binary)(
  'actual Go consumed benefit recovery',
  { timeout: 30000 },
  () => {
    let f: Awaited<ReturnType<typeof benefitFinancialFixture>>;
    beforeAll(async () => {
      f = await benefitFinancialFixture(supplied!);
      await installOriginalGoFixture(f);
    }, 20000);
    beforeEach(async () => {
      f.benefits.sourceProofKey = sourceKey;
      for (const table of [
        'order_tss_money',
        'order_tss_point',
        'tss_money_history',
        'tss_point_history',
        'reward_point_history',
        'gift_voucher_history',
        'referral_log',
        'pos_rewrite_membership_versions',
        'pos_rewrite_cancellation_membership_provenance',
      ])
        await f.connection.query('DELETE FROM `' + table + '`');
      await f.reset();
    });
    afterAll(async () => {
      await f?.close();
    });

    async function counts() {
      const [rows] = await f.connection.query(
        'SELECT (SELECT COUNT(*) FROM pos_transaction_logs) AS cash,(SELECT COUNT(*) FROM order_coupon_log) AS coupon,(SELECT COUNT(*) FROM pos_rewrite_checkout_projections) AS projections,(SELECT COUNT(*) FROM pos_rewrite_import_financial_proofs) AS sealed',
      );
      return rows;
    }
    it.each(['controls', 'assignments', 'deleted-assignment', 'customer-birthday'])(
      'finishes once from original Go consumption despite later %s changes',
      async (scenario) => {
        const source = f.transport();
        source.transport.confirm = async (command, order) => {
          source.calls.confirmation++;
          expect(originalGoConfirmation(f, command, order)).toEqual({
            sourceCalls: 1,
            created: 1,
            refused: 0,
          });
          if (scenario === 'controls')
            await f.connection.query(
              "UPDATE coupons SET is_deleted=1,voucher_val=99,end_date='2020-01-01 00:00:00' WHERE id=222",
            );
          if (scenario === 'assignments')
            await f.connection.query(
              'UPDATE coupons_users SET coupon_used_count=2,coupon_allowed_count=7,coupon_month_allowed_count=9',
            );
          if (scenario === 'deleted-assignment')
            await f.connection.query('DELETE FROM coupons_users');
          if (scenario === 'customer-birthday')
            await f.connection.query("UPDATE users SET birthdate='1980-01-01' WHERE id=77");
        };
        const c = await correctedGoImport(f, source.transport);
        expect(await c.queue.runOne(c.adapter)).toMatchObject({ state: 'IMPORTED' });
        const result = await c.adapter.read(c.input);
        expect(result?.status).toBe('completed');
        expect(await c.adapter.start(c.input)).toEqual(result);
        expect(source.calls).toEqual({ order: 1, confirmation: 1, publication: 1 });
        expect(await counts()).toEqual([{ cash: '1', coupon: '1', projections: '1', sealed: '1' }]);
        const [proof] = await f.db.get('writer').select().from(financialImportProofs);
        expect(proof?.data).toMatchObject({
          correction: { id: c.command.id, historicalTenderAmount: '45.00' },
          settlement: { cash: '45.00' },
          benefits: {
            activation: {
              receipt: {
                contract: 'pos-csv-coupon-consumption-v1',
                changes: [{ before: '0', after: '1' }],
              },
            },
          },
        });
        const [stock] = await f.connection.query('SELECT stock FROM product_store ORDER BY id');
        expect(stock).toEqual([{ stock: 98 }, { stock: 99 }]);
      },
    );

    it.each([
      'missing-activation',
      'tampered-activation',
      'copied-activation',
      'missing-confirmation',
      'missing-log',
      'changed-refund',
      'changed-grant',
      'changed-projection',
    ])('retains original uncertainty without repeats for %s', async (scenario) => {
      const source = f.transport();
      source.transport.confirm = async (command, order) => {
        source.calls.confirmation++;
        originalGoConfirmation(f, command, order);
        const where = and(
          eq(financialImportSourceReceipts.operationId, command.state.scope.operationId),
          eq(
            financialImportSourceReceipts.kind,
            scenario === 'missing-confirmation' ? 'confirmation' : 'coupon-consume',
          ),
        );
        if (scenario === 'missing-activation' || scenario === 'missing-confirmation')
          await f.db.get('writer').delete(financialImportSourceReceipts).where(where);
        if (scenario === 'tampered-activation')
          await f.db
            .get('writer')
            .update(financialImportSourceReceipts)
            .set({ proofHash: '0'.repeat(64) })
            .where(where);
        if (scenario === 'copied-activation') {
          const [row] = await f.db
            .get('writer')
            .select()
            .from(financialImportSourceReceipts)
            .where(where);
          const receipt = couponActivationSchema.parse(row!.proof),
            proof = { ...receipt, scope: { ...receipt.scope, operationId: randomUUID() } };
          await f.db
            .get('writer')
            .update(financialImportSourceReceipts)
            .set({ proof, proofHash: benefitReceiptHash('coupon-consumption', proof, sourceKey) })
            .where(where);
        }
        if (scenario === 'missing-log') await f.connection.query('DELETE FROM order_coupon_log');
        if (scenario === 'changed-refund')
          await f.connection.query(
            'UPDATE has_products SET amount_to_be_refunded=amount_to_be_refunded+1 WHERE order_id=5001',
          );
        if (scenario === 'changed-grant')
          await f.connection.query(
            "UPDATE order_freebies SET status='REVOKED' WHERE order_id=5001",
          );
        if (scenario === 'changed-projection')
          await f.connection.query(
            "UPDATE pos_rewrite_checkout_projections SET input_hash=REPEAT('0',64) WHERE order_id=5001",
          );
      };
      const c = await correctedGoImport(f, source.transport),
        result = await c.queue.runOne(c.adapter);
      expect(result).toMatchObject({ state: 'RECONCILING' });
      // GET/replay is observation only, even though the original Go action committed.
      const receipt = await c.adapter.read(c.input);
      expect(receipt).toMatchObject({ status: 'unknown', orderId: '5001' });
      expect(await c.adapter.start(c.input)).toEqual(receipt);
      expect(source.calls).toEqual({ order: 1, confirmation: 1, publication: 0 });
      const [cash] = await f.connection.query('SELECT COUNT(*) AS n FROM pos_transaction_logs');
      expect(cash).toEqual([{ n: '0' }]);
      expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
      const [stock] = await f.connection.query('SELECT stock FROM product_store ORDER BY id');
      expect(stock).toEqual([{ stock: 98 }, { stock: 99 }]);
      const [used] = await f.connection.query('SELECT coupon_used_count AS n FROM coupons_users');
      expect(used).toEqual([{ n: '1' }]);
    });

    it('recovers an actual lost final native commit ACK after keys/contact/catalog/counters change', async () => {
      const source = f.transport();
      source.transport.confirm = async (command, order) => {
        source.calls.confirmation++;
        originalGoConfirmation(f, command, order);
        await f.connection.query('UPDATE coupons_users SET coupon_used_count=2');
      };
      const writer = f.db.get('writer'),
        native = writer.transaction.bind(writer);
      let lost = false;
      const intercept = async <T>(
        work: (tx: AdministrationTransaction) => Promise<T>,
        options?: Parameters<typeof writer.transaction>[1],
      ): Promise<T> => {
        const result = await native(work, options),
          [rows] = await f.connection.query(
            'SELECT COUNT(*) AS n FROM pos_rewrite_import_financial_proofs',
          );
        const count = BigInt(
          z.array(z.object({ n: z.union([z.string(), z.number()]) })).parse(rows)[0]!.n,
        );
        if (!lost && count > 0n) {
          lost = true;
          f.benefits.sourceProofKey = '';
          await f.connection.query(
            "UPDATE users SET email='changed@example.test',is_block=1 WHERE id=77",
          );
          await f.connection.query('UPDATE products SET price=999');
          await f.connection.query('UPDATE coupons_users SET coupon_used_count=99');
          await f.connection.query(
            "UPDATE pos_rewrite_import_financial_source_receipts SET proof='{}',proof_hash=REPEAT('0',64) WHERE kind IN ('coupon-benefit','pos-complement','coupon-consume','confirmation')",
          );
          throw new Error('Isolated committed ACK was lost.');
        }
        return result;
      };
      const spy = vi.spyOn(writer, 'transaction').mockImplementation(intercept),
        tracked = {
          ...f,
          db: {
            ...f.db,
            get: (name: Parameters<typeof f.db.get>[0]) =>
              name === 'writer' ? writer : f.db.get(name),
          },
        };
      try {
        const c = await correctedGoImport(tracked, source.transport);
        expect(await c.queue.runOne(c.adapter)).toMatchObject({ state: 'IMPORTED' });
        expect(lost).toBe(true);
        const result = await c.adapter.read(c.input);
        expect(result?.status).toBe('completed');
        const recovery = legacyOrderImportFinancialAdapter(
          f.config,
          tracked.db,
          { secret: f.options.secret, clock: () => financialClock },
          source.transport,
        );
        expect(await recovery.read(c.input)).toEqual(result);
        expect(await recovery.start(c.input)).toEqual(result);
        const [operation] = await f.db
          .get('writer')
          .select()
          .from(financialImportOperations)
          .where(eq(financialImportOperations.id, c.input.operationId));
        expect(operation?.state.status).toBe('completed');
        expect(source.calls).toEqual({ order: 1, confirmation: 1, publication: 1 });
        expect(await counts()).toEqual([{ cash: '1', coupon: '1', projections: '1', sealed: '1' }]);
      } finally {
        spy.mockRestore();
      }
    });
  },
);
