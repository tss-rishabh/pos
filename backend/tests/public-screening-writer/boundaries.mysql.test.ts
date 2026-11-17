import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicApiFixture, screeningUser } from './api-fixture.js';
import { publicScreeningPublicationWorker } from '../../src/modules/checkout/screening-writer/publication.js';
import { publicScreeningRecovery } from '../../src/modules/checkout/screening-writer/recovery.js';
import { publicScreeningRequest } from '../../src/modules/checkout/screening-writer/request-scope.js';
import { financialClock } from '../legacy-import-financial/fixture.js';
import { run } from './native-fixture.js';
import type { PaymentGateway } from '../../src/modules/checkout/payments/contracts.js';
const io: PaymentGateway = {
  configured() {},
  async start() {
    throw new Error('No provider dispatch permitted');
  },
  async status() {
    throw new Error('No provider status permitted');
  },
  async cancel() {
    throw new Error('No provider cancel permitted');
  },
};
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('screening native zero/unsent/late authority boundaries', () => {
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
  const url = (p: { checkoutId: string; operationId: string }) =>
    `/api/v1/stores/1/checkout-sessions/${p.checkoutId}/screening-admissions/${p.operationId}`;
  it('coordinator, recovery and worker constructors do no SQL/network I/O', () => {
    const access = vi.spyOn(f.db, 'get').mockImplementation(() => {
      throw new Error('Unexpected construction I/O');
    });
    try {
      expect(() => {
        const c = f.coordinator();
        publicScreeningRecovery(c);
        publicScreeningPublicationWorker(c);
      }).not.toThrow();
      expect(access).not.toHaveBeenCalled();
    } finally {
      access.mockRestore();
    }
  });
  it('actual source zero-pay creation uses original submission receipt and no fabricated payment attempt', async () => {
    const p = await f.created({}, '0.00');
    expect(p.creation.method).toBe(3);
    await f.confirm(p.creation, true);
    const { app } = await f.app(p.c, io);
    app.post('/fixture/prepaid-final-writer', async (request) =>
      publicScreeningRequest(request, screeningUser, () =>
        p.c.finalization.transaction(p.state, p.creation.orderId, (tx) =>
          p.c.finalization.finish(tx, p.creation.orderId),
        ),
      ),
    );
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/fixture/prepaid-final-writer',
        payload: {},
      });
      expect(first.statusCode, first.body).toBe(200);
      const again = await app.inject({
        method: 'POST',
        url: '/fixture/prepaid-final-writer',
        payload: {},
      });
      expect(again.statusCode, again.body).toBe(200);
      const read = await app.inject({ url: url(p.scope) });
      expect(read.json()).toMatchObject({
        status: 'completed',
        paymentReceiptId: p.scope.operationId,
      });
      const [attempts] = await f.connection.query(
        'SELECT COUNT(*) n FROM pos_rewrite_payment_attempts',
      );
      expect(attempts).toMatchObject([{ n: '0' }]);
      const [cash] = await f.connection.query(
        'SELECT offline_payment,offline_payment_recieved FROM order_stores',
      );
      expect(cash).toMatchObject([{ offline_payment: 0, offline_payment_recieved: 0 }]);
    } finally {
      await app.close();
    }
  });
  it('only an expired native PREPARED admission without a dispatch/reservation can close, fencing a delayed source call', async () => {
    const p = await f.prepare(); // Already dispatched: absence of a source order is never no-effects proof.
    f.setNow(financialClock + 61000);
    const { app } = await f.app(p.c, io);
    try {
      const blocked = await app.inject({
        method: 'POST',
        url: url(p.scope) + '/closures',
        payload: {},
      });
      expect(blocked.statusCode, blocked.body).toBe(409);
    } finally {
      await app.close();
    }
    await f.reset();
    f.resetScope();
    const raw = await f.prepare({}, '25.00', false),
      c = raw.c;
    f.setNow(financialClock + 61000);
    const ready = await f.app(c, io);
    try {
      const closed = await ready.app.inject({
        method: 'POST',
        url: url(raw.scope) + '/closures',
        payload: {},
      });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(closed.json()).toMatchObject({ status: 'closed-unsent' });
      const replay = await ready.app.inject({
        method: 'POST',
        url: url(raw.scope) + '/closures',
        payload: {},
      });
      expect(replay.statusCode, replay.body).toBe(200);
      const read = await ready.app.inject({ url: url(raw.scope) });
      expect(read.json()).toMatchObject({ status: 'closed-unsent' });
      expect(run(raw.value)).toMatchObject({ code: 'SCREENING_WRITER_SCOPE_CHANGED' });
    } finally {
      await ready.app.close();
    }
  });
  it('late session revocation after native read hides all source/result data without deleting original evidence', async () => {
    const p = await f.created(),
      { app } = await f.app(f.coordinator({ authSessionValid: undefined }), io);
    let calls = 0;
    app.addHook('preHandler', async (request) => {
      request.authSessionValid = async () => ++calls < 5;
    });
    try {
      const read = await app.inject({ url: url(p.scope) });
      expect(read.statusCode, read.body).toBe(401);
      expect(read.body).not.toContain(p.creation.orderId);
      const [rows] = await f.connection.query(
        'SELECT COUNT(*) n FROM pos_rewrite_public_screening_orders',
      );
      expect(rows).toMatchObject([{ n: '1' }]);
    } finally {
      await app.close();
    }
  });
});
