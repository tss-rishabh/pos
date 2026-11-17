import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicApiFixture } from './api-fixture.js';
import { publicScreeningCoordinator } from '../../src/modules/checkout/screening-writer/coordinator.js';
import { mysqlSessions, type SessionTransaction } from '../../src/auth/sessions.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('real native session validation inside screening transactions', () => {
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
  it('twenty actual session-backed contenders reuse their financial TX instead of starving the writer pool', async () => {
    const p = await f.created();
    await f.confirm(p.creation);
    const native = mysqlSessions(f.db),
      credential = await native.create('1'),
      c = publicScreeningCoordinator(
        f.config,
        f.db,
        {},
        { proofKey: sourceKey, clock: () => financialClock },
      );
    const { app } = await f.app(c, {
      configured() {},
      async start() {
        throw new Error('No terminal');
      },
      async status() {
        throw new Error('No terminal');
      },
      async cancel() {
        throw new Error('No terminal');
      },
    });
    let inside = 0,
      outside = 0;
    app.addHook('preHandler', async (request) => {
      request.authSessionValid = (transaction?: SessionTransaction) => {
        if (transaction) inside++;
        else outside++;
        return native.valid('1', credential, transaction);
      };
    });
    try {
      const payment = f.payment(),
        url = `/api/v1/stores/1/orders/${p.creation.orderId}/payment-attempts`,
        rows = await Promise.all(
          Array.from({ length: 20 }, () => app.inject({ method: 'POST', url, payload: payment })),
        );
      expect(
        rows.every((row) => [201, 202].includes(row.statusCode)),
        rows.map((row) => row.body).join('\n'),
      ).toBe(true);
      expect(inside).toBeGreaterThan(20);
      expect(outside).toBeGreaterThan(0);
      const read = await app.inject({ url: url + '/' + payment.operationId });
      expect(read.statusCode, read.body).toBe(200);
      expect(read.json()).toMatchObject({ status: 'paid' });
      const [seals] = await f.connection.query(
        'SELECT COUNT(*) n FROM pos_rewrite_public_screening_completions',
      );
      expect(seals).toMatchObject([{ n: '1' }]);
      await native.revoke(credential.sessionId);
      const blocked = await app.inject({ url: url + '/' + payment.operationId });
      expect(blocked.statusCode).toBe(401);
      const [retained] = await f.connection.query(
        'SELECT COUNT(*) n FROM pos_rewrite_public_screening_completions',
      );
      expect(retained).toMatchObject([{ n: '1' }]);
    } finally {
      await app.close();
    }
  }, 30000);
});
