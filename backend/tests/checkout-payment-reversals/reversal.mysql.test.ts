import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { RowDataPacket } from 'mysql2/promise';
import { collectionSnapshot } from '../../src/modules/finance/service.js';
import { cashLedgerService, ledgerOptions } from '../../src/modules/finance/ledger.js';
import { reportService } from '../../src/modules/reports.js';
import { AppError } from '../../src/domain/errors.js';
import { registerEventCatalog, resourceRoutes } from '../../src/observability/events.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { paymentService } from '../../src/modules/checkout/payments/service.js';
import { paymentRepository } from '../../src/modules/checkout/payments/repository.js';
import type {
  PaymentGateway,
  PaymentInput,
  PaymentAttempt,
} from '../../src/modules/checkout/payments/contracts.js';
import { paymentReversalRepository } from '../../src/modules/checkout/payment-reversals/repository.js';
import {
  paymentReversalContract,
  paymentCorrectionFinanceContract,
  type PaymentReversalInput,
} from '../../src/modules/checkout/payment-reversals/contracts.js';
import { paymentCorrectionEvidence } from '../../src/modules/checkout/payment-reversals/evidence.js';
import { paymentCorrectionCashProjection } from '../../src/modules/checkout/payment-reversals/cash-projection.js';
import { registerPaymentReversals } from '../../src/modules/checkout/payment-reversals/routes.js';
import {
  checkoutProjectionContract,
  checkoutHeaderHashSql,
  checkoutLineHashSql,
} from '../../src/modules/checkout/projection.js';
import { customerConsentContract } from '../../src/modules/checkout/customer-consent-proof.js';
import {
  refundAllocationContract,
  refundSourcePatchHash,
} from '../../src/modules/checkout/refund-allocation.js';
import { operator } from '../checkout/fixtures.js';
import { reversalMysqlFixture } from './mysql-fixture.js';

describe.skipIf(!process.env.CHECKOUT_MYSQL_TEST_URL)(
  'proved recorded cash corrections on isolated native MySQL',
  { timeout: 15000 },
  () => {
    let native: Awaited<ReturnType<typeof reversalMysqlFixture>>,
      payments: ReturnType<typeof paymentService>,
      reversals: ReturnType<typeof paymentReversalRepository>,
      original: Awaited<ReturnType<typeof payments.start>>,
      time: Temporal.Instant,
      today: string;
    const manager = { ...operator, role: 2 as const },
      orderId = '9007199254740993';
    const projection = {
      checkoutProjectionContract,
      checkoutProjectionKey: 'native-isolated-projection-proof-key-'.repeat(2),
      refundAllocationContract,
      refundSourcePatchHash,
    };
    const neverProvider: PaymentGateway = {
      configured() {},
      async start() {
        throw new Error('No provider charge permitted.');
      },
      async status() {
        throw new Error('No provider enquiry permitted.');
      },
      async cancel() {
        throw new Error('No provider cancellation permitted.');
      },
    };
    const options = () => ({
      hashSecret: native.config.SESSION_SECRET,
      projection,
      contract: paymentReversalContract,
      financeContract: paymentCorrectionFinanceContract,
      clock: () => time,
    });
    const paymentInput = (): PaymentInput => ({
      operationId: crypto.randomUUID(),
      channel: 'cash',
      onlineAmount: '0.00',
      cashAmount: '100.00',
      cashReceived: '150.00',
    });
    async function rows(query: string, params: readonly (string | number)[] = []) {
      const [result] = await native.connection.execute<RowDataPacket[]>(query, [...params]);
      return result;
    }
    async function input(): Promise<PaymentReversalInput> {
      const context = await reversals.context(manager, '1', orderId);
      expect(context.blocker).toBeNull();
      expect(context.eligible).toBe(true);
      return {
        operationId: crypto.randomUUID(),
        originalPaymentId: context.originalPaymentId!,
        counterId: '3',
        snapshotHash: context.snapshotHash!,
        cashReturnReceiptId: crypto.randomUUID(),
        returnedCash: '100.00',
        confirmCashReturned: true,
        confirmNoHandover: true,
        reason: 'customer-payment-correction',
      };
    }
    async function immutable() {
      return {
        user: await rows(
          'SELECT CAST(tss_money AS CHAR) AS money,CAST(tss_points AS CHAR) AS points,CAST(cashback AS CHAR) AS cashback FROM users WHERE id=1001',
        ),
        stock: await rows('SELECT stock,is_avail,is_del FROM product_store WHERE product_id=10'),
        membership: await rows('SELECT entity,attribute,value,is_active FROM user_eav'),
        header: await rows('SELECT * FROM pos_rewrite_checkout_projections'),
        consent: await rows('SELECT * FROM pos_rewrite_checkout_customer_consents'),
        lines: await rows('SELECT * FROM pos_rewrite_checkout_projection_lines'),
        audits: await rows('SELECT * FROM amount_to_be_refunded_log'),
      };
    }
    beforeAll(async () => {
      native = await reversalMysqlFixture(process.env.CHECKOUT_MYSQL_TEST_URL!);
      await native.fixture.insert('pos_user', { id: 44, role: 2, user_type: 1, is_active: 1 });
      await native.fixture.insert('stores', {
        id: 1,
        store_name: 'Fixture store',
        location_code: 'FIX',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', { id: 3, store_id: 1, is_active: 1 });
      await native.fixture.insert('user_stores', { django_user_id: 44, store_id: 1 });
      await native.fixture.insert('users', {
        id: 777,
        pos_admin_id: 44,
        email: 'operator.fixture@example.test',
        status: 1,
        is_block: 0,
        is_disabled: 0,
      });
      await native.fixture.insert('users', {
        id: 1001,
        email: 'customer.fixture@example.test',
        status: 1,
        is_block: 0,
        is_disabled: 0,
        tss_money: 190,
        tss_points: 40,
        cashback: 23,
      });
      await native.fixture.insert('user_eav', {
        entity: 'customer.fixture@example.test',
        attribute: 'exclusive_member',
        value: '2030-01-01 00:00:00',
        is_active: 1,
      });
      await native.fixture.insert('products', { id: 10, prod_type: 1 });
      await native.fixture.insert('product_store', {
        id: 10,
        product_id: 10,
        store_id: 1,
        stock: 37,
        is_avail: 1,
        is_del: 0,
      });
      await native.fixture.insert('order_status', { id: 3, order_status: 'DELIVERED' });
      await native.fixture.insert('payment_status', { id: 1, payment_status: 'Pending' });
      await native.fixture.insert('payment_status', { id: 4, payment_status: 'Paid' });
      await checkInService(native.db, native.config).set(manager, '1', '3');
    }, 30000);
    afterAll(async () => native?.close());
    beforeEach(async () => {
      for (const table of [
        'pos_rewrite_payment_correction_close_impacts',
        'pos_rewrite_payment_correction_cash',
        'pos_rewrite_payment_reversals',
        'pos_rewrite_payment_correction_orders',
        'pos_rewrite_payment_outbox',
        'pos_rewrite_payment_attempts',
        'pos_rewrite_checkout_customer_consents',
        'pos_rewrite_checkout_projection_lines',
        'pos_rewrite_checkout_projections',
        'pos_rewrite_return_operations',
        'pos_terminal_transactions',
        'return_orders',
        'comments',
        'pos_transaction_logs',
        'store_day_close',
        'store_cash_opening_balance',
        'store_day_banking',
        'gift_vouchers',
        'amount_to_be_refunded_log',
        'has_products',
        'order_stores',
        'orders',
      ])
        await native.connection.query(`DELETE FROM ${table}`);
      await native.connection.query(
        'UPDATE pos_user SET role=2,user_type=1,is_active=1 WHERE id=44',
      );
      await native.connection.query("UPDATE stores SET category='IN_HOUSE' WHERE id=1");
      today = Temporal.Now.zonedDateTimeISO('Asia/Kolkata').toPlainDate().toString();
      time = Temporal.PlainDateTime.from(`${today}T12:00:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await native.fixture.insert('orders', {
        id: orderId,
        order_ref_no: 'FIXTURE-REVERSAL-001',
        user_id: 1001,
        payment_method: 14,
        pay_amt: 100,
        payment_status: 1,
        order_status: 1,
        ship_date: '0000-00-00 00:00:00',
        ret_ex_request_date: '0000-00-00 00:00:00',
        created_at: `${today} 10:00:00`,
      });
      await native.fixture.insert('order_stores', {
        order_id: orderId,
        store_id: 1,
        counter_id: 3,
      });
      await native.fixture.insert('has_products', {
        id: '9007199254740994',
        order_id: orderId,
        prod_id: 10,
        qty: 2,
        price: 50,
        status: 'PLACED',
        amount_to_be_refunded: 100,
        is_order_shipped: 0,
        is_order_out_for_delivery: 0,
        is_order_delivered: 0,
        is_return_cancel: 0,
      });
      await native.fixture.insert('amount_to_be_refunded_log', {
        order_id: orderId,
        prod_id: 10,
        has_product_id: '9007199254740994',
        amount_to_be_refunded: 100,
      });
      await native.connection.execute(
        `INSERT INTO pos_rewrite_checkout_projections SELECT orders.id,1,3,orders.user_id,${checkoutHeaderHashSql},1,?,? FROM orders WHERE id=?`,
        [checkoutProjectionContract, `${today} 10:00:00`, orderId],
      );
      await native.connection.execute(
        `INSERT INTO pos_rewrite_checkout_projection_lines SELECT has_products.order_id,has_products.id,has_products.prod_id,has_products.qty,${checkoutLineHashSql} FROM has_products WHERE order_id=?`,
        [orderId],
      );
      await native.connection.execute(
        `INSERT INTO pos_rewrite_checkout_customer_consents (order_id,store_id,counter_id,user_id,operator_id,input_hash,required,accepted_at_ms,contract_version) SELECT orders.id,1,3,orders.user_id,44,${checkoutHeaderHashSql},0,?,? FROM orders WHERE id=?`,
        [Date.now() - 1000, customerConsentContract, orderId],
      );
      payments = paymentService(
        paymentRepository(native.db, native.config, {
          hashSecret: native.config.SESSION_SECRET,
          projection,
          clock: () => time,
          corrections: paymentCorrectionEvidence(native.config.SESSION_SECRET),
        }),
        neverProvider,
      );
      reversals = paymentReversalRepository(native.db, native.config, options());
      original = await payments.start(manager, '1', orderId, paymentInput());
      expect(original.status).toBe('paid');
    });
    it('20 exact manager requests append one cash-out and preserve original payment, delivery comment and stock/benefit proofs', async () => {
      const before = await immutable(),
        source = await rows('SELECT state,status FROM pos_rewrite_payment_attempts WHERE id=?', [
          original.id,
        ]),
        body = await input();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => reversals.create(manager, '1', orderId, body)),
      );
      expect(new Set(results.map((value) => value.id)).size).toBe(1);
      expect(
        await rows('SELECT state,status FROM pos_rewrite_payment_attempts WHERE id=?', [
          original.id,
        ]),
      ).toEqual(source);
      expect(await immutable()).toEqual(before);
      expect(
        (await rows('SELECT status_id FROM comments ORDER BY id')).map((row) =>
          String(row.status_id),
        ),
      ).toEqual(['3', '1']);
      expect(
        await rows(
          'SELECT direction,amount FROM pos_rewrite_payment_correction_cash ORDER BY direction',
        ),
      ).toEqual([
        { direction: 'in', amount: '100.00' },
        { direction: 'out', amount: '100.00' },
      ]);
      expect((await payments.get(manager, '1', orderId, original.id)).status).toBe('reversed');
      expect((await payments.reconcile(manager, '1', orderId, original.id)).status).toBe(
        'reversed',
      );
      expect((await payments.paymentContext(manager, '1', orderId)).canRecordPayment).toBe(true);
    });
    it('re-payment records one new incoming cash event and never replays original stock/wallet/membership work', async () => {
      const body = await input(),
        before = await immutable();
      await reversals.create(manager, '1', orderId, body);
      const newBody = paymentInput(),
        paid = await payments.start(manager, '1', orderId, newBody);
      expect(paid.status).toBe('paid');
      expect(paid.id).not.toBe(original.id);
      expect((await payments.start(manager, '1', orderId, newBody)).id).toBe(paid.id);
      expect((await payments.get(manager, '1', orderId, original.id)).status).toBe('reversed');
      expect((await payments.reconcile(manager, '1', orderId, original.id)).status).toBe(
        'reversed',
      );
      expect(
        (await payments.list(manager, '1', orderId)).map((value) => value.status).sort(),
      ).toEqual(['paid', 'reversed']);
      expect(await immutable()).toEqual(before);
      expect((await rows('SELECT id FROM pos_rewrite_payment_correction_cash')).length).toBe(3);
      const projected = await paymentCorrectionCashProjection(
        native.db.get('writer'),
        { storeIds: ['1'], from: today, to: today },
        native.config.SESSION_SECRET,
      );
      expect(projected).toEqual([
        {
          storeId: '1',
          date: today,
          cashAdjustment: '100.00',
          cashOut: '100.00',
          orderCountAdjustment: 0,
        },
      ]);
    });
    it('actual collection snapshots replace the mutable source baseline once and retain each new cash-in/cash-out', async () => {
      const finance = { proofKey: native.config.SESSION_SECRET },
        snapshot = () => collectionSnapshot(native.db.get('writer'), '1', today, finance);
      expect(await snapshot()).toMatchObject({
        order_count: 1,
        cash: '100.00',
        cash_refund: '0.00',
      });
      await reversals.create(manager, '1', orderId, await input());
      expect(await snapshot()).toMatchObject({
        order_count: 1,
        cash: '100.00',
        cash_refund: '100.00',
        total_online: '0.00',
      });
      await payments.start(manager, '1', orderId, paymentInput());
      expect(await snapshot()).toMatchObject({
        order_count: 1,
        cash: '200.00',
        cash_refund: '100.00',
      });
      await reversals.create(manager, '1', orderId, await input());
      expect(await snapshot()).toMatchObject({
        order_count: 1,
        cash: '200.00',
        cash_refund: '200.00',
      });
      await payments.start(manager, '1', orderId, paymentInput());
      expect(await snapshot()).toMatchObject({
        order_count: 1,
        cash: '300.00',
        cash_refund: '200.00',
      });
    });
    it('attributes collection and physical cash-out to actual distinct business dates while retaining one original-date order', async () => {
      const finance = { proofKey: native.config.SESSION_SECRET },
        next = Temporal.PlainDate.from(today).add({ days: 1 }).toString(),
        last = Temporal.PlainDate.from(today).add({ days: 2 }).toString();
      time = Temporal.PlainDateTime.from(`${next}T12:00:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await reversals.create(manager, '1', orderId, await input());
      time = Temporal.PlainDateTime.from(`${last}T12:00:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await payments.start(manager, '1', orderId, paymentInput());
      expect(await collectionSnapshot(native.db.get('writer'), '1', today, finance)).toMatchObject({
        order_count: 1,
        cash: '100.00',
        cash_refund: '0.00',
      });
      expect(await collectionSnapshot(native.db.get('writer'), '1', next, finance)).toMatchObject({
        order_count: 0,
        cash: '0.00',
        cash_refund: '100.00',
      });
      expect(await collectionSnapshot(native.db.get('writer'), '1', last, finance)).toMatchObject({
        order_count: 0,
        cash: '100.00',
        cash_refund: '0.00',
      });
    });
    it('the actual current cash ledger shows net physical cash without fake product-return rows', async () => {
      await reversals.create(manager, '1', orderId, await input());
      await native.fixture.insert('store_cash_opening_balance', {
        store_id: 1,
        balance_date: today,
        amount: 50,
      });
      const result = await cashLedgerService(
        native.config,
        native.db,
        ledgerOptions({}),
        undefined,
        () => time,
        { proofKey: native.config.SESSION_SECRET },
      ).read(manager, ['1'], today, today);
      expect(result.reader).toBe('data');
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        sales_cash: '0.00',
        opening_cash: '50.00',
        running_total: '50.00',
        status: 'NOT_CLOSED',
      });
      expect(await rows('SELECT id FROM return_orders')).toHaveLength(0);
      expect(
        (await rows('SELECT is_refunded FROM amount_to_be_refunded_log'))[0]!.is_refunded,
      ).toBeNull();
    });
    it('actual DSR retains source revenue/quantities and one order while preventing fake online residual cash', async () => {
      await native.connection.query("UPDATE orders SET country_id='India' WHERE id=?", [orderId]);
      const service = reportService(native.config, native.db, {
        clock: () => time,
        paymentCorrections: { proofKey: native.config.SESSION_SECRET },
        warehouse: {
          async dailyRollups() {
            throw new Error('No historical MySQL fallback');
          },
          async auxiliary() {
            return { footfall: {}, target: {} };
          },
        },
      });
      const before = await service.daily(manager, { storeIds: ['1'], from: today, to: today });
      expect(before.data).toHaveLength(1);
      await reversals.create(manager, '1', orderId, await input());
      const reversed = await service.daily(manager, { storeIds: ['1'], from: today, to: today });
      expect(reversed.data[0]).toMatchObject({
        store_orders: 1,
        cash: 100,
        total_online: 0,
        payment_correction_cash_out: 100,
        cash_after_payment_corrections: 0,
      });
      expect(reversed.totals.total_qty).toBe(before.totals.total_qty);
      expect(reversed.totals.total_revenue).toBe(before.totals.total_revenue);
      await payments.start(manager, '1', orderId, paymentInput());
      const repaid = await service.daily(manager, { storeIds: ['1'], from: today, to: today });
      expect(repaid.data[0]).toMatchObject({
        store_orders: 1,
        cash: 200,
        total_online: 0,
        payment_correction_cash_out: 100,
        cash_after_payment_corrections: 100,
      });
      expect(repaid.totals.total_qty).toBe(before.totals.total_qty);
      expect(repaid.totals.total_revenue).toBe(before.totals.total_revenue);
    });
    it('day snapshots stay consistent when a correction commits between repeated reads in the same native transaction', async () => {
      const finance = { proofKey: native.config.SESSION_SECRET };
      await native.db.get('data').transaction(
        async (tx) => {
          expect(await collectionSnapshot(tx, '1', today, finance)).toMatchObject({
            cash: '100.00',
            cash_refund: '0.00',
            order_count: 1,
          });
          await reversals.create(manager, '1', orderId, await input());
          expect(await collectionSnapshot(tx, '1', today, finance)).toMatchObject({
            cash: '100.00',
            cash_refund: '0.00',
            order_count: 1,
          });
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
      expect(await collectionSnapshot(native.db.get('writer'), '1', today, finance)).toMatchObject({
        cash: '100.00',
        cash_refund: '100.00',
        order_count: 1,
      });
    });
    it('retains immutable corrections through later refunds/status/archive changes and refuses missing or changed financial proofs', async () => {
      const finance = { proofKey: native.config.SESSION_SECRET };
      await reversals.create(manager, '1', orderId, await input());
      await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=44');
      await native.connection.query(
        'UPDATE orders SET order_status=0,payment_status=7 WHERE id=?',
        [orderId],
      );
      await native.fixture.insert('return_orders', {
        order_id: orderId,
        has_product_id: '9007199254740994',
        store_id: 1,
        created_at: `${today} 15:00:00`,
      });
      await native.connection.query(
        "UPDATE amount_to_be_refunded_log SET is_refunded=1,refund_mode='cash',refunded_amt=25 WHERE order_id=?",
        [orderId],
      );
      expect(await collectionSnapshot(native.db.get('writer'), '1', today, finance)).toMatchObject({
        cash: '100.00',
        cash_refund: '125.00',
        order_count: 1,
      });
      await expect(
        collectionSnapshot(native.db.get('writer'), '1', today, {}),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID' });
      await native.connection.query(
        "UPDATE pos_rewrite_payment_correction_cash SET amount=amount+0.01 WHERE direction='out'",
      );
      await expect(
        collectionSnapshot(native.db.get('writer'), '1', today, finance),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID' });
    });
    it('does not treat a missing later incoming cash movement as zero after a corrected order is paid again', async () => {
      await reversals.create(manager, '1', orderId, await input());
      const paid = await payments.start(manager, '1', orderId, paymentInput());
      await native.connection.query('DELETE FROM pos_rewrite_payment_correction_cash WHERE id=?', [
        `${paid.id}:in`,
      ]);
      await expect(
        collectionSnapshot(native.db.get('writer'), '1', today, {
          proofKey: native.config.SESSION_SECRET,
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID' });
    });
    it('rejects oversized native funding JSON before loading financial bodies', async () => {
      await reversals.create(manager, '1', orderId, await input());
      await native.connection.query(
        "UPDATE pos_rewrite_payment_attempts SET state=JSON_SET(state,'$.unsupportedLargePayload',REPEAT('x',2100000)) WHERE id=?",
        [original.id],
      );
      await expect(
        collectionSnapshot(native.db.get('writer'), '1', today, {
          proofKey: native.config.SESSION_SECRET,
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID' });
    });
    it('original payment create replay is effectively reversed and cannot trigger another paid completion', async () => {
      const raw = await rows('SELECT state FROM pos_rewrite_payment_attempts WHERE id=?', [
          original.id,
        ]),
        state = raw[0]!.state as PaymentAttempt,
        body: PaymentInput = {
          operationId: state.id,
          channel: 'cash',
          onlineAmount: '0.00',
          cashAmount: '100.00',
          cashReceived: '150.00',
        };
      await reversals.create(manager, '1', orderId, await input());
      expect((await payments.start(manager, '1', orderId, body)).status).toBe('reversed');
    });
    it('20 identical re-payment contenders collect one incoming cash receipt', async () => {
      await reversals.create(manager, '1', orderId, await input());
      const body = paymentInput(),
        results = await Promise.all(
          Array.from({ length: 20 }, () => payments.start(manager, '1', orderId, body)),
        );
      expect(new Set(results.map((value) => value.id))).toEqual(new Set([body.operationId]));
      expect((await payments.get(manager, '1', orderId, body.operationId)).status).toBe('paid');
      expect(
        await rows(
          "SELECT source_id FROM pos_rewrite_payment_correction_cash WHERE direction='in' AND source_id=?",
          [body.operationId],
        ),
      ).toHaveLength(1);
    });
    it('re-payment cannot dispatch an already confirmed first-paid stock/reward notification again', async () => {
      await native.connection.query(
        "UPDATE pos_rewrite_payment_outbox SET status='delivered' WHERE order_id=?",
        [orderId],
      );
      await native.connection.execute(
        'INSERT INTO pos_rewrite_payment_outbox (id,kind,order_id,store_id,status,created_at) VALUES(?,?,?,?,?,?)',
        [`${original.id}:order-sms`, 'order-sms', orderId, '1', 'pending', `${today} 12:00:00`],
      );
      const delivered = await rows('SELECT id,status FROM pos_rewrite_payment_outbox ORDER BY id');
      await reversals.create(manager, '1', orderId, await input());
      await payments.start(manager, '1', orderId, paymentInput());
      expect(await rows('SELECT id,status FROM pos_rewrite_payment_outbox ORDER BY id')).toEqual(
        delivered,
      );
    });
    it('two different commands cannot return the same paid cash twice', async () => {
      const first = await input(),
        second = {
          ...first,
          operationId: crypto.randomUUID(),
          cashReturnReceiptId: crypto.randomUUID(),
        };
      const outcomes = await Promise.allSettled([
        reversals.create(manager, '1', orderId, first),
        reversals.create(manager, '1', orderId, second),
      ]);
      expect(outcomes.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      expect(
        await rows("SELECT amount FROM pos_rewrite_payment_correction_cash WHERE direction='out'"),
      ).toEqual([{ amount: '100.00' }]);
    });
    it('late SQL failure rolls back flags, compensation, cash movements and appended history together', async () => {
      const body = await input(),
        before = await immutable();
      await native.connection.query(
        "CREATE TRIGGER reject_correction_log BEFORE INSERT ON pos_transaction_logs FOR EACH ROW BEGIN IF NEW.payment_status=1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated rollback fixture'; END IF; END",
      );
      try {
        await expect(reversals.create(manager, '1', orderId, body)).rejects.toThrow();
      } finally {
        await native.connection.query('DROP TRIGGER reject_correction_log');
      }
      expect(await rows('SELECT id FROM pos_rewrite_payment_reversals')).toHaveLength(0);
      expect(await rows('SELECT id FROM pos_rewrite_payment_correction_cash')).toHaveLength(0);
      expect((await payments.get(manager, '1', orderId, original.id)).status).toBe('paid');
      expect(
        (await rows('SELECT status_id FROM comments')).map((value) => String(value.status_id)),
      ).toEqual(['3']);
      expect(await immutable()).toEqual(before);
    });
    it('preserves exact source benefit allocations and current membership when correcting and repaying', async () => {
      await native.connection.query(
        'UPDATE orders SET tss_money_used=10,tss_points_used=5 WHERE id=?',
        [orderId],
      );
      await native.connection.query(
        'UPDATE amount_to_be_refunded_log SET tss_money_used=10,tss_point_used=5 WHERE order_id=?',
        [orderId],
      );
      await native.connection.query(
        `UPDATE pos_rewrite_checkout_projections JOIN orders ON orders.id=order_id SET input_hash=${checkoutHeaderHashSql}`,
      );
      await native.connection.query(
        `UPDATE pos_rewrite_checkout_customer_consents JOIN orders ON orders.id=order_id SET input_hash=${checkoutHeaderHashSql},required=1,contact_revision=0,contact_digest=REPEAT('a',64),verified_until_ms=accepted_at_ms+900000`,
      );
      const before = await immutable();
      await reversals.create(manager, '1', orderId, await input());
      await payments.start(manager, '1', orderId, paymentInput());
      expect(await immutable()).toEqual(before);
    });
    it('blocks a currently downgraded manager and current franchise scope even with a stale internal principal', async () => {
      const body = await input();
      await native.connection.query('UPDATE pos_user SET role=4 WHERE id=44');
      await expect(reversals.create(manager, '1', orderId, body)).rejects.toMatchObject({
        code: 'ROLE_ACCESS_DENIED',
      });
      await native.connection.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=44');
      await expect(reversals.create(manager, '1', orderId, body)).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
      expect(await rows('SELECT id FROM pos_rewrite_payment_reversals')).toHaveLength(0);
    });
    it.each([
      [
        "UPDATE orders SET ship_date='2026-01-01 10:00:00' WHERE id=?",
        'PAYMENT_REVERSAL_FULFILMENT_REVIEW_REQUIRED',
      ],
      [
        "UPDATE has_products SET status='RETURN_INITIATED' WHERE order_id=?",
        'PAYMENT_REVERSAL_LINES_CHANGED',
      ],
      [
        'UPDATE has_products SET is_order_delivered=1 WHERE order_id=?',
        'PAYMENT_REVERSAL_FULFILMENT_REVIEW_REQUIRED',
      ],
      [
        'UPDATE has_products SET is_order_shipped=NULL WHERE order_id=?',
        'PAYMENT_REVERSAL_FULFILMENT_REVIEW_REQUIRED',
      ],
      [
        'UPDATE amount_to_be_refunded_log SET is_refunded=1,refunded_amt=20 WHERE order_id=?',
        'PAYMENT_REVERSAL_RETURN_REVIEW_REQUIRED',
      ],
      [
        "UPDATE pos_rewrite_payment_outbox SET status='processing' WHERE order_id=?",
        'PAYMENT_REVERSAL_DELIVERY_REVIEW_REQUIRED',
      ],
      [
        'DELETE FROM pos_rewrite_payment_attempts WHERE order_id=?',
        'PAYMENT_REVERSAL_PROVIDER_REVIEW_REQUIRED',
      ],
      ['UPDATE orders SET pay_amt=101 WHERE id=?', 'PAYMENT_REVERSAL_CASH_PROOF_REQUIRED'],
    ])('refuses unsafe evidence: %s', async (query, blocker) => {
      await native.connection.query(query, [orderId]);
      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(blocker);
    });
    it('blocks terminal/split/uncertain money and refuses noncash collection after a cash correction before provider dispatch', async () => {
      const state = (
        await rows('SELECT state FROM pos_rewrite_payment_attempts WHERE id=?', [original.id])
      )[0]!.state as PaymentAttempt;
      const id = crypto.randomUUID();
      await native.connection.execute(
        'INSERT INTO pos_rewrite_payment_attempts VALUES(?,?,?,?,?,?,?,?)',
        [
          id,
          orderId,
          '1',
          '44',
          'uncertain',
          JSON.stringify({
            ...state,
            id,
            status: 'uncertain',
            channel: 'pine-card',
            machineId: '1',
          }),
          `${today} 12:00:00`,
          `${today} 12:00:00`,
        ],
      );
      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_PROVIDER_REVIEW_REQUIRED',
      );
      await native.connection.execute('DELETE FROM pos_rewrite_payment_attempts WHERE id=?', [id]);
      await reversals.create(manager, '1', orderId, await input());
      await expect(
        payments.start(manager, '1', orderId, {
          ...paymentInput(),
          channel: 'pine-card',
          machineId: '1',
          cashAmount: '0.00',
          onlineAmount: '100.00',
        }),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_CASH_ONLY' });
    });
    it('a completed legacy provider event cannot be erased by a cash-only flag correction', async () => {
      await native.fixture.insert('pos_terminal_transactions', {
        order_id: orderId,
        store_id: 1,
        transaction_id: 'EXTERNAL-TERMINAL',
        platform: 'txn_completed',
        amount: '100.00',
        cash_amount: '0.00',
        cash_recieved: '0.00',
        total_amount: '100.00',
        payment_mode: 1,
        plutus_id: 'PROVIDER-FUNDS-REFERENCE',
      });

      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_PROVIDER_REVIEW_REQUIRED',
      );
    });
    it('partial/fulfilled returns and issued value remain reconciliation-only', async () => {
      await native.fixture.insert('return_orders', {
        order_id: orderId,
        has_product_id: '9007199254740994',
      });
      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_RETURN_REVIEW_REQUIRED',
      );
      await native.connection.query('DELETE FROM return_orders');
      await native.fixture.insert('gift_vouchers', { id: 99, order_id: orderId, status: 1 });
      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_ISSUED_VALUE_REVIEW_REQUIRED',
      );
      await native.connection.query('DELETE FROM gift_vouchers');
    });
    it('cash accounting keeps original funding date, late cash-out date, new incoming date and a single logical order', async () => {
      const date1 = Temporal.PlainDate.from(today).add({ days: 1 }).toString(),
        date2 = Temporal.PlainDate.from(today).add({ days: 2 }).toString();
      for (const version of [1, 2])
        await native.fixture.insert('store_day_close', {
          store_id: 1,
          close_date: today,
          version,
          status: 'CLOSED',
          cash_system: 100,
        });
      time = Temporal.PlainDateTime.from(`${date1}T12:00:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await reversals.create(manager, '1', orderId, await input());
      expect(
        await paymentCorrectionCashProjection(
          native.db.get('writer'),
          { storeIds: ['1'], from: today, to: date2 },
          native.config.SESSION_SECRET,
        ),
      ).toEqual([
        {
          storeId: '1',
          date: today,
          cashAdjustment: '100.00',
          cashOut: '0.00',
          orderCountAdjustment: 1,
        },
        {
          storeId: '1',
          date: date1,
          cashAdjustment: '0.00',
          cashOut: '100.00',
          orderCountAdjustment: 0,
        },
      ]);
      time = Temporal.PlainDateTime.from(`${date2}T12:00:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await payments.start(manager, '1', orderId, paymentInput());
      expect(
        await paymentCorrectionCashProjection(
          native.db.get('writer'),
          { storeIds: ['1'], from: today, to: date2 },
          native.config.SESSION_SECRET,
        ),
      ).toEqual([
        {
          storeId: '1',
          date: today,
          cashAdjustment: '0.00',
          cashOut: '0.00',
          orderCountAdjustment: 0,
        },
        {
          storeId: '1',
          date: date1,
          cashAdjustment: '0.00',
          cashOut: '100.00',
          orderCountAdjustment: 0,
        },
        {
          storeId: '1',
          date: date2,
          cashAdjustment: '100.00',
          cashOut: '0.00',
          orderCountAdjustment: 0,
        },
      ]);
      expect(
        (await rows('SELECT version,status,cash_system FROM store_day_close ORDER BY version')).map(
          (value) => ({ ...value, cash_system: String(value.cash_system) }),
        ),
      ).toEqual([
        { version: 1, status: 'CLOSED', cash_system: '100.00' },
        { version: 2, status: 'STALE', cash_system: '100.00' },
      ]);
      expect(
        (await rows('SELECT id FROM pos_rewrite_payment_correction_close_impacts')).length,
      ).toBe(2);
    });
    it('a missing/changed compensation fails both paid replay and cash reconciliation instead of trusting flags', async () => {
      await reversals.create(manager, '1', orderId, await input());
      await native.connection.query(
        "UPDATE pos_rewrite_payment_reversals SET receipt_hash=REPEAT('0',64)",
      );
      await expect(payments.get(manager, '1', orderId, original.id)).rejects.toMatchObject({
        code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID',
      });
      await expect(
        paymentCorrectionCashProjection(
          native.db.get('writer'),
          { storeIds: ['1'], from: today, to: today },
          native.config.SESSION_SECRET,
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID' });
    });
    it('an incomplete cash-out pair cannot unlock another payment and archive never erases recorded cash', async () => {
      await reversals.create(manager, '1', orderId, await input());
      await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=44');
      expect(
        await paymentCorrectionCashProjection(
          native.db.get('writer'),
          { storeIds: ['1'], from: today, to: today },
          native.config.SESSION_SECRET,
        ),
      ).toEqual([
        {
          storeId: '1',
          date: today,
          cashAdjustment: '100.00',
          cashOut: '100.00',
          orderCountAdjustment: 1,
        },
      ]);
      await native.connection.query('UPDATE pos_user SET is_active=1 WHERE id=44');
      await native.connection.query(
        "DELETE FROM pos_rewrite_payment_correction_cash WHERE direction='out'",
      );
      await expect(payments.start(manager, '1', orderId, paymentInput())).rejects.toMatchObject({
        code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID',
      });
    });
    it('requires the selected finance contract and rejects input mismatch rather than accepting arbitrary flag resets', async () => {
      const unqualified = paymentReversalRepository(native.db, native.config, {
        ...options(),
        financeContract: undefined,
      });

      expect((await unqualified.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_CONTRACT_UNVERIFIED',
      );
      const body = await input();
      await expect(
        reversals.create(manager, '1', orderId, { ...body, returnedCash: '150.00' }),
      ).rejects.toMatchObject({ code: 'PAYMENT_REVERSAL_STATE_CHANGED' });
      await reversals.create(manager, '1', orderId, body);
      await expect(
        reversals.create(manager, '1', orderId, { ...body, reason: 'incorrect-payment-record' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });
    it('failed or cancelled attempts with unproved counter cash are not silently ignored', async () => {
      const state = (
        await rows('SELECT state FROM pos_rewrite_payment_attempts WHERE id=?', [original.id])
      )[0]!.state as PaymentAttempt;
      const id = crypto.randomUUID();
      await native.connection.execute(
        'INSERT INTO pos_rewrite_payment_attempts VALUES(?,?,?,?,?,?,?,?)',
        [
          id,
          orderId,
          '1',
          '44',
          'failed',
          JSON.stringify({
            ...state,
            id,
            status: 'failed',
            cashAmount: '20.00',
            cashReceived: '20.00',
          }),
          `${today} 12:00:00`,
          `${today} 12:00:00`,
        ],
      );
      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_UNACCOUNTED_CASH',
      );
    });
    it('order-scoped outbox and correction-day projections have bounded indexed access with identical results', async () => {
      const expected = await rows(
        'SELECT id FROM pos_rewrite_payment_outbox WHERE order_id=? AND kind=? AND status=? ORDER BY id',
        [orderId, 'order-kinesis', 'pending'],
      );
      const indexed = await rows(
        'SELECT id FROM pos_rewrite_payment_outbox FORCE INDEX(ix_payment_outbox_order_state) WHERE order_id=? AND kind=? AND status=? ORDER BY id',
        [orderId, 'order-kinesis', 'pending'],
      );
      expect(indexed).toEqual(expected);
      const plan = await rows(
        'EXPLAIN SELECT id FROM pos_rewrite_payment_outbox FORCE INDEX(ix_payment_outbox_order_state) WHERE order_id=? AND kind=? AND status=?',
        [orderId, 'order-kinesis', 'pending'],
      );
      expect(plan[0]?.key).toBe('ix_payment_outbox_order_state');
      expect(plan[0]?.type).toBe('ref');
      await reversals.create(manager, '1', orderId, await input());
      // A one-row table may correctly choose a covering index scan. Establish
      // selective out-of-scope data before assessing this range access path.
      await native.connection.query(
        'INSERT INTO pos_rewrite_payment_correction_orders(order_id,store_id,counter_id,order_date,first_payment_id,input_hash) VALUES ?',
        [
          Array.from({ length: 1000 }, (_, index) => [
            (10000000000000000n + BigInt(index)).toString(),
            '999',
            '3',
            today,
            crypto.randomUUID(),
            '0'.repeat(64),
          ]),
        ],
      );
      await native.connection.query('ANALYZE TABLE pos_rewrite_payment_correction_orders');
      const dayPlan = await rows(
        'EXPLAIN SELECT order_id FROM pos_rewrite_payment_correction_orders FORCE INDEX(payment_correction_order_day) WHERE store_id=? AND order_date BETWEEN ? AND ?',
        ['1', today, today],
      );
      expect(dayPlan[0]?.key).toBe('payment_correction_order_day');
      expect(['range', 'ref']).toContain(dayPlan[0]?.type);
    });
    it('three traced resources validate strict runtime input and return original receipts by GET only', async () => {
      const app = Fastify();
      registerEventCatalog(app);
      app.addHook('preHandler', async (request) => {
        request.principal = manager;
        let checks = 0;
        request.authSessionValid =
          request.headers['x-test-missing-validator'] === 'true'
            ? null
            : async () => request.headers['x-test-late-revocation'] !== 'true' || ++checks === 1;
      });
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof ZodError)
          return reply.code(400).send({ error: { code: 'VALIDATION_FAILED' } });
        if (error instanceof AppError)
          return reply.code(error.status).send({ error: { code: error.code } });
        return reply.code(500).send({ error: { code: 'INTERNAL' } });
      });
      registerPaymentReversals(app, native.config, native.db, options());
      const base = `/api/v1/stores/1/orders/${orderId}/payment-reversals`,
        body = await input();
      expect(
        (await app.inject({ method: 'POST', url: base, payload: { ...body, p_status: 4 } }))
          .statusCode,
      ).toBe(400);
      const created = await app.inject({ method: 'POST', url: base, payload: body });
      expect(created.statusCode).toBe(201);
      const recovered = await app.inject({ method: 'GET', url: base + '/' + body.operationId });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toEqual(created.json());
      expect(recovered.headers['cache-control']).toBe('private, no-store');
      expect(resourceRoutes(app)).toHaveLength(3);
      for (const headers of [
        { 'x-test-missing-validator': 'true' },
        { 'x-test-late-revocation': 'true' },
      ])
        expect(
          (await app.inject({ method: 'GET', url: base + '/' + body.operationId, headers }))
            .statusCode,
        ).toBe(401);
      expect(
        (await app.inject({ method: 'GET', url: base + '/' + body.operationId })).json(),
      ).toEqual(created.json());
      await app.close();
    });
  },
);
