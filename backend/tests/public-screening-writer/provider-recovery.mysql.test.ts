import { getTableName } from 'drizzle-orm';
import { PosMachine, PosTerminalPaymentModes } from '../../src/db/legacy-schema.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicApiFixture } from './api-fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'retained real provider reply through public screening authority loss',
  () => {
    let f: Awaited<ReturnType<typeof publicApiFixture>>;
    beforeAll(async () => {
      f = await publicApiFixture(template!);
    }, 30000);
    beforeEach(async () => {
      await f.reset();
      f.resetScope();
    });
    afterAll(async () => {
      await f?.close();
    });
    async function pine() {
      await f.fixture.insert(getTableName(PosMachine), {
        id: '1',
        store_id: 1,
        counter_id: 2,
        is_active: 1,
        machine_name: 'Fixture terminal',
        merchant_id: 'fixture-mid',
        security_token: 'synthetic-credential',
        client_id: 'fixture-client',
        merchant_store_pos_code: 'fixture-pos',
        imei_no: 'fixture-imei',
      });
      await f.fixture.insert(getTableName(PosTerminalPaymentModes), {
        id: '1',
        mode_id: 1,
        is_active: 1,
        platform: 'PINELAB',
        name: 'Fixture card',
      });
    }
    it('a session revoked at the last paid hook rolls back settlement and COUNTED while retaining the actual cash decision', async () => {
      const p = await f.created();
      await f.confirm(p.creation);
      const original = p.c.payments.paid;
      p.c.payments.paid = async (...args) => {
        f.setValid(false);
        return original(...args);
      };
      const { app } = await f.app(p.c, {
        configured() {},
        async start() {
          throw new Error('No provider');
        },
        async status() {
          throw new Error('No provider');
        },
        async cancel() {
          throw new Error('No provider');
        },
      });
      try {
        const paid = await app.inject({
          method: 'POST',
          url: `/api/v1/stores/1/orders/${p.creation.orderId}/payment-attempts`,
          payload: f.payment(),
        });
        expect(paid.statusCode, paid.body).toBe(401);
        const [orders] = await f.connection.query('SELECT payment_status FROM orders');
        expect(orders).toMatchObject([{ payment_status: 1 }]);
        const [held] = await f.connection.query(
          'SELECT data FROM pos_rewrite_import_screening_reservations',
        );
        expect(held).toMatchObject([{ data: { phase: 'BOUND' } }]);
        const [facts] = await f.connection.query(
          'SELECT data FROM pos_rewrite_payment_provider_facts',
        );
        expect(facts).toMatchObject([
          {
            data: {
              decision: { status: 'paid', code: 'OPERATOR_RECORDED' },
              frame: { cashAmount: '50.00', cashReceived: '60.00' },
            },
          },
        ]);
      } finally {
        await app.close();
      }
    });
    it('revocation during charge retains the actual paid reply; GET then current-authority reconciliation settles without charge/status replay', async () => {
      const p = await f.created();
      await f.confirm(p.creation);
      await pine();
      const start = vi.fn(async () => {
          await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
          await f.connection.query("INSERT INTO pos_rewrite_operator_auth_epochs VALUES('1',1)");
          f.setValid(false);
          return {
            status: 'paid' as const,
            reference: 'actual-provider-reference',
            code: 'APPROVED',
          };
        }),
        status = vi.fn(async () => ({
          status: 'paid' as const,
          reference: 'unexpected-status',
          code: 'APPROVED',
        })),
        cancel = vi.fn(async () => ({
          status: 'cancelled' as const,
          reference: null,
          code: 'CANCELLED',
        }));
      const { app } = await f.app(p.c, { configured() {}, start, status, cancel }),
        payment = {
          ...f.payment(),
          channel: 'pine-card',
          machineId: '1',
          cashAmount: '10.00',
          onlineAmount: '40.00',
          cashReceived: '20.00',
        },
        url = `/api/v1/stores/1/orders/${p.creation.orderId}/payment-attempts`;
      try {
        const reply = await app.inject({ method: 'POST', url, payload: payment });
        expect(reply.statusCode, reply.body).toBe(401);
        const [facts] = await f.connection.query(
          'SELECT data FROM pos_rewrite_payment_provider_facts',
        );
        expect(facts).toMatchObject([
          {
            data: {
              frame: {
                attemptId: payment.operationId,
                action: 'start',
                currency: 'INR',
                onlineAmount: '40.00',
                cashAmount: '10.00',
              },
              decision: { status: 'paid', reference: 'actual-provider-reference' },
            },
          },
        ]);
        const [before] = await f.connection.query('SELECT payment_status FROM orders');
        expect(before).toMatchObject([{ payment_status: 1 }]);
        const [bound] = await f.connection.query(
          'SELECT data FROM pos_rewrite_import_screening_reservations',
        );
        expect(bound).toMatchObject([{ data: { phase: 'BOUND' } }]);
        const [attempts] = await f.connection.query(
          'SELECT state FROM pos_rewrite_payment_attempts',
        );
        expect(attempts).toMatchObject([
          {
            state: {
              status: 'uncertain',
              busyOperationId: null,
              heldProviderDecision: { status: 'paid', reference: 'actual-provider-reference' },
            },
          },
        ]);
        f.setValid(true);
        await f.connection.query('UPDATE pos_user SET is_active=1 WHERE id=1');
        const get = await app.inject({ url: url + '/' + payment.operationId });
        expect(get.statusCode, get.body).toBe(200);
        expect(get.json()).toMatchObject({
          status: 'uncertain',
          errorCode: 'PAYMENT_REPLY_RETAINED',
        });
        expect(get.body).not.toContain('heldProviderDecision');
        expect(get.body).not.toContain('synthetic-credential');
        const paid = await app.inject({
          method: 'POST',
          url: url + '/' + payment.operationId + '/reconciliations',
          payload: {},
        });
        expect(paid.statusCode, paid.body).toBe(200);
        expect(paid.json()).toMatchObject({
          status: 'paid',
          providerReference: 'actual-provider-reference',
        });
        const replay = await app.inject({
          method: 'POST',
          url: url + '/' + payment.operationId + '/reconciliations',
          payload: {},
        });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(start).toHaveBeenCalledTimes(1);
        expect(status).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        const [after] = await f.connection.query(
          'SELECT offline_payment,offline_payment_recieved,online_payment FROM order_stores',
        );
        expect(after).toMatchObject([
          { offline_payment: 10, offline_payment_recieved: 20, online_payment: 40 },
        ]);
        const [counted] = await f.connection.query(
          'SELECT data FROM pos_rewrite_import_screening_reservations',
        );
        expect(counted).toMatchObject([{ data: { phase: 'COUNTED' } }]);
      } finally {
        await app.close();
      }
    });
  },
);
