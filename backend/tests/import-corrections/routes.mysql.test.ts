import Fastify from 'fastify';
import { ZodError } from 'zod';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerLegacyOrderImportCorrections } from '../../src/modules/legacy-order-imports/correction-routes.js';
import { importCorrections } from '../../src/modules/legacy-order-imports/correction-schema.js';
import { legacyOrderImports } from '../../src/modules/legacy-order-imports/schema.js';
import { registerEventCatalog, resourceRoutes } from '../../src/observability/events.js';
import { AppError } from '../../src/domain/errors.js';
import { correctionActor as actor, correctionCommand, correctionFixture } from './fixture.js';

const template = process.env.LEGACY_ORDER_IMPORT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'native correction HTTP session/scope and original-reference recovery',
  () => {
    let native: Awaited<ReturnType<typeof correctionFixture>>,
      sessionId: string,
      original: { jobId: string; operationId: string };
    beforeAll(async () => {
      native = await correctionFixture(template!);
    });
    afterAll(async () => native?.close());
    beforeEach(async () => {
      sessionId = (await native.reset()).sessionId;
      original = await native.original();
    });
    async function http() {
      const app = Fastify({ logger: false });
      let failAfter = false;
      app.decorateRequest('principal', null);
      app.decorateRequest('authSessionId', null);
      app.decorateRequest('authSessionValid', null);
      registerEventCatalog(app);
      app.addHook('onRequest', async (request) => {
        request.principal = request.headers['x-anonymous'] ? null : actor;
        request.authSessionId = request.headers['x-no-session'] ? null : sessionId;
        let calls = 0;
        request.authSessionValid = async () => !(failAfter && ++calls > 1);
      });
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof AppError)
          return reply
            .code(error.status)
            .send({ error: { code: error.code, message: error.message } });
        return reply.code(error instanceof ZodError ? 400 : 500).send({
          error: { code: 'REQUEST_FAILED', message: 'The correction could not be confirmed.' },
        });
      });
      registerLegacyOrderImportCorrections(app, native.config, native.db, {
        service: native.corrections,
      });
      await app.ready();
      return {
        app,
        setFailAfter: (value: boolean) => {
          failAfter = value;
        },
        base: `/api/v1/admin/order-imports/${original.jobId}/orders/${original.operationId}/corrections`,
      };
    }
    async function command() {
      const value = await native.corrections.review(
        actor,
        original.jobId,
        original.operationId,
        sessionId,
      );
      return correctionCommand(value.reviewHash!);
    }
    it('returns a bounded review plus original-UUID202/GET receipt with registered trace metadata', async () => {
      const server = await http();
      try {
        const response = await server.app.inject({ method: 'GET', url: server.base }),
          input = await command(),
          posted = await server.app.inject({ method: 'POST', url: server.base, payload: input }),
          recovered = await server.app.inject({ method: 'GET', url: server.base + '/' + input.id });
        expect(response.statusCode).toBe(200);
        expect(posted.statusCode).toBe(202);
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json<unknown>()).toEqual({
          status: 'accepted',
          receipt: posted.json<unknown>(),
        });
        expect(posted.headers['cache-control']).toBe('private, no-store');
        expect(response.body + posted.body).not.toMatch(
          /private-import@|Private fixture|Private fixture message/,
        );
        expect(
          resourceRoutes(server.app).filter(
            (route) => route.resource === 'order-import-correction',
          ),
        ).toHaveLength(3);
      } finally {
        await server.app.close();
      }
    });
    it('recovers a post-commit revoked-session response only by GET of that same correction', async () => {
      const input = await command(),
        server = await http();
      try {
        server.setFailAfter(true);
        expect(
          (await server.app.inject({ method: 'POST', url: server.base, payload: input }))
            .statusCode,
        ).toBe(401);
        expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(1);
        server.setFailAfter(false);
        const known = await server.app.inject({ method: 'GET', url: server.base + '/' + input.id });
        expect(known.statusCode).toBe(200);
        expect(known.json<unknown>()).toMatchObject({
          status: 'accepted',
          receipt: { id: input.id, successorOperationId: input.successorOperationId },
        });
        expect(await native.db.get('writer').select().from(legacyOrderImports)).toHaveLength(2);
      } finally {
        await server.app.close();
      }
    });
    it('rejects missing sessions and browser-supplied source proof/manager authority', async () => {
      const input = await command(),
        server = await http();
      try {
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: server.base,
              payload: input,
              headers: { 'x-anonymous': 'true' },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: server.base,
              payload: input,
              headers: { 'x-no-session': 'true' },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await server.app.inject({
              method: 'POST',
              url: server.base,
              payload: {
                ...input,
                noFinancialEffects: true,
                managerId: '2',
                privateEmail: 'fixture-private@example.test',
              },
            })
          ).statusCode,
        ).toBe(400);
        expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
      } finally {
        await server.app.close();
      }
    });
    it('retains a recovery fence even when its post-commit session reply is lost', async () => {
      const input = await command(),
        server = await http();
      try {
        server.setFailAfter(true);
        expect(
          (await server.app.inject({ method: 'GET', url: server.base + '/' + input.id }))
            .statusCode,
        ).toBe(401);
        server.setFailAfter(false);
        const recovered = await server.app.inject({
          method: 'GET',
          url: server.base + '/' + input.id,
        });
        expect(recovered.statusCode).toBe(200);
        expect(recovered.json<unknown>()).toMatchObject({
          status: 'not-created',
          id: input.id,
          noSuccessorQueued: true,
          latePostsFenced: true,
        });
        expect(
          (await server.app.inject({ method: 'POST', url: server.base, payload: input }))
            .statusCode,
        ).toBe(409);
        expect(await native.db.get('writer').select().from(importCorrections)).toHaveLength(0);
      } finally {
        await server.app.close();
      }
    });
    it('corrupted immutable receipt evidence blocks both native resolver and HTTP recovery', async () => {
      const input = await command();
      await native.corrections.create(
        actor,
        original.jobId,
        original.operationId,
        input,
        sessionId,
        'fixture-http-correction',
      );
      const [row] = await native.db.get('writer').select().from(importCorrections);
      await native.db
        .get('writer')
        .update(importCorrections)
        .set({ receipt: { ...row!.receipt, historicalTenderAmount: '999.00' } })
        .where(eq(importCorrections.id, input.id));
      await expect(
        native.db.get('writer').transaction((tx) =>
          native.corrections.correctionForOperation(tx, {
            actorId: '1',
            operationId: input.successorOperationId,
            storeId: '1',
            counterId: '2',
          }),
        ),
      ).rejects.toMatchObject({ code: 'ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID' });
      const server = await http();
      try {
        const response = await server.app.inject({
          method: 'GET',
          url: server.base + '/' + input.id,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json<unknown>()).toMatchObject({
          error: { code: 'ORDER_IMPORT_CORRECTION_EVIDENCE_INVALID' },
        });
      } finally {
        await server.app.close();
      }
    });
  },
);
