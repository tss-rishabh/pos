import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq, getTableName, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import { PosUser, StoreCounter, UserStore } from '../../src/db/legacy-schema.js';
import { registerEventCatalog, resourceRoutes } from '../../src/observability/events.js';
import { registerLegacyOrderImports } from '../../src/modules/legacy-order-imports/index.js';
import { legacyOrderImportService } from '../../src/modules/legacy-order-imports/service.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { readLegacyOrderImportOptions } from '../../src/modules/legacy-order-imports/options.js';
import {
  financialImportApprovalSchema,
  financialImportScopeSchema,
  type FinancialImportApprovalView,
} from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import { expectedFinancialPlanHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  legacyOrderImportWorker,
  type OrderImportWorkerEvent,
} from '../../src/modules/legacy-order-imports/worker.js';
import {
  legacyOrderImports,
  legacyOrderImportRows,
} from '../../src/modules/legacy-order-imports/schema.js';
import type {
  ImportFinancialAdapter,
  ImportFinancialResult,
  ImportFinancialScope,
} from '../../src/modules/legacy-order-imports/financial-contracts.js';
import {
  orderImportRuntimeFixture,
  runtimeImportInput,
  runtimeImportSecret,
} from './runtime-fixture.js';

const template = process.env.LEGACY_ORDER_IMPORT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'native CSV job API/worker coordination (synthetic financial port)',
  () => {
    let fixture: Awaited<ReturnType<typeof orderImportRuntimeFixture>>,
      app: FastifyInstance,
      service: ReturnType<typeof registerLegacyOrderImports>,
      sessionMode: 'valid' | 'missing' | 'revoke',
      validationCalls: number,
      starts: number,
      reads: number,
      dropStart: boolean;
    const operator: Principal = {
        id: '1',
        role: 1,
        userType: 1,
        storeIds: [],
        name: 'Fixture admin',
        email: 'operator@example.test',
      },
      outcomes = new Map<string, ImportFinancialResult>(),
      approvalReceipts = new Map<string, FinancialImportApprovalView>();
    const result = (scope: ImportFinancialScope): ImportFinancialResult => ({
      status: 'completed',
      operationId: scope.operationId,
      orderId: '9007199254740993',
      receiptId: randomUUID(),
      businessDate: '2026-06-15',
      projectionHash: 'a'.repeat(64),
    });
    beforeAll(async () => {
      fixture = await orderImportRuntimeFixture(template!);
      const adapter: ImportFinancialAdapter = {
        async start(input) {
          starts++;
          const value = result(input);
          outcomes.set(input.operationId, value);
          if (dropStart) throw new Error('Private provider payload must never be logged');
          return value;
        },
        async read(input) {
          reads++;
          return outcomes.get(input.operationId) ?? null;
        },
      };
      app = Fastify({ logger: false });
      registerEventCatalog(app);
      app.decorateRequest('principal', null);
      app.decorateRequest('authSessionValid', null);
      app.addHook('preHandler', async (request) => {
        request.principal = request.headers['x-anonymous'] === 'true' ? null : operator;
        request.authSessionValid =
          sessionMode === 'missing'
            ? null
            : async () => sessionMode !== 'revoke' || ++validationCalls === 1;
      });
      app.setErrorHandler((error, _request, reply) =>
        error instanceof AppError
          ? reply.code(error.status).send({ error: { code: error.code, message: error.message } })
          : error instanceof ZodError
            ? reply.code(400).send({
                error: { code: 'INVALID_REQUEST', message: 'Use a valid import request.' },
              })
            : reply.code(500).send({
                error: { code: 'INTERNAL_ERROR', message: 'The import could not complete.' },
              }),
      );
      service = registerLegacyOrderImports(app, fixture.config, fixture.db, {
        adapter,
        approvals: {
          async request(input) {
            financialImportScopeSchema.parse(input.scope);
            expect(input.planHash).toBe(
              expectedFinancialPlanHash(runtimeImportSecret, input.scope, input.plan),
            );
            const prior = approvalReceipts.get(input.commandId);
            if (prior) return prior;
            const view = financialImportApprovalSchema.parse({
              id: randomUUID(),
              ...input.scope,
              planHash: input.planHash,
              businessDate: input.plan.createdAt.slice(0, 10),
              approverId: input.approverId,
              reason: input.reason,
              issuedAt: Date.now(),
              expiresAt: Date.now() + 3600000,
              close: null,
              status: 'approved',
            });
            approvalReceipts.set(input.commandId, view);
            return view;
          },
          async read(scope, planHash, commandId) {
            financialImportScopeSchema.parse(scope);
            const view = commandId
              ? approvalReceipts.get(commandId)
              : [...approvalReceipts.values()].at(-1);
            return view?.operationId === scope.operationId && view.planHash === planHash
              ? view
              : null;
          },
        },
        runtime: readLegacyOrderImportOptions({
          LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
          LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: runtimeImportSecret,
          LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
          LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE: '1',
        }),
      });
      await app.ready();
    });
    beforeEach(async () => {
      await fixture.reset();
      sessionMode = 'valid';
      validationCalls = 0;
      starts = 0;
      reads = 0;
      dropStart = false;
      outcomes.clear();
      approvalReceipts.clear();
    });
    afterAll(async () => {
      await app?.close();
      await fixture?.close();
    });
    const base = '/api/v1/admin/order-imports';
    it('validates exact values and exposes only non-customer preview fields with trace metadata', async () => {
      const input = runtimeImportInput(),
        preview = await app.inject({ method: 'POST', url: base + '/previews', payload: input });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toEqual({
        id: input.id,
        kind: 'offline',
        totalOrders: 1,
        totalUnits: 2,
        lineValue: '50.98',
        scopes: input.counters,
        earliestBusinessDate: '2026-06-15',
        latestBusinessDate: '2026-06-15',
      });
      expect(preview.body).not.toMatch(/private-import|Private fixture|9007199254740993/);
      expect(
        (await app.inject({ method: 'GET', url: base + '/capabilities' })).json(),
      ).toMatchObject({ ready: true, canPreview: true });
      const routes = resourceRoutes(app);
      expect(routes).toHaveLength(12);
      expect(
        routes.every(
          (route) =>
            route.module === 'administration' &&
            route.resource === 'historical-order-import' &&
            route.authentication === 'session',
        ),
      ).toBe(true);
      expect(starts).toBe(0);
    });
    it('requires the current native role/type/store/counter and refuses stale principals before staging', async () => {
      await fixture.db.get('writer').update(PosUser).set({ role: 4 }).where(eq(PosUser.id, 1n));
      expect(
        (await app.inject({ method: 'POST', url: base, payload: runtimeImportInput() })).statusCode,
      ).toBe(403);
      await fixture.db
        .get('writer')
        .update(PosUser)
        .set({ role: 1, user_type: 2 })
        .where(eq(PosUser.id, 1n));
      expect((await app.inject({ method: 'GET', url: base + '/capabilities' })).statusCode).toBe(
        403,
      );
      await fixture.db
        .get('writer')
        .update(PosUser)
        .set({ user_type: 1 })
        .where(eq(PosUser.id, 1n));
      await fixture.db
        .get('writer')
        .update(StoreCounter)
        .set({ store: 9n })
        .where(eq(StoreCounter.id, 2n));
      expect(
        (await app.inject({ method: 'POST', url: base, payload: runtimeImportInput() })).statusCode,
      ).toBe(409);
      expect(await fixture.db.get('writer').select().from(legacyOrderImports)).toHaveLength(0);
    });
    it('requires an actual current store assignment for an internal non-supervisor role', async () => {
      await fixture.db.get('writer').update(PosUser).set({ role: 2 }).where(eq(PosUser.id, 1n));
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base + '/previews',
            payload: runtimeImportInput(),
          })
        ).statusCode,
      ).toBe(403);
      await fixture.fixture.insert(getTableName(UserStore), {
        [UserStore.django_user_id.name]: '1',
        [UserStore.store_id.name]: '1',
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base + '/previews',
            payload: runtimeImportInput(),
          })
        ).statusCode,
      ).toBe(200);
      await fixture.db.get('writer').delete(UserStore);
      expect(
        (await app.inject({ method: 'POST', url: base, payload: runtimeImportInput() })).statusCode,
      ).toBe(403);
      expect(await fixture.db.get('writer').select().from(legacyOrderImports)).toHaveLength(0);
    });
    it('serializes repeated stage and worker requests and retains only encrypted private input', async () => {
      const input = runtimeImportInput(),
        replies = await Promise.all(
          Array.from({ length: 20 }, () =>
            app.inject({ method: 'POST', url: base, payload: input }),
          ),
        );
      expect(replies.every((reply) => reply.statusCode === 202)).toBe(true);
      expect(await fixture.db.get('writer').select().from(legacyOrderImports)).toHaveLength(1);
      const staged = await fixture.db.get('writer').select().from(legacyOrderImportRows);
      expect(staged).toHaveLength(1);
      expect(JSON.stringify(staged)).not.toMatch(/private-import|Private fixture/);
      const events: OrderImportWorkerEvent[] = [],
        worker = legacyOrderImportWorker(service, (_level, event) => events.push(event));
      await Promise.all(Array.from({ length: 20 }, () => worker.runOnce()));
      await worker.stop();
      expect(starts).toBe(1);
      expect(reads).toBe(0);
      const detail = await app.inject({ method: 'GET', url: base + '/' + input.id });
      expect(detail.json()).toMatchObject({
        state: 'COMPLETED',
        importedOrders: 1,
        totalOrders: 1,
      });
      expect(detail.headers['cache-control']).toBe('private, no-store');
      const rows = await app.inject({ method: 'GET', url: base + '/' + input.id + '/results' });
      expect(rows.json()).toMatchObject({
        data: [{ orderId: '9007199254740993', state: 'IMPORTED', businessDate: '2026-06-15' }],
        nextAfter: null,
      });
      expect(rows.body).not.toMatch(/private-import|Private fixture/);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        module: 'administration',
        resource: 'historical-order-import',
        eventId: 'administration.historical-order-import.imported',
        userId: '1',
        jobId: input.id,
      });
      expect(JSON.stringify(events)).not.toMatch(/private-import|Private fixture|payload|csv/);
    });
    it('withholds a committed stage reply after session revocation without erasing its original job', async () => {
      const input = runtimeImportInput();
      sessionMode = 'revoke';
      expect((await app.inject({ method: 'POST', url: base, payload: input })).statusCode).toBe(
        401,
      );
      expect(await fixture.db.get('writer').select().from(legacyOrderImports)).toHaveLength(1);
      sessionMode = 'valid';
      expect(
        (await app.inject({ method: 'GET', url: base + '/' + input.id })).json(),
      ).toMatchObject({ id: input.id, state: 'QUEUED' });
      expect(starts).toBe(0);
    });
    it('uses only the original financial read after an unknown start and preserves safe worker logs', async () => {
      const input = runtimeImportInput();
      dropStart = true;
      await app.inject({ method: 'POST', url: base, payload: input });
      const events: OrderImportWorkerEvent[] = [],
        worker = legacyOrderImportWorker(service, (_level, event) => events.push(event));
      await worker.runOnce();
      expect(starts).toBe(1);
      expect(reads).toBe(0);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: base + '/' + input.id + '/cancellations',
            payload: {},
          })
        ).statusCode,
      ).toBe(409);
      await fixture.db
        .get('writer')
        .update(legacyOrderImports)
        .set({ leaseUntil: sql`UTC_TIMESTAMP(3)-INTERVAL 1 DAY` })
        .where(eq(legacyOrderImports.id, input.id));
      await worker.runOnce();
      await worker.stop();
      expect(starts).toBe(1);
      expect(reads).toBe(1);
      expect(
        (await app.inject({ method: 'GET', url: base + '/' + input.id })).json(),
      ).toMatchObject({ importedOrders: 1, state: 'COMPLETED' });
      expect(JSON.stringify(events)).not.toMatch(/Private provider|private-import|Private fixture/);
    });
    it('requires a real session validator, strict input and ownership for every public result', async () => {
      const input = runtimeImportInput();
      sessionMode = 'missing';
      expect((await app.inject({ method: 'POST', url: base, payload: input })).statusCode).toBe(
        401,
      );
      sessionMode = 'valid';
      expect(
        (await app.inject({ method: 'POST', url: base, payload: { ...input, priceOverride: '1' } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: base + '/' + randomUUID(),
            headers: { 'x-anonymous': 'true' },
          })
        ).statusCode,
      ).toBe(401);
      expect((await app.inject({ method: 'GET', url: base + '/' + randomUUID() })).statusCode).toBe(
        404,
      );
      expect(await fixture.db.get('writer').select().from(legacyOrderImports)).toHaveLength(0);
    });
    it('guards resume inputs and recovers its committed receipt after post-commit session revocation', async () => {
      const input = runtimeImportInput(),
        operationId = randomUUID();
      await app.inject({ method: 'POST', url: base, payload: input });
      await fixture.db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: false })
        .where(eq(StoreCounter.id, 2n));
      await service.runOne();
      await fixture.db
        .get('writer')
        .update(StoreCounter)
        .set({ is_active: true })
        .where(eq(StoreCounter.id, 2n));
      const url = base + '/' + input.id + '/resumptions';
      expect(
        (await app.inject({ method: 'POST', url, payload: { operationId, actorId: '2' } }))
          .statusCode,
      ).toBe(400);
      sessionMode = 'missing';
      expect((await app.inject({ method: 'POST', url, payload: { operationId } })).statusCode).toBe(
        401,
      );
      sessionMode = 'revoke';
      validationCalls = 0;
      expect((await app.inject({ method: 'POST', url, payload: { operationId } })).statusCode).toBe(
        401,
      );
      sessionMode = 'valid';
      const recovered = await app.inject({ method: 'GET', url: url + '/' + operationId });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.headers['cache-control']).toBe('private, no-store');
      expect(recovered.json()).toMatchObject({ operationId, jobId: input.id });
      expect(recovered.body).not.toMatch(/private-import|Private fixture|requestHash|claimToken/);
      expect(
        (await app.inject({ method: 'GET', url: base + '/' + input.id })).json(),
      ).toMatchObject({ state: 'QUEUED' });
      expect(starts).toBe(0);
    });
    it('derives approval scope and plan privately and recovers the exact command after a lost session response', async () => {
      const input = runtimeImportInput(),
        commandId = randomUUID();
      await app.inject({ method: 'POST', url: base, payload: input });
      const [row] = await fixture.db.get('writer').select().from(legacyOrderImportRows),
        url = base + '/' + input.id + '/orders/' + row!.operationId + '/approvals';
      const body = { commandId, reason: 'historical-correction' };
      expect(
        (await app.inject({ method: 'POST', url, payload: { ...body, actorId: '2' } })).statusCode,
      ).toBe(400);
      sessionMode = 'revoke';
      validationCalls = 0;
      expect((await app.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401);
      sessionMode = 'valid';
      expect(approvalReceipts.size).toBe(1);
      const response = await app.inject({ method: 'GET', url: url + '/' + commandId });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toMatchObject({
        commandId,
        review: {
          operationId: row!.operationId,
          kind: 'offline',
          storeId: '1',
          counterId: '2',
          businessDate: '2026-06-15',
          currency: 'INR',
          lineValue: '50.98',
          lines: [{ productId: '9007199254740993', quantity: 2, unitPrice: '25.49' }],
        },
        approval: {
          actorId: '1',
          approverId: '1',
          operationId: row!.operationId,
          reason: 'historical-correction',
        },
      });
      expect(response.body).not.toMatch(
        /private-import|Private fixture|message|payload|sourceRows/,
      );
      expect(
        (await app.inject({ method: 'GET', url: url + '/' + randomUUID() })).json(),
      ).toMatchObject({ approval: null });
      await fixture.db.get('writer').update(legacyOrderImportRows).set({ state: 'STARTING' });
      expect((await app.inject({ method: 'GET', url: url + '/' + commandId })).statusCode).toBe(
        200,
      );
      expect(
        (await app.inject({ method: 'POST', url, payload: { ...body, commandId: randomUUID() } }))
          .statusCode,
      ).toBe(409);
      expect(approvalReceipts.size).toBe(1);
      expect(starts).toBe(0);
    });
    it('waits for native approval before STARTING and keeps the original plan and nonce for first dispatch', async () => {
      const input = runtimeImportInput();
      let approved = false;
      const hashes: string[] = [],
        adapter: ImportFinancialAdapter = {
          async authorizeStart(_tx, value) {
            hashes.push(value.planHash);
            return approved
              ? { ready: true }
              : { ready: false, code: 'ORDER_IMPORT_APPROVAL_REQUIRED' };
          },
          async start(value) {
            starts++;
            expect(value.planHash).toBe(hashes.at(-1));
            return result(value);
          },
          async read() {
            reads++;
            return null;
          },
        },
        financialService = legacyOrderImportService(fixture.config, fixture.db, {
          runtime: service.runtime,
          adapter,
        }),
        worker = legacyOrderImportWorker(financialService, () => undefined);
      await app.inject({ method: 'POST', url: base, payload: input });
      await worker.runOnce();
      const [row] = await fixture.db.get('writer').select().from(legacyOrderImportRows);
      expect(row).toMatchObject({ state: 'PENDING', errorCode: 'ORDER_IMPORT_APPROVAL_REQUIRED' });
      expect(starts).toBe(0);
      expect(reads).toBe(0);
      const context = await legacyOrderImportRepository(fixture.db, {
        secret: runtimeImportSecret,
      }).financialContext('1', input.id, row!.operationId);
      expect(context).toMatchObject({
        actorId: '1',
        operationId: row!.operationId,
        storeId: '1',
        counterId: '2',
        planHash: hashes[0],
        plan: { createdAt: '2026-06-15 12:00:00', originalTenderAmount: '50.98' },
      });
      approved = true;
      await fixture.db
        .get('writer')
        .update(legacyOrderImports)
        .set({ leaseUntil: sql`UTC_TIMESTAMP(3)-INTERVAL 1 DAY` })
        .where(eq(legacyOrderImports.id, input.id));
      await worker.runOnce();
      await worker.stop();
      expect(starts).toBe(1);
      expect(reads).toBe(0);
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).toBe(hashes[1]);
      expect(
        (await app.inject({ method: 'GET', url: base + '/' + input.id })).json(),
      ).toMatchObject({ state: 'COMPLETED', importedOrders: 1 });
    });
  },
);
