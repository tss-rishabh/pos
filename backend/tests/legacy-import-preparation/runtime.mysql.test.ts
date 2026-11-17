import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { splitMigration } from '../../src/db/migrations.js';
import { AppError } from '../../src/domain/errors.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { checkoutRepository } from '../../src/modules/checkout/repository.js';
import { readSourceOrderReceipt } from '../../src/modules/legacy-order-imports/financial-adapter-proof.js';
import { configuredLegacyOrderImports } from '../../src/modules/legacy-order-imports/runtime.js';
import { registerLegacyOrderImports } from '../../src/modules/legacy-order-imports/index.js';
import { legacyOrderImportWorker } from '../../src/modules/legacy-order-imports/worker.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import {
  financialImportPreparations,
  financialImportProofs,
} from '../../src/modules/legacy-order-imports/financial-adapter-schema.js';
import { sourceOrderPreparationContract } from '../../src/modules/legacy-order-imports/source-order-preparation-contracts.js';
import { financialImportScopeSchema } from '../../src/modules/legacy-order-imports/financial-adapter-contracts.js';
import {
  importFinancialFixture,
  financialClock,
  sourceKey,
} from '../legacy-import-financial/fixture.js';
import {
  runtimeImportInput,
  runtimeImportSecret,
} from '../legacy-order-imports/runtime-fixture.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
const authKey = 'isolated-preparation-runtime-auth-key-'.repeat(2);
describe.skipIf(!template)(
  'installed preparation through actual runtime, job API and worker',
  () => {
    let f: Awaited<ReturnType<typeof importFinancialFixture>>;
    beforeAll(async () => {
      f = await importFinancialFixture(template!);
      for (const path of [
        'preparation-migration.sql',
        'correction-migration.sql',
        'correction-command-migration.sql',
      ])
        for (const statement of splitMigration(
          readFileSync('src/modules/legacy-order-imports/' + path, 'utf8'),
        ))
          await f.connection.query(statement);
    }, 15000);
    afterAll(async () => {
      await f?.close();
    });
    beforeEach(async () => {
      await f.db.get('writer').delete(financialImportPreparations);
      await f.reset();
    });
    function environment(): NodeJS.ProcessEnv {
      return {
        LEGACY_ORDER_IMPORT_CONTRACT: 'pos-legacy-order-import-v1',
        LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1: runtimeImportSecret,
        LEGACY_ORDER_IMPORT_WORKER_ENABLED: 'true',
        LEGACY_ORDER_IMPORT_WORKER_BATCH_SIZE: '1',
        UPSTREAM_POS_LEGACY_IMPORT_FINANCIAL_CONTRACT: 'pos-legacy-order-import-financial-v1',
        UPSTREAM_POS_LEGACY_IMPORT_SOURCE_CONTRACT: 'pos-legacy-order-import-source-v1',
        UPSTREAM_POS_LEGACY_IMPORT_PUBLICATION_CONTRACT: 'pos-legacy-order-import-publication-v1',
        UPSTREAM_POS_LEGACY_IMPORT_CONFIRMATION_CONTRACT: 'pos-legacy-order-import-confirmation-v1',
        UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: sourceOrderPreparationContract,
        TSS_POS_LEGACY_IMPORT_URL: 'https://source.example.test/internal/pos/legacy-order-imports',
        TSS_POS_LEGACY_IMPORT_KEY: authKey,
        TSS_POS_LEGACY_IMPORT_PROOF_KEY: sourceKey,
        POS_STOCK_PROJECTION_CONTRACT: 'pos-stock-projection-70b801-v1',
        OFFLINE_CASH_ORDER_SCHEMA_CONTRACT: 'pos-offline-cash-order-schema-v1',
        TSS_PAYMENT_ORDER_URL: 'https://payments.example.test/order',
        TSS_JWT_HS256_KEY: 'isolated-runtime-customer-hs256-'.repeat(2),
        TSS_JWT_HS512_KEY: 'isolated-runtime-customer-hs512-'.repeat(2),
        UPSTREAM_POS_CHECKOUT_PROJECTION_CONTRACT: 'pos-checkout-projection-v1',
        TSS_POS_CHECKOUT_PROJECTION_KEY: 'isolated-runtime-checkout-projection-'.repeat(2),
        UPSTREAM_POS_REFUND_ALLOCATION_CONTRACT: 'pos-refund-per-hp-v1',
        UPSTREAM_POS_REFUND_ALLOCATION_PATCH_HASH:
          'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
      };
    }
    function fixtureTransport(failPreview = false) {
      const calls: string[] = [],
        native = f.transport(),
        journal = legacyImportFinancialJournal(f.config, f.db, f.options),
        history = vi.fn(async () => {
          throw new Error('Unused history must not be queried.');
        });
      const fetcher: typeof fetch = vi.fn(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/preparation')) {
          calls.push('preparation');
          if (failPreview) return Response.json({}, { status: 503 });
          const c = z
            .object({
              capability: z.object({
                operationId: z.uuid(),
                attemptId: z.uuid(),
                requestHash: z.string(),
                planHash: z.string(),
                scope: financialImportScopeSchema,
                authorityHash: z.string(),
                planDigest: z.string(),
                issuedAt: z.number(),
                expiresAt: z.number(),
                attemptExpiresAt: z.number(),
              }),
            })
            .parse(JSON.parse(String(options?.body)) as unknown).capability;
          const [attempt] = await f.db
            .get('writer')
            .select()
            .from(financialImportPreparations)
            .where(eq(financialImportPreparations.id, c.attemptId));
          expect(attempt?.data.phase).toBe('RUNNING');
          const value = {
            contract: sourceOrderPreparationContract,
            purpose: 'source-cart-preview-result' as const,
            operationId: c.operationId,
            attemptId: c.attemptId,
            requestHash: c.requestHash,
            planHash: c.planHash,
            scope: c.scope,
            authorityHash: c.authorityHash,
            planDigest: c.planDigest,
            issuedAt: financialClock,
            expiresAt: c.expiresAt,
            attemptExpiresAt: c.attemptExpiresAt,
            sourceTimeZone: 'Asia/Kolkata',
            outcome: 'ready' as const,
            historyScope: null,
            membershipHistoryHash: null,
          };
          return Response.json({
            ...value,
            signature: operationHash(
              'legacy-order-imports.source.preparation-result.v1',
              value,
              sourceKey,
            ),
          });
        }
        const confirmation = path === '/order',
          body: unknown = confirmation
            ? JSON.parse(
                Buffer.from(
                  new Headers(options?.headers).get('X-POS-Legacy-Import-Capability') ?? '',
                  'base64url',
                ).toString('utf8'),
              )
            : z
                .object({ capability: z.unknown() })
                .parse(JSON.parse(String(options?.body)) as unknown).capability,
          c = z
            .object({
              scope: financialImportScopeSchema,
              nonce: z.uuid(),
              issuedAt: z.number(),
              expiresAt: z.number(),
            })
            .parse(body),
          context = await journal.transaction((tx) => journal.load(tx, c.scope));
        if (!context) throw new Error('Native fixture command missing.');
        const command = {
          ...context,
          nonce: c.nonce,
          issuedAt: c.issuedAt,
          expiresAt: c.expiresAt,
        };
        if (confirmation) {
          calls.push('confirmation');
          const order = await f.db
              .get('writer')
              .transaction((tx) => readSourceOrderReceipt(tx, c.scope.operationId, sourceKey)),
            customer = await checkoutRepository(f.db).customer('77', 'writer');
          if (!order) throw new Error('Native source receipt missing.');
          if (!customer) throw new Error('Native fixture customer missing.');
          await native.confirm(command, order, customer);
        } else if (path.endsWith('/publication')) {
          calls.push('publication');
          const order = await f.db
            .get('writer')
            .transaction((tx) => readSourceOrderReceipt(tx, c.scope.operationId, sourceKey));
          if (!order) throw new Error('Native source receipt missing.');
          await native.publication(command, order);
        } else {
          calls.push('order');
          await native.order(command);
        }
        return Response.json({ status: true });
      });
      return { fetcher, calls, history };
    }
    function appFor(transport: ReturnType<typeof fixtureTransport>, env = environment()) {
      const registration = configuredLegacyOrderImports(f.config, f.db, {
          environment: env,
          clock: () => financialClock,
          fetcher: transport.fetcher,
          stockProcedure: f.options.stockProcedure,
          preparation: { historyReader: { read: transport.history } },
        }),
        app = Fastify({ logger: false });
      app.decorateRequest('principal', null);
      app.decorateRequest('authSessionValid', null);
      app.addHook('preHandler', async (request) => {
        request.principal = {
          id: '1',
          role: 1,
          userType: 1,
          storeIds: [],
          name: 'Fixture',
          email: 'fixture@example.test',
        };
        request.authSessionValid = async () => true;
      });
      app.setErrorHandler((error, _request, reply) =>
        error instanceof AppError
          ? reply.code(error.status).send({ error: { code: error.code } })
          : reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } }),
      );
      const service = registerLegacyOrderImports(app, f.config, f.db, registration),
        worker = legacyOrderImportWorker(service, () => undefined);
      return { app, service, worker, registration };
    }
    it('installs the actual producer before worker dispatch without unused history and records one native order/payment', async () => {
      const transport = fixtureTransport(),
        { app, service, worker, registration } = appFor(transport),
        csv = runtimeImportInput();
      csv.csv = csv.csv.replace('25.49', '25.00');
      try {
        expect(registration.canStart).toBe(true);
        expect(registration.adapter?.preparation).toBeDefined();
        expect(transport.calls).toEqual([]);
        expect(
          (await app.inject({ method: 'POST', url: '/api/v1/admin/order-imports', payload: csv }))
            .statusCode,
        ).toBe(202);
        await worker.runOnce();
        expect(
          await service.detail(
            {
              id: '1',
              role: 1,
              userType: 1,
              storeIds: [],
              name: 'Fixture',
              email: 'fixture@example.test',
            },
            csv.id,
          ),
        ).toMatchObject({ state: 'COMPLETED', importedOrders: 1 });
        expect(transport.calls).toEqual(['preparation', 'order', 'confirmation', 'publication']);
        expect(transport.history).not.toHaveBeenCalled();
        expect(await f.db.get('writer').select().from(financialImportProofs)).toHaveLength(1);
      } finally {
        await worker.stop();
        await app.close();
      }
    });
    it('pauses a failed installed preview as native no-dispatch and never calls an order endpoint', async () => {
      const transport = fixtureTransport(true),
        { app, worker } = appFor(transport),
        csv = runtimeImportInput();
      csv.csv = csv.csv.replace('25.49', '25.00');
      try {
        await app.inject({ method: 'POST', url: '/api/v1/admin/order-imports', payload: csv });
        await worker.runOnce();
        const result = await app.inject({
          method: 'GET',
          url: '/api/v1/admin/order-imports/' + csv.id,
        });
        expect(result.json<unknown>()).toMatchObject({
          state: 'BLOCKED',
          errorCode: 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED',
        });
        expect(transport.calls).toEqual(['preparation']);
        expect(await f.db.get('writer').select().from(financialImportProofs)).toEqual([]);
      } finally {
        await worker.stop();
        await app.close();
      }
    });
    it('completed job API and recovery worker survive bad selected producer configuration without new dispatch', async () => {
      const transport = fixtureTransport(),
        first = appFor(transport),
        csv = runtimeImportInput();
      csv.csv = csv.csv.replace('25.49', '25.00');
      try {
        await first.app.inject({
          method: 'POST',
          url: '/api/v1/admin/order-imports',
          payload: csv,
        });
        await first.worker.runOnce();
      } finally {
        await first.worker.stop();
        await first.app.close();
      }
      const calls = [...transport.calls],
        second = appFor(transport, {
          ...environment(),
          UPSTREAM_POS_LEGACY_IMPORT_PREPARATION_CONTRACT: 'invalid',
        });
      try {
        expect(second.registration.canStart).toBe(false);
        expect(second.service.recoveryReady).toBe(true);
        expect(
          (
            await second.app.inject({ method: 'GET', url: '/api/v1/admin/order-imports/' + csv.id })
          ).json<unknown>(),
        ).toMatchObject({ state: 'COMPLETED' });
        const [row] = await legacyOrderImportRepository(f.db, {
          secret: runtimeImportSecret,
        }).results('1', csv.id);
        expect(
          await second.registration.adapter!.read({
            actorId: '1',
            operationId: row!.operationId,
            storeId: '1',
            counterId: '2',
          }),
        ).toMatchObject({ status: 'completed' });
        await second.worker.runOnce();
        expect(transport.calls).toEqual(calls);
      } finally {
        await second.worker.stop();
        await second.app.close();
      }
    });
  },
);
