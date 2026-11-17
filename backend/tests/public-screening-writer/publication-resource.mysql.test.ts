import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { publicApiFixture } from './api-fixture.js';
import { publicScreeningPublicationWorker } from '../../src/modules/checkout/screening-writer/publication.js';
import { sourceKey, financialClock } from '../legacy-import-financial/fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL,
  driver =
    process.env.POS_PUBLIC_SCREENING_PUBLICATION_DRIVER ??
    resolve('tools/source-runtime-acceptance/publication_native_driver.py'),
  python = resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python');
const resultSchema = z.object({
  responses: z.array(z.object({ status: z.string(), body: z.unknown() })),
  queueCalls: z.number(),
  events: z.array(z.record(z.string(), z.unknown())),
});
describe.skipIf(!template || !existsSync(driver))(
  'actual Node paid writer → WSGI resource → retained broker receipt',
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
    it('lost accepted HTTP reply recovers through the authenticated source GET without republishing or repeating money', async () => {
      const p = await f.created();
      await f.confirm(p.creation);
      const { app } = await f.app(p.c, {
        configured() {},
        async start() {
          throw new Error('No terminal dispatch');
        },
        async status() {
          throw new Error('No terminal inquiry');
        },
        async cancel() {
          throw new Error('No terminal cancellation');
        },
      });
      try {
        const paid = await app.inject({
          method: 'POST',
          url: `/api/v1/stores/1/orders/${p.creation.orderId}/payment-attempts`,
          payload: f.payment(),
        });
        expect(paid.statusCode, paid.body).toBe(201);
        const methods: string[] = [],
          queues: number[] = [];
        let lose = true;
        const key = 'isolated-native-publication-caller-key-'.repeat(2),
          fetcher: typeof fetch = async (_url, init) => {
            const method = init?.method ?? 'GET';
            methods.push(method);
            expect(new Headers(init?.headers).get('X-POS-Public-Screening-Publication-Key')).toBe(
              key,
            );
            const native = resultSchema.parse(
              JSON.parse(
                execFileSync(python, ['-B', driver], {
                  input: JSON.stringify({
                    url: f.config.MYSQL_WRITER_URL,
                    operationId: p.scope.operationId,
                    proofKey: sourceKey,
                    publicationKey: key,
                    now: financialClock + 31000,
                    methods: [method],
                    recoveryOnly: method === 'GET',
                  }),
                  encoding: 'utf8',
                  timeout: 15000,
                  maxBuffer: 64000,
                }),
              ) as unknown,
            );
            expect(native.responses[0]?.status).toBe('200 OK');
            queues.push(native.queueCalls);
            if (lose) {
              lose = false;
              throw new Error('Lost genuine accepted response');
            }
            return Response.json(native.responses[0]!.body);
          };
        const options = {
          publicationUrl: 'https://private.example.test/internal/pos/public-screening/publications',
          publicationKey: key,
          publicationContract: 'pos-node-screening-publication-resource-v1' as const,
          fetcher,
        };
        expect(
          await publicScreeningPublicationWorker(f.coordinator(options)).one(p.scope.operationId),
        ).toBe('uncertain');
        f.setNow(financialClock + 31000);
        const worker = publicScreeningPublicationWorker(
          f.coordinator({ ...options, contract: undefined, publicationContract: undefined }),
        );
        expect(await worker.one(p.scope.operationId)).toBe('accepted');
        expect(await worker.one(p.scope.operationId)).toBe('skipped');
        expect(methods).toEqual(['POST', 'GET']);
        expect(queues[0]).toBeGreaterThan(0);
        expect(queues[1]).toBe(0);
        const [effects] = await f.connection.query(
          'SELECT status FROM pos_rewrite_public_screening_effects',
        );
        expect(effects).toMatchObject([{ status: 'accepted' }]);
        const [money] = await f.connection.query(
          'SELECT offline_payment,offline_payment_recieved FROM order_stores',
        );
        expect(money).toMatchObject([{ offline_payment: 50, offline_payment_recieved: 60 }]);
      } finally {
        await app.close();
      }
    }, 30000);
  },
);
