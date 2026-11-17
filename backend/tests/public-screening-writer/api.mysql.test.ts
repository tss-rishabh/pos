import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicApiFixture, screeningUser } from './api-fixture.js';
import { publicScreeningCoordinator } from '../../src/modules/checkout/screening-writer/coordinator.js';
import { publicScreeningRecovery } from '../../src/modules/checkout/screening-writer/recovery.js';
import { publicScreeningPublicationWorker } from '../../src/modules/checkout/screening-writer/publication.js';
import { publicScreeningHash } from '../../src/modules/checkout/screening-writer/proof.js';
import { paymentRepository } from '../../src/modules/checkout/payments/repository.js';
import { paymentService } from '../../src/modules/checkout/payments/service.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
import { signingEnvironment } from '../checkout/fixtures.js';
import { Temporal } from '@js-temporal/polyfill';
import type { PaymentGateway } from '../../src/modules/checkout/payments/contracts.js';
import { run } from './native-fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const gateway = (): PaymentGateway => ({
  configured() {},
  start: vi.fn(async () => ({
    status: 'paid' as const,
    reference: 'fixture-provider-paid',
    code: 'APPROVED',
  })),
  status: vi.fn(async () => ({
    status: 'paid' as const,
    reference: 'fixture-provider-paid',
    code: 'APPROVED',
  })),
  cancel: vi.fn(async () => ({
    status: 'cancelled' as const,
    reference: 'fixture-provider-paid',
    code: 'CANCELLED',
  })),
});
describe.skipIf(!template)('actual public screening API/payment/publication composition', () => {
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
  const path = (p: { storeId: string; checkoutId: string; operationId: string }) =>
    `/api/v1/stores/${p.storeId}/checkout-sessions/${p.checkoutId}/screening-admissions/${p.operationId}`;
  it('native issue and immutable checkpoint precede source; a retry cannot reissue a capability', async () => {
    const p = await f.prepare();
    await expect(
      p.c.service.issue(screeningUser, p.state, p.scope.operationId, p.value.payload),
    ).rejects.toMatchObject({ code: 'SCREENING_ADMISSION_ALREADY_REQUESTED' });
    const [rows] = await f.connection.query('SELECT status FROM pos_rewrite_public_screening_work');
    expect(rows).toMatchObject([{ status: 'awaiting-source' }]);
    const [sent] = await f.connection.query(
      'SELECT COUNT(*) n FROM pos_rewrite_public_screening_submission_dispatches',
    );
    expect(sent).toMatchObject([{ n: '1' }]);
  });
  it('lost source reply is recovered by exact original identity; no order/confirmation/provider redispatch', async () => {
    const p = await f.prepare();
    expect(run(p.value)).toHaveProperty('result');
    await f.connection.query("UPDATE pos_rewrite_checkout_operations SET status='uncertain'");
    const { app } = await f.app(p.c, gateway());
    try {
      const read = await app.inject({ url: path(p.scope) });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ status: 'awaiting-payment', canAbandon: true });
      const reconcile = await app.inject({
        method: 'POST',
        url: path(p.scope) + '/reconciliations',
        payload: {},
      });
      expect(reconcile.statusCode, reconcile.body).toBe(200);
      const [rows] = await f.connection.query('SELECT state FROM pos_rewrite_checkout_sessions');
      expect(rows).toMatchObject([
        {
          state: {
            phase: 'order-created',
            confirmationPhase: 'not-dispatched',
            orderSubmissionOperationId: p.scope.operationId,
            busyOperationId: null,
          },
        },
      ]);
      const [orders] = await f.connection.query('SELECT COUNT(*) n FROM orders');
      expect(orders).toMatchObject([{ n: '1' }]);
      const [proof] = await f.connection.query(
        'SELECT COUNT(*) n FROM pos_rewrite_checkout_projections',
      );
      expect(proof).toMatchObject([{ n: '0' }]);
      expect(read.body + reconcile.body).not.toContain('contact');
      expect(read.body).not.toContain(p.value.key);
    } finally {
      await app.close();
    }
  });
  it('twenty paid callbacks seal a real cash receipt and COUNTED once, with unchanged cash received/change', async () => {
    const p = await f.created();
    await f.confirm(p.creation);
    const io = gateway(),
      { app } = await f.app(p.c, io),
      payment = f.payment(),
      url = `/api/v1/stores/1/orders/${p.creation.orderId}/payment-attempts`;
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => app.inject({ method: 'POST', url, payload: payment })),
      );
      expect(results.filter((row) => row.statusCode === 201)).toHaveLength(1);
      expect(
        results.every((row) => [201, 202].includes(row.statusCode)),
        results.map((row) => row.body).join('\n'),
      ).toBe(true);
      const [orders] = await f.connection.query(
        'SELECT offline_payment,offline_payment_recieved FROM order_stores',
      );
      expect(orders).toMatchObject([{ offline_payment: 50, offline_payment_recieved: 60 }]);
      for (const table of [
        'pos_rewrite_public_screening_completions',
        'pos_rewrite_public_screening_payment_evidence',
        'pos_rewrite_payment_attempts',
      ]) {
        const [rows] = await f.connection.query('SELECT COUNT(*) n FROM ' + table);
        expect(rows).toMatchObject([{ n: '1' }]);
      }
      const [held] = await f.connection.query(
        'SELECT data FROM pos_rewrite_import_screening_reservations',
      );
      expect(held).toMatchObject([{ data: { phase: 'COUNTED', kind: 'pos' } }]);
      expect(io.start).not.toHaveBeenCalled();
      expect(io.status).not.toHaveBeenCalled();
      const disabled = publicScreeningCoordinator(
          f.config,
          f.db,
          {},
          { proofKey: sourceKey, clock: () => financialClock, authSessionValid: async () => true },
        ),
        recovery = publicScreeningRecovery(disabled);
      expect(await recovery.read(screeningUser, p.scope)).toMatchObject({
        status: 'completed',
        paymentReceiptId: payment.operationId,
      });
      const read = await app.inject({ url: url + '/' + payment.operationId });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ status: 'paid' });
    } finally {
      await app.close();
    }
  });
  it.each(['projection', 'paid-proof', 'receipt-intent'] as const)(
    'missing/tampered %s cannot manufacture COUNTED; cash remains uncertain for reconciliation',
    async (kind) => {
      const p = await f.created();
      await f.confirm(p.creation);
      if (kind === 'projection')
        await f.connection.query(
          "UPDATE pos_rewrite_checkout_projections SET input_hash=REPEAT('f',64)",
        );
      const repo = paymentRepository(f.db, f.config, {
          screening: p.c.payments,
          hashSecret: f.config.SESSION_SECRET,
          projection: signingEnvironment,
          clock: () => Temporal.Instant.fromEpochMilliseconds(financialClock),
        }),
        service = paymentService(repo, gateway());
      if (kind === 'projection') {
        await expect(
          service.start(screeningUser, '1', p.creation.orderId, f.payment()),
        ).rejects.toBeDefined();
      } else {
        const payment = f.payment(),
          pending = await repo.begin(screeningUser, '1', p.creation.orderId, payment);
        if (kind === 'receipt-intent')
          await f.connection.query(
            "UPDATE pos_rewrite_public_screening_payment_evidence SET intent_hash=REPEAT('f',64)",
          );
        else
          await f.connection.query(
            "CREATE TRIGGER fixture_reject_paid BEFORE INSERT ON pos_rewrite_public_screening_completions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture late failure'",
          );
        try {
          await expect(
            repo.decision(
              screeningUser,
              '1',
              p.creation.orderId,
              payment.operationId,
              { status: 'paid', reference: 'cash-original', code: 'OPERATOR_RECORDED' },
              null,
              pending.attempt.busyOperationId,
            ),
          ).rejects.toBeDefined();
        } finally {
          if (kind === 'paid-proof') await f.connection.query('DROP TRIGGER fixture_reject_paid');
        }
      }
      const [counted] = await f.connection.query(
        'SELECT data FROM pos_rewrite_import_screening_reservations',
      );
      expect(counted).toMatchObject([{ data: { phase: 'BOUND' } }]);
      const [cash] = await f.connection.query('SELECT offline_payment FROM order_stores');
      expect(cash).toMatchObject([{ offline_payment: 0 }]);
    },
  );
  it('immutable unpaid abandonment survives lost acknowledgement and fences delayed confirmation/payment without deleting HPs', async () => {
    const p = await f.created(),
      { app } = await f.app(p.c, gateway()),
      body = { commandId: randomUUID(), reason: 'cash-abandoned' };
    try {
      const done = await app.inject({
        method: 'POST',
        url: path(p.scope) + '/abandonments',
        payload: body,
      });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ status: 'abandoned' });
      const again = await app.inject({
        method: 'POST',
        url: path(p.scope) + '/abandonments',
        payload: body,
      });
      expect(again.statusCode, again.body).toBe(200);
      const read = await app.inject({ url: path(p.scope) });
      expect(read.json()).toMatchObject({ status: 'abandoned', publicationStatus: 'cancelled' });
      const [rows] = await f.connection.query('SELECT COUNT(*) n FROM has_products');
      expect(rows).toMatchObject([{ n: '1' }]);
      const [order] = await f.connection.query('SELECT order_status,payment_status FROM orders');
      expect(order).toMatchObject([{ order_status: 0, payment_status: 0 }]);
    } finally {
      await app.close();
    }
  });
  it('native paid-writer authenticates real receipt before its COUNTED seal', async () => {
    const p = await f.created();
    await f.confirm(p.creation);
    const repo = paymentRepository(f.db, f.config, {
        screening: p.c.payments,
        hashSecret: f.config.SESSION_SECRET,
        projection: signingEnvironment,
        clock: () => Temporal.Instant.fromEpochMilliseconds(financialClock),
      }),
      input = f.payment();
    const began = await repo.begin(screeningUser, '1', p.creation.orderId, input);
    expect(
      await repo.decision(
        screeningUser,
        '1',
        p.creation.orderId,
        input.operationId,
        { status: 'paid', reference: 'native-cash-original', code: 'OPERATOR_RECORDED' },
        null,
        began.attempt.busyOperationId,
      ),
    ).toMatchObject({ status: 'paid' });
  });
  it('publication commits original dispatch before POST; lost accepted reply recovers through GET only even with admission disabled', async () => {
    let replies = 0;
    const methods: string[] = [];
    const p = await f.created();
    await f.confirm(p.creation);
    const io = gateway(),
      { app } = await f.app(p.c, io);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/stores/1/orders/${p.creation.orderId}/payment-attempts`,
        payload: f.payment(),
      });
      expect(response.statusCode, response.body).toBe(201);
      const [rows] = await f.connection.query(
        'SELECT data FROM pos_rewrite_public_screening_completions',
      );
      const completion = (rows as { data: unknown }[])[0]!.data;
      const fetcher: typeof fetch = async (_url, init) => {
        methods.push(init?.method ?? 'GET');
        const [dispatch] = await f.connection.query(
          'SELECT COUNT(*) n FROM pos_rewrite_public_screening_publication_dispatches',
        );
        expect(dispatch).toMatchObject([{ n: '1' }]);
        if (replies++ === 0) throw new Error('lost accepted reply');
        const data = {
          contract: 'pos-node-screening-publication-v1',
          operationId: p.scope.operationId,
          creationHash: publicScreeningHash(sourceKey, 'creation', p.creation),
          completionHash: publicScreeningHash(sourceKey, 'completion', completion),
          effectsHash: p.creation.effectsHash,
          status: 'accepted',
          deliveries: [{ id: p.scope.operationId + ':cart', kind: 'cart-tracking' }],
          updatedAt: financialClock + 31000,
        };
        return Response.json({
          data,
          proofHash: publicScreeningHash(sourceKey, 'publication', data),
        });
      };
      const options = {
        publicationUrl: 'https://private.example.test/internal/pos/public-screening/publications',
        publicationKey: 'isolated-publication-key-'.repeat(3),
        publicationContract: 'pos-node-screening-publication-resource-v1' as const,
        fetcher,
      };
      const worker = publicScreeningPublicationWorker(f.coordinator(options));
      expect(await worker.one(p.scope.operationId)).toBe('uncertain');
      f.setNow(financialClock + 31000);
      const later = publicScreeningPublicationWorker(
        f.coordinator({ ...options, contract: undefined, publicationContract: undefined }),
      );
      expect(await later.one(p.scope.operationId)).toBe('accepted');
      expect(methods).toEqual(['POST', 'GET']);
      expect(await later.one(p.scope.operationId)).toBe('skipped');
      expect(methods).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});
