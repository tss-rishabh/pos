import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicApiFixture, screeningUser } from './api-fixture.js';
import { registerCheckout } from '../../src/modules/checkout/routes.js';
import { readPublicScreeningCreation } from '../../src/modules/checkout/screening-writer/proof.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
import { environment, run } from './native-fixture.js';
import { signingEnvironment } from '../checkout/fixtures.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('actual checkout submission public-screening composition', () => {
  let f: Awaited<ReturnType<typeof publicApiFixture>>;
  beforeAll(async () => {
    f = await publicApiFixture(template!);
  }, 30000);
  beforeEach(async () => {
    await f.reset();
    f.resetScope();
    vi.spyOn(Date, 'now').mockReturnValue(financialClock);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await f?.close();
  });
  it('ordinary API submit uses native issuer/checkpoint, exact source PosOrder and independent confirmation; original replay dispatches neither again', async () => {
    const p = await f.initialQuoted(),
      app = Fastify();
    let orders = 0,
      confirmations = 0;
    let sourceResult: unknown = null;
    app.decorateRequest('principal', null);
    app.decorateRequest('authSessionValid', null);
    app.addHook('preHandler', async (request) => {
      request.principal = screeningUser;
      request.authSessionValid = async () => true;
    });
    registerCheckout(app, f.config, f.db, {
      environment: { ...signingEnvironment, ...environment },
      publicScreening: {
        contract: 'pos-node-screening-writer-v1',
        proofKey: sourceKey,
        clock: () => financialClock,
      },
      gateway: {
        async api(path, payload, _token, internal) {
          if (path !== 'pos/order') return p.state.quote;
          orders++;
          expect(internal?.screeningWriter).toBeTruthy();
          const value = run({ ...p.value, payload, header: internal!.screeningWriter });
          sourceResult = value;
          if (!value || typeof value !== 'object' || !('result' in value))
            throw new Error('Actual source refused ordinary wire');
          return value.result;
        },
        async confirm() {
          confirmations++;
          const proof = await f.db
            .get('writer')
            .transaction((tx) =>
              readPublicScreeningCreation(
                tx,
                p.state.busyOperationId ?? p.signed.value.operationId,
                sourceKey,
              ),
            );
          if (!proof) throw new Error('Native source receipt missing');
          await f.confirm(proof);
          return {};
        },
        async exchangeReasons() {
          return [];
        },
      },
      // Invoice delivery has its own full-stack acceptance. This fixture leaves
      // it outside the financial source/Go/payment proof boundary being tested.
      finalizeOrder: async () => ({ transactionId: 'fixture-invoice', invoice: null }),
    });
    try {
      const url = `/api/v1/stores/1/checkout-sessions/${p.state.id}/order-submissions`,
        input = { operationId: p.signed.value.operationId, expectedVersion: p.state.version };
      const first = await app.inject({ method: 'POST', url, payload: input });
      expect(
        first.statusCode,
        JSON.stringify({ body: first.body, sourceResult, orders, confirmations }),
      ).toBe(201);
      expect(first.json()).toMatchObject({
        state: {
          phase: 'submitted',
          screeningAdmission: { operationId: input.operationId, status: 'created' },
        },
        result: { paymentStatus: 'pending' },
      });
      const replay = await app.inject({ method: 'POST', url, payload: input });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(orders).toBe(1);
      expect(confirmations).toBe(1);
      const [rows] = await f.connection.query(
        'SELECT status FROM pos_rewrite_public_screening_work',
      );
      expect(rows).toMatchObject([{ status: 'awaiting-payment' }]);
    } finally {
      await app.close();
    }
  }, 30000);
});
