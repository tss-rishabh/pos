import { Temporal } from '@js-temporal/polyfill';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import {
  cashReturnPartitionHeads,
  assertSameCashReturnHeads,
} from '../../src/modules/checkout/payment-reversals/intent-guards.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { cashReturnIntentContract } from '../../src/modules/checkout/payment-reversals/intent-contracts.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { RowDataPacket } from 'mysql2/promise';
import {
  sealPaymentCorrectionAtCurrentControls,
  readPaymentCorrectionPartitions,
  paymentCorrectionPublicationContract,
} from '../../src/modules/finance/payment-correction-publication.js';
import { closeEntriesSchema } from '../../src/modules/finance/domain.js';
import { collectionSnapshot, financeService } from '../../src/modules/finance/service.js';
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
    let sessionId: string;
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
      intentContract: cashReturnIntentContract,
      assertHandoverReady: async () => undefined,
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
      const intentId = crypto.randomUUID(),
        body = {
          operationId: crypto.randomUUID(),
          intentId,
          originalPaymentId: context.originalPaymentId!,
          counterId: '3',
          snapshotHash: context.snapshotHash!,
          cashReturnReceiptId: crypto.randomUUID(),
          returnedCash: '100.00',
          confirmCashReturned: true,
          confirmNoHandover: true,
          reason: 'customer-payment-correction',
        } as const;
      await reversals.intents.prepare(
        manager,
        '1',
        orderId,
        {
          operationId: intentId,
          correctionId: body.operationId,
          cashReturnReceiptId: body.cashReturnReceiptId,
          originalPaymentId: body.originalPaymentId,
          snapshotHash: body.snapshotHash,
          counterId: body.counterId,
          returnedCash: body.returnedCash,
          reason: body.reason,
          confirmNoHandover: true,
        },
        sessionId,
      );
      await reversals.intents.arm(
        manager,
        '1',
        orderId,
        intentId,
        { operationId: crypto.randomUUID() },
        sessionId,
      );
      await reversals.intents.attest(
        manager,
        '1',
        orderId,
        intentId,
        {
          operationId: crypto.randomUUID(),
          returnedAt: time.toString({ smallestUnit: 'millisecond' }),
          confirmAlreadyReturned: true,
          confirmNoHandover: true,
          basis: 'own-return',
          evidenceId: crypto.randomUUID(),
        },
        sessionId,
      );
      return body;
    }
    async function prepareOnly() {
      const context = await reversals.context(manager, '1', orderId),
        operationId = crypto.randomUUID(),
        body = {
          operationId,
          correctionId: crypto.randomUUID(),
          cashReturnReceiptId: crypto.randomUUID(),
          originalPaymentId: context.originalPaymentId!,
          snapshotHash: context.snapshotHash!,
          counterId: '3',
          returnedCash: '100.00',
          reason: 'customer-payment-correction' as const,
          confirmNoHandover: true as const,
        };
      return {
        body,
        result: await reversals.intents.prepare(manager, '1', orderId, body, sessionId),
      };
    }
    async function anotherManager() {
      const user = { ...manager, id: '55', role: 3 as const };
      const existing = await rows('SELECT id FROM pos_user WHERE id=55');
      if (!existing.length)
        await native.fixture.insert('pos_user', {
          id: 55,
          username: 'fixture-manager55',
          email: 'manager55@example.invalid',
          role: 3,
          user_type: 1,
          is_active: 1,
        });
      else
        await native.connection.query(
          'UPDATE pos_user SET role=3,user_type=1,is_active=1 WHERE id=55',
        );
      if (!(await rows('SELECT id FROM user_stores WHERE django_user_id=55 AND store_id=1')).length)
        await native.fixture.insert('user_stores', { django_user_id: 55, store_id: 1 });
      await checkInService(native.db, native.config).set(user, '1', '3');
      return { user, sessionId: (await mysqlSessions(native.db).create(user.id)).sessionId };
    }
    async function retainedInput() {
      const context = await reversals.context(manager, '1', orderId);
      return {
        original: {
          operationId: crypto.randomUUID(),
          originalPaymentId: context.originalPaymentId!,
          counterId: '3',
          snapshotHash: context.snapshotHash!,
          cashReturnReceiptId: crypto.randomUUID(),
          returnedCash: '100.00',
          confirmCashReturned: true as const,
          confirmNoHandover: true as const,
          reason: 'customer-payment-correction' as const,
        },
        returnedBy: manager.id,
        returnedAt: time.toString({ smallestUnit: 'millisecond' }),
        confirmAlreadyReturned: true as const,
        evidenceId: crypto.randomUUID(),
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
        'pos_rewrite_cash_return_commands',
        'pos_rewrite_cash_return_intents',
        'pos_rewrite_cash_return_controls',
        'pos_rewrite_cash_return_partition_controls',
        'pos_rewrite_cash_return_claim_resolutions',
        'pos_rewrite_cash_return_claims',
        'pos_rewrite_offline_cash_order_links',
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
      sessionId = (await mysqlSessions(native.db).create(manager.id)).sessionId;
      const repository = paymentReversalRepository(native.db, native.config, options());
      reversals = {
        ...repository,
        create: (user, store, order, input) =>
          repository.create(user, store, order, input, sessionId),
      };
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
      ).rejects.toMatchObject({ code: 'CASH_RETURN_EVIDENCE_INVALID' });
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
      await expect(payments.get(manager, '1', orderId, original.id)).rejects.toMatchObject({
        code: 'CASH_RETURN_RECONCILIATION_REQUIRED',
      });
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
    it('partial/fulfilled returns, issued value and late offline-cash evidence remain reconciliation-only', async () => {
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
      await native.connection.query(
        'INSERT INTO pos_rewrite_offline_cash_order_links (receipt_id,order_id,payable_cents,business_date,projection_hash,finalized_at_ms) VALUES(?,?,?,?,?,?)',
        [crypto.randomUUID(), orderId, 10000, today, 'a'.repeat(64), Date.now()],
      );
      expect((await reversals.context(manager, '1', orderId)).blocker).toBe(
        'PAYMENT_REVERSAL_IMMUTABLE_SALE_REVIEW_REQUIRED',
      );
      await native.connection.query('DELETE FROM pos_rewrite_offline_cash_order_links');
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
      ).toBe(3);
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
      ).rejects.toMatchObject({ code: 'CASH_RETURN_INTENT_MISMATCH' });
      await reversals.create(manager, '1', orderId, body);
      await expect(
        reversals.create(manager, '1', orderId, { ...body, reason: 'incorrect-payment-record' }),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_INTENT_MISMATCH' });
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
        request.authSessionId = sessionId;
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
      expect(resourceRoutes(app)).toHaveLength(15);
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
    it('persists safe preparation before handback, permits evidence-bound cancellation and fences a late arm', async () => {
      const { body, result } = await prepareOnly();
      expect(result.intent.phase).toBe('PREPARED');
      expect(result.newlyArmed).toBe(false);
      expect(
        await collectionSnapshot(native.db.get('writer'), '1', today, {
          proofKey: native.config.SESSION_SECRET,
        }),
      ).toMatchObject({ cash: '100.00', cash_refund: '0.00' });
      expect(
        (await reversals.intents.list(manager, '1', sessionId)).data.map((row) => row.id),
      ).toContain(body.operationId);
      const cancellation = {
        operationId: crypto.randomUUID(),
        confirmCashNotReturned: true as const,
        evidenceId: crypto.randomUUID(),
        reason: 'correction-not-needed' as const,
      };
      const cancelled = await reversals.intents.cancel(
        manager,
        '1',
        orderId,
        body.operationId,
        cancellation,
        sessionId,
      );
      expect(cancelled.intent.phase).toBe('CANCELLED');
      expect(
        await reversals.intents.cancel(
          manager,
          '1',
          orderId,
          body.operationId,
          cancellation,
          sessionId,
        ),
      ).toEqual(cancelled);
      await expect(
        reversals.intents.arm(
          manager,
          '1',
          orderId,
          body.operationId,
          { operationId: crypto.randomUUID() },
          sessionId,
        ),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_ALREADY_PENDING' });
      expect((await reversals.intents.list(manager, '1', sessionId)).data).toEqual([]);
      expect(await rows('SELECT id FROM pos_rewrite_payment_correction_cash')).toEqual([]);
      expect((await payments.get(manager, '1', orderId, original.id)).status).toBe('paid');
    });
    it('arms exactly once before cash handback and exposes unknown outcomes across managers without another authorization', async () => {
      const { body } = await prepareOnly(),
        operation = { operationId: crypto.randomUUID() },
        first = await reversals.intents.arm(
          manager,
          '1',
          orderId,
          body.operationId,
          operation,
          sessionId,
        );
      expect(first.newlyArmed).toBe(true);
      expect(
        (await reversals.intents.arm(manager, '1', orderId, body.operationId, operation, sessionId))
          .newlyArmed,
      ).toBe(false);
      const other = await anotherManager(),
        queued = await reversals.intents.list(other.user, '1', other.sessionId);
      expect(queued.data).toHaveLength(1);
      expect(queued.data[0]).toMatchObject({
        id: body.operationId,
        phase: 'RETURN_PENDING',
        armed: { actorId: manager.id },
      });
      const recovered = await reversals.intents.command(
        other.user,
        '1',
        orderId,
        body.operationId,
        operation.operationId,
        other.sessionId,
      );
      expect(recovered.newlyArmed).toBe(false);
      expect(recovered.actorId).toBe(manager.id);
      expect(JSON.stringify(recovered)).not.toMatch(/sessionHash|preparedSessionHash|secretHash/);
      for (const read of [
        () =>
          collectionSnapshot(native.db.get('writer'), '1', today, {
            proofKey: native.config.SESSION_SECRET,
          }),
        () => payments.get(manager, '1', orderId, original.id),
        () =>
          paymentCorrectionCashProjection(
            native.db.get('writer'),
            { storeIds: ['1'], from: today, to: today },
            native.config.SESSION_SECRET,
          ),
      ])
        await expect(read()).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
      await expect(
        reversals.intents.cancel(
          other.user,
          '1',
          orderId,
          body.operationId,
          {
            operationId: crypto.randomUUID(),
            confirmCashNotReturned: true,
            evidenceId: crypto.randomUUID(),
            reason: 'correction-not-needed',
          },
          other.sessionId,
        ),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_CANNOT_CANCEL_PENDING' });
      expect(await rows('SELECT id FROM pos_rewrite_payment_correction_cash')).toEqual([]);
    });
    it('serializes prepared cancellation versus arming without losing a potentially returned amount', async () => {
      const { body } = await prepareOnly(),
        outcomes = await Promise.allSettled([
          reversals.intents.arm(
            manager,
            '1',
            orderId,
            body.operationId,
            { operationId: crypto.randomUUID() },
            sessionId,
          ),
          reversals.intents.cancel(
            manager,
            '1',
            orderId,
            body.operationId,
            {
              operationId: crypto.randomUUID(),
              confirmCashNotReturned: true,
              evidenceId: crypto.randomUUID(),
              reason: 'preparation-error',
            },
            sessionId,
          ),
        ]);
      expect(outcomes.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
      const current = await reversals.intents.get(
        manager,
        '1',
        orderId,
        body.operationId,
        sessionId,
      );
      if (current.phase === 'RETURN_PENDING')
        await expect(
          collectionSnapshot(native.db.get('writer'), '1', today, {
            proofKey: native.config.SESSION_SECRET,
          }),
        ).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
      else expect(current.phase).toBe('CANCELLED');
      expect(await rows('SELECT id FROM pos_rewrite_payment_reversals')).toEqual([]);
    });
    it('retains actual pre-midnight cash return and original handler separately from later attestation/recording by another manager', async () => {
      const before = await immutable(),
        other = await anotherManager();
      time = Temporal.PlainDateTime.from(`${today}T23:59:58`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      const { body } = await prepareOnly();
      await reversals.intents.arm(
        manager,
        '1',
        orderId,
        body.operationId,
        { operationId: crypto.randomUUID() },
        sessionId,
      );
      const returnedAt = time
          .add({ seconds: 1, milliseconds: 500 })
          .toString({ smallestUnit: 'millisecond' }),
        tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
      time = Temporal.PlainDateTime.from(`${tomorrow}T00:10:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await mysqlSessions(native.db).revoke(sessionId);
      await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=44');
      const attestation = {
        operationId: crypto.randomUUID(),
        returnedAt,
        confirmAlreadyReturned: true as const,
        confirmNoHandover: true as const,
        basis: 'reviewed-original-return' as const,
        evidenceId: crypto.randomUUID(),
      };
      await reversals.intents.attest(
        other.user,
        '1',
        orderId,
        body.operationId,
        attestation,
        other.sessionId,
      );
      time = time.add({ hours: 12 });
      const receipt = await reversals.resolve(
        other.user,
        '1',
        orderId,
        body.operationId,
        other.sessionId,
        body.correctionId,
      );
      expect(receipt).toMatchObject({
        id: body.correctionId,
        operatorId: other.user.id,
        businessDate: today,
        cashReturn: {
          returnedBy: manager.id,
          attestedBy: other.user.id,
          returnedAt: `${today} 23:59:59`,
          businessDate: today,
        },
      });
      expect(receipt.recordedAt.startsWith(tomorrow)).toBe(true);
      expect(
        await rows(
          "SELECT operator_id,business_date,recorded_at,amount FROM pos_rewrite_payment_correction_cash WHERE direction='out'",
        ),
      ).toEqual([
        {
          operator_id: manager.id,
          business_date: today,
          recorded_at: `${today} 23:59:59`,
          amount: '100.00',
        },
      ]);
      expect(
        await rows("SELECT actor_id FROM pos_rewrite_cash_return_commands WHERE kind='resolve'"),
      ).toEqual([{ actor_id: other.user.id }]);
      expect(await immutable()).toEqual(before);
      expect((await reversals.intents.list(other.user, '1', other.sessionId)).data).toEqual([]);
      expect(
        await reversals.resolve(
          other.user,
          '1',
          orderId,
          body.operationId,
          other.sessionId,
          body.correctionId,
        ),
      ).toEqual(receipt);
      expect(
        await collectionSnapshot(native.db.get('writer'), '1', today, {
          proofKey: native.config.SESSION_SECRET,
        }),
      ).toMatchObject({ cash: '100.00', cash_refund: '100.00' });
      expect(
        await collectionSnapshot(native.db.get('writer'), '1', tomorrow, {
          proofKey: native.config.SESSION_SECRET,
        }),
      ).toMatchObject({ cash: '0.00', cash_refund: '0.00' });
    });
    it('keeps armed/session-revoked returns unresolved and never allows a forged direct correction or cancellation', async () => {
      const { body } = await prepareOnly();
      await reversals.intents.arm(
        manager,
        '1',
        orderId,
        body.operationId,
        { operationId: crypto.randomUUID() },
        sessionId,
      );
      await mysqlSessions(native.db).revoke(sessionId);
      await expect(
        reversals.intents.attest(
          manager,
          '1',
          orderId,
          body.operationId,
          {
            operationId: crypto.randomUUID(),
            returnedAt: time.toString({ smallestUnit: 'millisecond' }),
            confirmAlreadyReturned: true,
            confirmNoHandover: true,
            basis: 'own-return',
            evidenceId: crypto.randomUUID(),
          },
          sessionId,
        ),
      ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      const other = await anotherManager();
      expect((await reversals.intents.list(other.user, '1', other.sessionId)).data[0]?.phase).toBe(
        'RETURN_PENDING',
      );
      await expect(
        reversals.create(other.user, '1', orderId, {
          operationId: body.correctionId,
          originalPaymentId: body.originalPaymentId,
          counterId: '3',
          snapshotHash: body.snapshotHash,
          cashReturnReceiptId: body.cashReturnReceiptId,
          returnedCash: '100.00',
          confirmCashReturned: true,
          confirmNoHandover: true,
          reason: body.reason,
        }),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_INTENT_REQUIRED' });
      await expect(
        collectionSnapshot(native.db.get('writer'), '1', today, {
          proofKey: native.config.SESSION_SECRET,
        }),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
    });

    it('retains one original old-device claim across twenty lost registration retries and lets another manager resolve once', async () => {
      const raw = await retainedInput(),
        before = await immutable(),
        beforePaid = await rows(
          'SELECT state,status FROM pos_rewrite_payment_attempts WHERE id=?',
          [original.id],
        );
      const saved = await Promise.all(
        Array.from({ length: 20 }, () =>
          reversals.claims.register(manager, '1', orderId, raw, sessionId),
        ),
      );
      expect(new Set(saved.map((row) => row.id))).toEqual(new Set([raw.original.operationId]));
      expect(await rows('SELECT unresolved_count FROM pos_rewrite_cash_return_controls')).toEqual([
        { unresolved_count: 1 },
      ]);
      expect(await rows('SELECT id FROM pos_rewrite_payment_correction_cash')).toEqual([]);
      await expect(payments.get(manager, '1', orderId, original.id)).rejects.toMatchObject({
        code: 'CASH_RETURN_RECONCILIATION_REQUIRED',
      });
      const other = await anotherManager();
      expect(
        (await reversals.claims.list(other.user, '1', other.sessionId)).data.map((row) => row.id),
      ).toEqual([raw.original.operationId]);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          reversals.resolveClaim(
            other.user,
            '1',
            orderId,
            raw.original.operationId,
            other.sessionId,
            raw.original.operationId,
          ),
        ),
      );
      expect(new Set(results.map((row) => row.id))).toEqual(new Set([raw.original.operationId]));
      expect(results[0]).toMatchObject({
        operatorId: other.user.id,
        cashReturn: {
          origin: 'retained-device-claim',
          returnedBy: manager.id,
          attestedBy: manager.id,
        },
      });
      expect(await rows('SELECT id FROM pos_rewrite_cash_return_claim_resolutions')).toHaveLength(
        1,
      );
      expect(
        await rows("SELECT id FROM pos_rewrite_payment_correction_cash WHERE direction='out'"),
      ).toHaveLength(1);
      expect((await reversals.claims.list(other.user, '1', other.sessionId)).data).toEqual([]);
      expect(await immutable()).toEqual(before);
      expect(
        await rows('SELECT state,status FROM pos_rewrite_payment_attempts WHERE id=?', [
          original.id,
        ]),
      ).toEqual(beforePaid);
    });
    it('retained claims reject reference rebinding, invented funding and a second claim for the same physical original', async () => {
      const raw = await retainedInput();
      await reversals.claims.register(manager, '1', orderId, raw, sessionId);
      await expect(
        reversals.claims.register(manager, '1', orderId, { ...raw, returnedBy: '55' }, sessionId),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      await expect(
        reversals.claims.register(
          manager,
          '1',
          orderId,
          { ...raw, original: { ...raw.original, operationId: crypto.randomUUID() } },
          sessionId,
        ),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_CLAIM_ALREADY_EXISTS' });
      await expect(
        reversals.resolveClaim(
          manager,
          '1',
          orderId,
          raw.original.operationId,
          sessionId,
          crypto.randomUUID(),
        ),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect(await rows('SELECT unresolved_count FROM pos_rewrite_cash_return_controls')).toEqual([
        { unresolved_count: 1 },
      ]);
      await expect(
        reversals.claims.register(
          manager,
          '1',
          orderId,
          {
            ...raw,
            original: {
              ...raw.original,
              operationId: crypto.randomUUID(),
              originalPaymentId: crypto.randomUUID(),
            },
          },
          sessionId,
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_REVERSAL_ORIGINAL_FUNDS_UNPROVED' });
      expect(await rows('SELECT id FROM pos_rewrite_cash_return_claims')).toHaveLength(1);
    });
    it('links an exact already-recorded pre-intent receipt without another correction or cash movement', async () => {
      const bound = await input(),
        receipt = await reversals.create(manager, '1', orderId, bound),
        { intentId: _intentId, ...oldInput } = bound;
      const { cashReturn: _cashReturn, recordedInstant: _instant, ...oldReceipt } = receipt;
      const requestHash = operationHash(
          'payment-correction.create.v1',
          { userId: manager.id, storeId: '1', orderId, input: oldInput },
          native.config.SESSION_SECRET,
        ),
        receiptHash = operationHash(
          'payment-correction.receipt.v1',
          oldReceipt,
          native.config.SESSION_SECRET,
        );
      await native.connection.execute(
        'UPDATE pos_rewrite_payment_reversals SET receipt=?,request_hash=?,receipt_hash=? WHERE id=?',
        [JSON.stringify(oldReceipt), requestHash, receiptHash, receipt.id],
      );
      for (const table of [
        'pos_rewrite_cash_return_commands',
        'pos_rewrite_cash_return_intents',
        'pos_rewrite_cash_return_controls',
        'pos_rewrite_cash_return_partition_controls',
      ])
        await native.connection.query('DELETE FROM ' + table);
      const cashBefore = await rows(
        'SELECT * FROM pos_rewrite_payment_correction_cash ORDER BY id',
      );
      const raw = {
        original: oldInput,
        returnedBy: manager.id,
        returnedAt: time.toString({ smallestUnit: 'millisecond' }),
        confirmAlreadyReturned: true as const,
        evidenceId: crypto.randomUUID(),
      };
      await reversals.claims.register(manager, '1', orderId, raw, sessionId);
      const other = await anotherManager();
      const result = await reversals.resolveClaim(
        other.user,
        '1',
        orderId,
        raw.original.operationId,
        other.sessionId,
        raw.original.operationId,
      );
      expect(result).toEqual(oldReceipt);
      expect(await rows('SELECT * FROM pos_rewrite_payment_correction_cash ORDER BY id')).toEqual(
        cashBefore,
      );
      expect(await rows('SELECT id FROM pos_rewrite_payment_reversals')).toHaveLength(1);
      expect(await rows('SELECT actor_id FROM pos_rewrite_cash_return_claim_resolutions')).toEqual([
        { actor_id: other.user.id },
      ]);
      expect(await rows('SELECT unresolved_count FROM pos_rewrite_cash_return_controls')).toEqual([
        { unresolved_count: 0 },
      ]);
    });
    it('current operational partition heads preserve unaffected dates and reject a stale DATA control snapshot', async () => {
      const key = native.config.SESSION_SECRET,
        writer = native.db.get('writer'),
        past = Temporal.PlainDate.from(today).subtract({ days: 5 }).toString(),
        before = await cashReturnPartitionHeads(writer, ['1'], past, today, 'daily', key),
        { body } = await prepareOnly();
      await reversals.intents.arm(
        manager,
        '1',
        orderId,
        body.operationId,
        { operationId: crypto.randomUUID() },
        sessionId,
      );
      await expect(
        cashReturnPartitionHeads(writer, ['1'], today, today, 'daily', key),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
      const older = await cashReturnPartitionHeads(writer, ['1'], past, past, 'daily', key);
      expect(older.get('1\0' + past)).toEqual(before.get('1\0' + past));
      await reversals.intents.attest(
        manager,
        '1',
        orderId,
        body.operationId,
        {
          operationId: crypto.randomUUID(),
          returnedAt: time.toString({ smallestUnit: 'millisecond' }),
          confirmAlreadyReturned: true,
          confirmNoHandover: true,
          basis: 'own-return',
          evidenceId: crypto.randomUUID(),
        },
        sessionId,
      );
      await reversals.resolve(
        manager,
        '1',
        orderId,
        body.operationId,
        sessionId,
        body.correctionId,
      );
      const after = await cashReturnPartitionHeads(writer, ['1'], past, today, 'daily', key);
      expect(after.get('1\0' + past)).toEqual(before.get('1\0' + past));
      expect(() => assertSameCashReturnHeads(before, after)).toThrowError(/changed/);
      const lag = await reversalMysqlFixture(process.env.CHECKOUT_MYSQL_TEST_URL!);
      try {
        const db = {
          ...native.db,
          get: (reader: Parameters<typeof native.db.get>[0]) =>
            reader === 'data' ? lag.db.get('data') : native.db.get(reader),
        };
        await expect(
          reportService(native.config, db, {
            clock: () => time,
            paymentCorrections: { proofKey: key },
          }).daily(manager, { storeIds: ['1'], from: today, to: today }),
        ).rejects.toMatchObject({ code: 'CASH_RETURN_FINANCIAL_STATE_CHANGED' });
      } finally {
        await lag.close();
      }
    });
    it('refuses a missing cooperating handover guard before preparation and rechecks it before arming', async () => {
      const service = paymentReversalRepository(native.db, native.config, {
          ...options(),
          assertHandoverReady: undefined,
        }),
        context = await service.context(manager, '1', orderId),
        body = {
          operationId: crypto.randomUUID(),
          correctionId: crypto.randomUUID(),
          cashReturnReceiptId: crypto.randomUUID(),
          originalPaymentId: context.originalPaymentId!,
          snapshotHash: context.snapshotHash!,
          counterId: '3',
          returnedCash: '100.00',
          reason: 'customer-payment-correction' as const,
          confirmNoHandover: true as const,
        };
      await expect(
        service.intents.prepare(manager, '1', orderId, body, sessionId),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_HANDOVER_GUARD_REQUIRED' });
      let blocked = false;
      const fenced = paymentReversalRepository(native.db, native.config, {
        ...options(),
        assertHandoverReady: async () => {
          if (blocked) throw new AppError(409, 'WHOLE_ORDER_PENDING', 'Pending handover.');
        },
      });
      await fenced.intents.prepare(manager, '1', orderId, body, sessionId);
      blocked = true;
      await expect(
        fenced.intents.arm(
          manager,
          '1',
          orderId,
          body.operationId,
          { operationId: crypto.randomUUID() },
          sessionId,
        ),
      ).rejects.toMatchObject({ code: 'WHOLE_ORDER_PENDING' });
      expect(
        (await fenced.intents.get(manager, '1', orderId, body.operationId, sessionId)).phase,
      ).toBe('PREPARED');
      expect(await rows('SELECT unresolved_count FROM pos_rewrite_cash_return_controls')).toEqual([
        { unresolved_count: 0 },
      ]);
    });

    it('blocks final close, ledger and DSR instead of publishing zero for an armed unknown physical return', async () => {
      const { body } = await prepareOnly();
      await reversals.intents.arm(
        manager,
        '1',
        orderId,
        body.operationId,
        { operationId: crypto.randomUUID() },
        sessionId,
      );
      const afterWindow = time
          .toZonedDateTimeISO(native.config.BUSINESS_TIMEZONE)
          .with({ hour: 23, minute: 59, second: 0, millisecond: 0 })
          .toInstant(),
        corrections = { proofKey: native.config.SESSION_SECRET },
        finance = financeService(
          native.config,
          native.db,
          () => afterWindow,
          undefined,
          corrections,
        ),
        entries = closeEntriesSchema.parse({
          cash_actual: '0.00',
          cash_manual_punched: '0.00',
          cash_manual_created: '0.00',
          card_actual: '0.00',
          card_manual_punched: '0.00',
          card_manual_created: '0.00',
          banking_amount: '0.00',
        });
      await expect(finance.state(manager, '1', today)).rejects.toMatchObject({
        code: 'CASH_RETURN_RECONCILIATION_REQUIRED',
      });
      await expect(
        finance.close(manager, '1', today, crypto.randomUUID(), 0, entries),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
      await expect(
        cashLedgerService(
          native.config,
          native.db,
          ledgerOptions({}),
          undefined,
          () => time,
          corrections,
        ).read(manager, ['1'], today, today),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
      await expect(
        reportService(native.config, native.db, {
          clock: () => time,
          paymentCorrections: corrections,
        }).daily(manager, { storeIds: ['1'], from: today, to: today }),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_RECONCILIATION_REQUIRED' });
      expect(await rows('SELECT id FROM store_day_close')).toEqual([]);
      expect(await rows('SELECT close_id FROM pos_rewrite_finance_commands')).toEqual([]);
    });
    it('HTTP loss/revocation after arming exposes only original GET recovery without another handback permission', async () => {
      const app = Fastify();
      registerEventCatalog(app);
      app.addHook('preHandler', async (request) => {
        request.principal = manager;
        request.authSessionId = sessionId;
        let count = 0;
        request.authSessionValid = async () =>
          request.headers['x-fixture-late-revocation'] !== '1' || ++count === 1;
      });
      app.setErrorHandler((error, _request, reply) =>
        error instanceof AppError
          ? reply.code(error.status).send({ error: { code: error.code } })
          : reply
              .code(error instanceof ZodError ? 400 : 500)
              .send({ error: { code: 'VALIDATION_FAILED' } }),
      );
      registerPaymentReversals(app, native.config, native.db, options());
      try {
        const { body } = await prepareOnly(),
          base = `/api/v1/stores/1/orders/${orderId}/cash-return-intents/${body.operationId}`,
          operationId = crypto.randomUUID();
        const lost = await app.inject({
          method: 'POST',
          url: base + '/armings',
          payload: { operationId },
          headers: { 'x-fixture-late-revocation': '1' },
        });
        expect(lost.statusCode).toBe(401);
        expect(lost.json()).toEqual({ error: { code: 'AUTH_REQUIRED' } });
        const recovered = await app.inject({
          method: 'GET',
          url: base + '/operations/' + operationId,
        });
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json()).toMatchObject({
          newlyArmed: false,
          intent: { phase: 'RETURN_PENDING' },
        });
        expect(recovered.headers['cache-control']).toBe('private, no-store');
        const replay = await app.inject({
          method: 'POST',
          url: base + '/armings',
          payload: { operationId },
        });
        expect(replay.json()).toMatchObject({
          newlyArmed: false,
          intent: { phase: 'RETURN_PENDING' },
        });
        expect(
          (
            await app.inject({
              method: 'POST',
              url: base + '/attestations',
              payload: { operationId: crypto.randomUUID(), paid: 4 },
            })
          ).statusCode,
        ).toBe(400);
        expect(await rows('SELECT unresolved_count FROM pos_rewrite_cash_return_controls')).toEqual(
          [{ unresolved_count: 1 }],
        );
        expect(
          await rows("SELECT id FROM pos_rewrite_payment_correction_cash WHERE direction='out'"),
        ).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it.each(['missing-store-head', 'missing-day-head', 'changed-day-head'] as const)(
      'never turns %s into a legitimate zero financial partition',
      async (defect) => {
        await reversals.create(manager, '1', orderId, await input());
        if (defect === 'missing-store-head')
          await native.connection.query('DELETE FROM pos_rewrite_cash_return_controls');
        else if (defect === 'missing-day-head')
          await native.connection.query(
            'DELETE FROM pos_rewrite_cash_return_partition_controls ORDER BY id LIMIT 1',
          );
        else
          await native.connection.query(
            "UPDATE pos_rewrite_cash_return_partition_controls SET manifest_hash=REPEAT('0',64) ORDER BY id LIMIT 1",
          );
        await expect(
          collectionSnapshot(native.db.get('writer'), '1', today, {
            proofKey: native.config.SESSION_SECRET,
          }),
        ).rejects.toMatchObject({ code: 'CASH_RETURN_EVIDENCE_INVALID' });
        await expect(
          cashReturnPartitionHeads(
            native.db.get('writer'),
            ['1'],
            today,
            today,
            'daily',
            native.config.SESSION_SECRET,
          ),
        ).rejects.toMatchObject({ code: 'CASH_RETURN_EVIDENCE_INVALID' });
        expect(
          await rows("SELECT id FROM pos_rewrite_payment_correction_cash WHERE direction='out'"),
        ).toHaveLength(1);
      },
    );
    it('rejects an invented future or pre-funding cash-return date without creating a claim or control head', async () => {
      const raw = await retainedInput();
      for (const returnedAt of [
        time.add({ seconds: 1 }).toString({ smallestUnit: 'millisecond' }),
        time.subtract({ hours: 24 }).toString({ smallestUnit: 'millisecond' }),
      ])
        await expect(
          reversals.claims.register(manager, '1', orderId, { ...raw, returnedAt }, sessionId),
        ).rejects.toMatchObject({ code: 'CASH_RETURN_TIME_INVALID' });
      expect(await rows('SELECT id FROM pos_rewrite_cash_return_claims')).toEqual([]);
      expect(await rows('SELECT store_id FROM pos_rewrite_cash_return_controls')).toEqual([]);
    });

    it('binds a real native financial publication to complete current heads and refuses it after a later cash-in', async () => {
      const key = native.config.SESSION_SECRET;
      await reversals.create(manager, '1', orderId, await input());
      const stamp = time.toString({ smallestUnit: 'millisecond' }),
        reference = {
          generationId: 'native_immutable_facts',
          sourcePosition: 'mysql-native:123',
          cdcWatermark: stamp,
          publishedAt: stamp,
        },
        raw = {
          contract:
            paymentCorrectionPublicationContract as typeof paymentCorrectionPublicationContract,
          kind: 'daily' as const,
          generationId: 'native_qualification_1',
          sourcePosition: 'mysql-native:456',
          cdcWatermark: stamp,
          publishedAt: stamp,
          dataReference: reference,
          businessTimezone: native.config.BUSINESS_TIMEZONE,
          storeId: '1',
          businessDate: today,
          payload: {
            storeName: 'Fixture store',
            locationCode: 'FIX',
            baselineHash: null,
            sourceCashRemoval: '0.00',
            sourceOnlineRemoval: '0.00',
            sourceOrderCountRemoval: 0,
            cashIn: '100.00',
            cashOut: '100.00',
            logicalOrderCount: 1,
          },
        };
      const records = await sealPaymentCorrectionAtCurrentControls(
          native.db.get('writer'),
          [raw],
          key,
        ),
        scope = { kind: 'daily' as const, storeIds: ['1'], from: today, to: today },
        query = async (statement: string) =>
          statement.includes('GROUP BY generation_id')
            ? [{ generationId: 'native_qualification_1' }]
            : records;
      const options = {
        table: 'fixture-project.finance.payment_publications',
        proofKey: key,
        controlHeads: await cashReturnPartitionHeads(
          native.db.get('writer'),
          ['1'],
          today,
          today,
          'daily',
          key,
        ),
      };
      expect(
        (
          await readPaymentCorrectionPartitions(
            options,
            query,
            scope,
            native.config.BUSINESS_TIMEZONE,
            time,
            reference,
          )
        ).dataGenerationId,
      ).toBe(reference.generationId);
      await payments.start(manager, '1', orderId, paymentInput());
      const changed = {
        ...options,
        controlHeads: await cashReturnPartitionHeads(
          native.db.get('writer'),
          ['1'],
          today,
          today,
          'daily',
          key,
        ),
      };
      await expect(
        readPaymentCorrectionPartitions(
          changed,
          query,
          scope,
          native.config.BUSINESS_TIMEZONE,
          time,
          reference,
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID' });
      await expect(
        sealPaymentCorrectionAtCurrentControls(native.db.get('writer'), [raw, raw], key),
      ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_PUBLICATION_INVALID' });
    });

    it('clock reversal cannot commit a cash-out before its attestation or lose the original pending proof', async () => {
      const body = await input();
      time = time.subtract({ seconds: 1 });
      await expect(
        reversals.resolve(manager, '1', orderId, body.intentId!, sessionId, body.operationId),
      ).rejects.toMatchObject({ code: 'CASH_RETURN_CLOCK_MOVED_BACKWARD' });
      expect(
        await rows("SELECT id FROM pos_rewrite_payment_correction_cash WHERE direction='out'"),
      ).toEqual([]);
      expect(await rows('SELECT unresolved_count FROM pos_rewrite_cash_return_controls')).toEqual([
        { unresolved_count: 1 },
      ]);
      expect(
        (await reversals.intents.get(manager, '1', orderId, body.intentId!, sessionId)).phase,
      ).toBe('ATTESTED');
      time = time.add({ seconds: 1 });
      expect(
        (
          await reversals.resolve(
            manager,
            '1',
            orderId,
            body.intentId!,
            sessionId,
            body.operationId,
          )
        ).id,
      ).toBe(body.operationId);
      expect(
        await rows("SELECT id FROM pos_rewrite_payment_correction_cash WHERE direction='out'"),
      ).toHaveLength(1);
    });

    it.each(['all-financial-rows', 'outflow-and-receipt'] as const)(
      'valid control heads cannot turn omitted %s into zero outflow',
      async (omission) => {
        await reversals.create(manager, '1', orderId, await input());
        const heads = await cashReturnPartitionHeads(
          native.db.get('writer'),
          ['1'],
          today,
          today,
          'daily',
          native.config.SESSION_SECRET,
        );
        if (omission === 'all-financial-rows') {
          await native.connection.query('DELETE FROM pos_rewrite_payment_correction_orders');
          await native.connection.query('DELETE FROM pos_rewrite_payment_correction_cash');
        } else
          await native.connection.query(
            "DELETE FROM pos_rewrite_payment_correction_cash WHERE direction='out'",
          );
        await native.connection.query('DELETE FROM pos_rewrite_payment_reversals');
        // Deliberately keep authentic, matching metadata: only the financial rows
        // are omitted, as a partially populated reader could otherwise do.
        assertSameCashReturnHeads(
          heads,
          await cashReturnPartitionHeads(
            native.db.get('writer'),
            ['1'],
            today,
            today,
            'daily',
            native.config.SESSION_SECRET,
          ),
        );
        await expect(
          paymentCorrectionCashProjection(
            native.db.get('writer'),
            { storeIds: ['1'], from: today, to: today },
            native.config.SESSION_SECRET,
          ),
        ).rejects.toMatchObject({ code: 'PAYMENT_CORRECTION_EVIDENCE_INVALID' });
      },
    );
  },
);
