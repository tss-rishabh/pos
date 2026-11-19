import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { AppError } from '../../src/domain/errors.js';
import { paymentService } from '../../src/modules/checkout/payments/service.js';
import { paymentRepository } from '../../src/modules/checkout/payments/repository.js';
import type {
  PaymentGateway,
  PaymentInput,
  PineReply,
} from '../../src/modules/checkout/payments/contracts.js';
import { PaymentOutcomeUnknown } from '../../src/modules/checkout/payments/contracts.js';
import { memoryStateStore } from '../../src/modules/checkout/state-store.js';
import { operator } from '../checkout/fixtures.js';
import { paymentMysqlFixture } from './mysql-fixture.js';

describe.skipIf(!process.env.CHECKOUT_MYSQL_TEST_URL)(
  'legacy counter payments and payment status on isolated native MySQL',
  { timeout: 15000 },
  () => {
    let native: Awaited<ReturnType<typeof paymentMysqlFixture>>,
      payments: ReturnType<typeof paymentService>,
      time: Temporal.Instant,
      today: string;
    const manager = { ...operator, role: 2 as const },
      orderId = '9007199254740993',
      pushed: string[] = [],
      pineReplies: (PineReply | Error)[] = [];
    const next = async () => {
      const value = pineReplies.shift();
      if (!value) throw new Error('No scripted provider reply.');
      if (value instanceof Error) throw value;
      return value;
    };
    const gateway: PaymentGateway = {
      configured() {},
      pineUpload: next,
      pineStatus: next,
      pineCancel: next,
      async paytmRequest() {
        throw new Error('No Paytm call expected.');
      },
      async paytmStatus() {
        throw new Error('No Paytm call expected.');
      },
    };
    const pine = (responseMessage: string, responseCode = 0): PineReply => ({
      responseCode,
      responseMessage,
      plutusId: '9001',
      apiResponse: `{'ResponseCode': ${responseCode}, 'ResponseMessage': '${responseMessage}'}`,
    });
    const cash = (): PaymentInput => ({
      operationId: crypto.randomUUID(),
      channel: 'cash',
      onlineAmount: '0.00',
      cashAmount: '100.00',
      cashReceived: '150.00',
      message:
        '#Card/UPI Received: 0\n#Cash Received:150\n#Cash To Be Accepted:100\n#Cash To Be Return:50',
    });
    async function rows(query: string, params: readonly (string | number)[] = []) {
      const [result] = await native.connection.execute<RowDataPacket[]>(query, [...params]);
      return result;
    }
    beforeAll(async () => {
      native = await paymentMysqlFixture(process.env.CHECKOUT_MYSQL_TEST_URL!);
      await native.fixture.insert('pos_user', { id: 44, role: 2, user_type: 1, is_active: 1 });
      await native.fixture.insert('stores', {
        id: 1,
        store_name: 'Fixture store',
        location_code: 'FIX',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('user_stores', { django_user_id: 44, store_id: 1 });
      await native.fixture.insert('order_status', { id: 1, order_status: 'PLACED' });
      await native.fixture.insert('order_status', { id: 3, order_status: 'DELIVERED' });
      await native.fixture.insert('payment_status', { id: 1, payment_status: 'Pending' });
      await native.fixture.insert('payment_status', { id: 4, payment_status: 'Paid' });
      await native.fixture.insert('pos_terminal_payment_modes', {
        id: 1,
        name: 'CARD (Pinelab)',
        mode_id: 1,
        is_active: 1,
        platform: 'PINELAB',
      });
      await native.fixture.insert('pos_terminal_payment_modes', {
        id: 2,
        name: 'WALLET (Pinelab)',
        mode_id: 7,
        is_active: 1,
        platform: 'PINELAB',
      });
      await native.fixture.insert('pos_terminal_payment_modes', {
        id: 3,
        name: 'Online (Others)',
        mode_id: 1001,
        is_active: 1,
        platform: 'OTHERS',
      });
      await native.fixture.insert('pos_machines', {
        id: 5,
        store_id: 1,
        counter_id: 3,
        machine_name: 'M1',
        merchant_store_pos_code: 'POS5',
        imei_no: 'IMEI5',
        merchant_id: 'MID',
        security_token: 'TOKEN',
        client_id: 'CLIENT',
        is_active: 1,
      });
    }, 30000);
    afterAll(async () => native?.close());
    beforeEach(async () => {
      for (const table of [
        'pos_terminal_transactions',
        'comments',
        'pos_transaction_logs',
        'store_day_close',
        'gift_vouchers',
        'has_products',
        'order_stores',
        'orders',
      ])
        await native.connection.query(`DELETE FROM ${table}`);
      pushed.length = 0;
      pineReplies.length = 0;
      today = Temporal.Now.zonedDateTimeISO('Asia/Kolkata').toPlainDate().toString();
      time = Temporal.PlainDateTime.from(`${today}T12:00:00`)
        .toZonedDateTime('Asia/Kolkata')
        .toInstant();
      await native.fixture.insert('orders', {
        id: orderId,
        order_ref_no: 'FIXTURE-PAY-0001',
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
      });
      await native.fixture.insert('store_day_close', {
        store_id: 1,
        close_date: today,
        version: 1,
        status: 'CLOSED',
        closed_by_id: 44,
        closed_at: `${today} 09:00:00`,
      });
      payments = paymentService(
        paymentRepository(native.db, native.config, {
          clock: () => time,
          assertCheckIn: async () => undefined,
        }),
        gateway,
        { stateStore: memoryStateStore(), pushes: { paid: async (id) => void pushed.push(id) } },
      );
    });
    it('records a cash sale as complete_order does and replays the same request', async () => {
      const input = cash();
      const first = await payments.start(manager, '1', orderId, input);
      expect(first).toMatchObject({
        status: 'paid',
        legacyStatus: 'Cash Delivered',
        transactionId: 'FIXTURE-PAY-0001',
      });
      expect(await payments.start(manager, '1', orderId, input)).toEqual(first);
      expect(pushed).toEqual([orderId]);
      expect(
        await rows('SELECT payment_status,order_status FROM orders WHERE id=?', [orderId]),
      ).toEqual([{ payment_status: 4, order_status: 3 }]);
      const [mapping] = await rows(
        'SELECT is_manually_paid,transaction_id,message,offline_payment,offline_payment_recieved,online_payment,online_other_payment FROM order_stores WHERE order_id=?',
        [orderId],
      );
      expect(mapping).toMatchObject({
        is_manually_paid: 1,
        transaction_id: 'FIXTURE-PAY-0001',
        message: input.message,
      });
      expect(Number(mapping!.offline_payment)).toBe(100);
      expect(Number(mapping!.offline_payment_recieved)).toBe(150);
      expect(await rows('SELECT status FROM has_products')).toEqual([{ status: 'DELIVERED' }]);
      expect(await rows('SELECT status_id,comment FROM comments')).toEqual([
        { status_id: '3', comment: 'Store Order: DELIVERED status changed by pos admin.' },
      ]);
      expect(
        await rows(
          'SELECT order_status,payment_status,user_id,pos_user_id,pay_dict,comment FROM pos_transaction_logs',
        ),
      ).toEqual([
        {
          order_status: '3',
          payment_status: '4',
          user_id: '0',
          pos_user_id: '44',
          pay_dict:
            "{'cash payment': 100.0, 'online payment': 0.0, 'total amount on counter': 100.0}",
          comment: 'Order Delivered : Total Amount Recieved at Counter in Cash: 100.0',
        },
      ]);
      expect(
        await rows('SELECT status,stale_reason,stale_trigger_ref FROM store_day_close'),
      ).toEqual([{ status: 'STALE', stale_reason: 'PAYMENT', stale_trigger_ref: orderId }]);
      await expect(payments.start(manager, '1', orderId, cash())).rejects.toMatchObject({
        status: 409,
        code: 'ORDER_NOT_PAYABLE',
      });
    });
    it('lets the cashier re-initiate after a definitive Pine rejection and settles by status', async () => {
      const card: PaymentInput = {
        operationId: crypto.randomUUID(),
        channel: 'pine',
        paymentMode: 7,
        onlineAmount: '100.00',
        cashAmount: '0.00',
        cashReceived: '0.00',
        machineId: '5',
        message: 'card',
      };
      pineReplies.push(pine('PLEASE APPROVE OPEN TXN FIRST', 1));
      await expect(payments.start(manager, '1', orderId, card)).rejects.toMatchObject({
        status: 409,
        code: 'PAYMENT_PROVIDER_REJECTED',
        message: 'Please Approve Open Txn First',
      });
      expect(await rows('SELECT id FROM pos_terminal_transactions')).toEqual([]);
      pineReplies.push(new PaymentOutcomeUnknown('timeout'));
      await expect(
        payments.start(manager, '1', orderId, { ...card, operationId: crypto.randomUUID() }),
      ).rejects.toMatchObject({ status: 502, code: 'PAYMENT_OUTCOME_UNCERTAIN' });
      pineReplies.push(pine('APPROVED'));
      const uploaded = await payments.start(manager, '1', orderId, {
        ...card,
        operationId: crypto.randomUUID(),
      });
      expect(uploaded).toMatchObject({ status: 'pending', legacyStatus: 'Approved' });
      expect(
        await rows(
          'SELECT platform,plutus_id,payment_mode,store_pos_code,is_active FROM pos_terminal_transactions',
        ),
      ).toEqual([
        {
          platform: 'txn_created',
          plutus_id: '9001',
          payment_mode: 7,
          store_pos_code: 'POS5',
          is_active: 1,
        },
      ]);
      expect(
        (await payments.paymentContext(manager, '1', orderId)).activeTransaction,
      ).toMatchObject({
        provider: 'pine',
        transactionId: uploaded.transactionId,
      });
      pineReplies.push(pine('TXN UPLOADED'));
      expect((await payments.status(manager, '1', orderId, uploaded.transactionId)).status).toBe(
        'pending',
      );
      pineReplies.push(pine('TXN APPROVED'));
      expect((await payments.status(manager, '1', orderId, uploaded.transactionId)).status).toBe(
        'paid',
      );
      expect(
        await rows('SELECT platform,is_active FROM pos_terminal_transactions ORDER BY id'),
      ).toEqual([
        { platform: 'txn_created', is_active: 1 },
        { platform: 'txn_completed', is_active: 1 },
      ]);
      const [mapping] = await rows('SELECT message,online_payment FROM order_stores');
      expect(mapping!.message).toBe('card');
      expect(Number(mapping!.online_payment)).toBe(100);
      expect(pushed).toEqual([orderId]);
    });
    it('deactivates a timed-out Pine upload so the payment can be initiated again', async () => {
      pineReplies.push(pine('APPROVED'));
      const uploaded = await payments.start(manager, '1', orderId, {
        operationId: crypto.randomUUID(),
        channel: 'pine-card',
        onlineAmount: '100.00',
        cashAmount: '0.00',
        cashReceived: '0.00',
        machineId: '5',
      });
      pineReplies.push(pine('INVALID PLUTUS TXN REF ID', 1));
      expect(await payments.status(manager, '1', orderId, uploaded.transactionId)).toMatchObject({
        status: 'failed',
        message: 'Time Out, Initialize Transaction Again',
      });
      expect(await rows('SELECT is_active FROM pos_terminal_transactions')).toEqual([
        { is_active: 0 },
      ]);
      expect(await rows('SELECT comment FROM pos_transaction_logs')).toEqual([
        { comment: `Transaction Time Out for transaction Id : ${uploaded.transactionId}` },
      ]);
      const context = await payments.paymentContext(manager, '1', orderId);
      expect(context).toMatchObject({
        canRecordPayment: true,
        transactionId: 'FIXTURE-PAY-0001-2',
      });
    });
    it('ports AjaxPaymentStatusView for manual paid and revert', async () => {
      await expect(
        payments.paymentStatus(manager, '1', orderId, {
          payType: 1,
          paymentStatus: 4,
          orderStatus: 3,
          message: '',
          offlinePayment: '99',
          onlinePayment: '0',
        }),
      ).rejects.toEqual(new AppError(422, 'PAYMENT_TOTAL_MISMATCH', 'Incorrect Pay amount.'));
      await expect(
        payments.paymentStatus({ ...manager, role: 4 }, '1', orderId, {
          payType: 0,
          paymentStatus: 1,
          orderStatus: 0,
          message: '',
          offlinePayment: '0',
          onlinePayment: '0',
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await payments.paymentStatus(manager, '1', orderId, {
          payType: 1,
          paymentStatus: 4,
          orderStatus: 3,
          message: '',
          offlinePayment: '100',
          onlinePayment: '0',
        }),
      ).toEqual({ status: 'success', message: 'Payment status updated successfully.' });
      expect(pushed).toEqual([orderId]);
      await payments.paymentStatus(manager, '1', orderId, {
        payType: 0,
        paymentStatus: 1,
        orderStatus: 0,
        message: '',
        offlinePayment: '0',
        onlinePayment: '0',
      });
      expect(await rows('SELECT payment_status,order_status FROM orders')).toEqual([
        { payment_status: 1, order_status: 1 },
      ]);
      expect(await rows('SELECT status FROM has_products')).toEqual([{ status: 'PLACED' }]);
      expect(await rows('SELECT status_id,comment FROM comments ORDER BY id')).toEqual([
        { status_id: '1', comment: 'Store Order: Status Reverted to PLACED by pos admin.' },
      ]);
      expect(
        await rows(
          'SELECT order_status,payment_status,pay_dict,comment FROM pos_transaction_logs ORDER BY id',
        ),
      ).toEqual([
        {
          order_status: '3',
          payment_status: '4',
          pay_dict:
            "{'cash payment': 100.0, 'online payment': 0.0, 'total amount on counter': 100.0}",
          comment: 'Order Delivered : Total Amount Recieved at Counter : 100.0',
        },
        {
          order_status: '1',
          payment_status: '1',
          pay_dict: '{}',
          comment:
            'Store Order: Status Reverted to PLACED by pos admin. Recieved Amount Return to customer on Counter (Only counter amount)',
        },
      ]);
      expect(await rows('SELECT stale_reason FROM store_day_close')).toEqual([
        { stale_reason: 'MANUAL_PAID' },
      ]);
    });
  },
);
