import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { legacyImportFinancialJournal } from '../../src/modules/legacy-order-imports/financial-adapter-journal.js';
import { legacyImportPreparationTransport } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { financialImportHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import {
  sourceOrderPreparationContract,
  type SourceOrderPreparationInput,
} from '../../src/modules/legacy-order-imports/source-order-preparation-contracts.js';
import {
  importFinancialFixture,
  financialPlan,
  financialClock,
} from '../legacy-import-financial/fixture.js';
import { preparationKeys } from './fixtures.js';
import { preparationOptions } from './fixtures.js';
import { sourceOrderPreparation } from '../../src/modules/legacy-order-imports/source-order-preparation.js';
import {
  csvMembershipBigQueryHistory,
  csvMembershipPublicationHash,
} from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import { csvMembershipHistoryRequestSchema } from '../../src/modules/legacy-order-imports/membership-profile/history.js';
import {
  membershipBigQueryFixture,
  membershipHistoryOptions,
} from '../legacy-order-imports/membership-bigquery-fixtures.js';

const fixtureResult = z.object({
  status: z.string(),
  response: z.record(z.string(), z.unknown()),
  trace: z.array(z.string()),
  commits: z.number(),
  rollbacks: z.number(),
  scopeRestored: z.boolean(),
  loggedFields: z.array(z.string()),
});
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'native source preparation current attempt and rollback-only authority',
  () => {
    let f: Awaited<ReturnType<typeof importFinancialFixture>>;
    beforeAll(async () => {
      f = await importFinancialFixture(template!);
      await f.fixture.create(['products_gs1']);
      await f.connection.query(
        'CREATE TABLE pos_rewrite_import_financial_preparations(id VARCHAR(36) PRIMARY KEY,operation_id VARCHAR(36) NOT NULL,sequence_no INT NOT NULL,data JSON NOT NULL,proof_hash VARCHAR(64) NOT NULL,artifact MEDIUMTEXT NULL,UNIQUE(operation_id,sequence_no))',
      );
    });
    afterAll(async () => {
      await f?.close();
    });
    beforeEach(async () => {
      await f.connection.query('DELETE FROM pos_rewrite_import_financial_preparations');
      await f.connection.query('DELETE FROM products_gs1');
      await f.reset();
      await f.fixture.insert('products_gs1', {
        id: 1,
        product_id: '9007199254740993',
        gtin: '9007199254740993',
      });
      await f.fixture.insert('products', { id: 12, prod_type: 1, parent_prod_id: 0 });
    });
    async function command(high = true) {
      const plan = financialPlan();
      if (high) {
        plan.lines[0]!.unitPrice = '2300.00';
        plan.originalTenderAmount = '4600.00';
      }
      const original = await legacyImportFinancialJournal(f.config, f.db, f.options).reserve(
        f.input(plan),
      );
      const state = { ...original.state, preparationContract: sourceOrderPreparationContract },
        input: SourceOrderPreparationInput = {
          state,
          plan,
          attemptId: randomUUID(),
          expiresAt: financialClock + 60000,
        };
      await f.connection.query(
        'UPDATE pos_rewrite_import_financial_operations SET state=? WHERE id=?',
        [JSON.stringify(state), state.scope.operationId],
      );
      const data = {
        contract: sourceOrderPreparationContract,
        id: input.attemptId,
        scope: state.scope,
        planHash: state.planHash,
        requestHash: state.requestHash,
        authorityHash: financialImportHash(
          f.options.secret,
          'preparation-authority',
          state.authority,
        ),
        sequence: 1,
        ownerHash: 'b'.repeat(64),
        phase: 'RUNNING',
        expiresAt: input.expiresAt,
        queue: null,
      };
      await f.connection.query(
        'INSERT INTO pos_rewrite_import_financial_preparations(id,operation_id,sequence_no,data,proof_hash) VALUES(?,?,1,?,?)',
        [input.attemptId, state.scope.operationId, JSON.stringify(data), 'f'.repeat(64)],
      );
      return { input, data };
    }
    async function body(input: SourceOrderPreparationInput) {
      let value: unknown;
      const fetcher: typeof fetch = async (_url, options) => {
        value = JSON.parse(String(options?.body)) as unknown;
        return new Response(null, { status: 503 });
      };
      await legacyImportPreparationTransport(f.config, {
        ...f.options,
        ...preparationKeys,
        secret: f.options.secret,
        sourceUrl: 'https://private.example.test/internal/pos/legacy-order-imports',
        fetcher,
      })
        .preview(input, { signal: new AbortController().signal })
        .catch(() => undefined);
      return z.record(z.string(), z.unknown()).parse(value);
    }
    function run(
      value: unknown,
      options: { mode?: string; contract?: string; headerKey?: string } = {},
    ) {
      const output = execFileSync(
        resolve('compatibility/upstream/offline-cash-pricing/.venv/bin/python'),
        ['-B', resolve('tools/legacy-import-preparation/native_driver.py')],
        {
          encoding: 'utf8',
          maxBuffer: 16000,
          input: JSON.stringify({
            url: f.config.MYSQL_WRITER_URL,
            sourceRoot:
              process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ?? resolve('../../backend-tss-api_v2'),
            authKey: preparationKeys.sourceAuthKey,
            proofKey: preparationKeys.sourceProofKey,
            historyKey: preparationKeys.historyKey,
            now: financialClock,
            body: value,
            ...options,
          }),
        },
      );
      return fixtureResult.parse(JSON.parse(output) as unknown);
    }
    async function untouched() {
      for (const name of [
        'orders',
        'has_products',
        'pos_rewrite_import_financial_source_receipts',
        'pos_rewrite_import_financial_stages',
        'pos_rewrite_import_financial_source_effects',
      ]) {
        const [rows] = await f.connection.query('SELECT COUNT(*) AS n FROM ' + name);
        expect(z.array(z.object({ n: z.string().regex(/^\d+$/) })).parse(rows)[0]!.n).toBe('0');
      }
      const [rows] = await f.connection.query('SELECT tss_money FROM users WHERE id=77');
      expect(
        z.array(z.object({ tss_money: z.number().nullable() })).parse(rows)[0]!.tss_money ?? 0,
      ).toBe(0);
    }
    it('runs actual pinned Cart/ValidateCheckout/ProcessingOrder and nested source flushes, always rolls back and signs only a preview', async () => {
      const { input } = await command(),
        result = run(await body(input));
      expect(result.status).toBe('200 OK');
      expect(result.response.outcome).toBe('ready');
      expect(result.trace).toEqual([
        'catalog',
        'cart',
        'catalog',
        'cart',
        'cart',
        'validate',
        'calculator',
      ]);
      expect(result.commits).toBe(0);
      expect(result.rollbacks).toBeGreaterThan(0);
      expect(result.scopeRestored).toBe(true);
      const { signature, ...proof } = result.response;
      expect(signature).toBe(
        operationHash(
          'legacy-order-imports.source.preparation-result.v1',
          proof,
          preparationKeys.sourceProofKey,
        ),
      );
      expect(result.response).not.toHaveProperty('noFinancialEffects');
      expect(result.response).not.toHaveProperty('orderId');
      await untouched();
    });
    it('returns trusted current execution window only at the actual <=2000 history branch, without historical native SELECT', async () => {
      const { input } = await command(false),
        result = run(await body(input));
      expect(result.status).toBe('200 OK');
      expect(result.response.outcome).toBe('need-history');
      expect(result.response.historyScope).toMatchObject({
        asOf: '2026-06-15 12:00:00',
        cutoff: '2026-05-01 12:00:00',
        customerId: '77',
      });
      expect(result.trace).toEqual(['catalog', 'cart', 'catalog', 'cart', 'cart']);
      expect(result.commits).toBe(0);
      await untouched();
    });
    it.each([
      'phase',
      'authority',
      'latest',
      'expired',
      'stage',
      'queue',
      'actor',
      'contact',
    ] as const)('rejects stale native %s before any catalog/cart execution', async (scenario) => {
      const { input, data } = await command(),
        supplied = await body(input);
      if (scenario === 'phase') data.phase = 'CLOSED';
      if (scenario === 'authority') data.authorityHash = 'a'.repeat(64);
      if (scenario === 'expired') data.expiresAt = financialClock;
      if (scenario === 'queue')
        Object.assign(data, { queue: { jobId: randomUUID(), claimToken: randomUUID() } });
      await f.connection.query(
        'UPDATE pos_rewrite_import_financial_preparations SET data=? WHERE id=?',
        [JSON.stringify(data), input.attemptId],
      );
      if (scenario === 'latest')
        await f.connection.query(
          'INSERT INTO pos_rewrite_import_financial_preparations(id,operation_id,sequence_no,data,proof_hash) VALUES(?,?,2,?,?)',
          [
            randomUUID(),
            input.state.scope.operationId,
            JSON.stringify({ ...data, phase: 'AUTHORIZED' }),
            'f'.repeat(64),
          ],
        );
      if (scenario === 'stage')
        await f.connection.query(
          "INSERT INTO pos_rewrite_import_financial_stages(id,operation_id,kind,nonce,status,request_hash,created_at_ms,updated_at_ms) VALUES(?,?,'order',?,'dispatched',?,?,?)",
          [
            input.state.scope.operationId + ':order',
            input.state.scope.operationId,
            randomUUID(),
            input.state.requestHash,
            financialClock,
            financialClock,
          ],
        );
      if (scenario === 'actor')
        await f.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      if (scenario === 'contact')
        await f.connection.query("UPDATE users SET telephone='9000000001' WHERE id=77");
      const result = run(supplied);
      expect(result.status).toBe('409 Conflict');
      expect(result.trace).toEqual([]);
      expect(result.commits).toBe(0);
      expect(result.scopeRestored).toBe(true);
      if (scenario !== 'stage') await untouched();
    });
    it.each(['write', 'commit', 'http', 'history'] as const)(
      'blocks a source %s attempt and stores no financial/effect proof',
      async (mode) => {
        const { input } = await command(),
          result = run(await body(input), { mode });
        expect(result.status).toBe('409 Conflict');
        expect(result.commits).toBe(0);
        expect(result.scopeRestored).toBe(true);
        expect(result.response.code).toBe(
          mode === 'http'
            ? 'ORDER_IMPORT_HTTP_EFFECT_UNQUALIFIED'
            : mode === 'history'
              ? 'ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED'
              : 'ORDER_IMPORT_PREPARATION_WRITE_BLOCKED',
        );
        await untouched();
      },
    );
    it('is disabled by default and refuses an invalid shared header before any SQL or source execution', async () => {
      const { input } = await command(),
        supplied = await body(input);
      for (const options of [{ contract: '' }, { headerKey: 'untrusted' }]) {
        const result = run(supplied, options);
        expect(result.status).toBe('409 Conflict');
        expect(result.trace).toEqual([]);
        expect(result.commits).toBe(0);
        expect(result.loggedFields).toEqual([
          'eventId',
          'module',
          'requestId',
          'resource',
          'userId',
        ]);
      }
      await untouched();
    });
    it('requires the exact active queue claim and STARTING row, and rejects later lease/token changes', async () => {
      const { input, data } = await command(),
        jobId = randomUUID(),
        claimToken = randomUUID();
      await f.connection.query(
        "INSERT INTO pos_rewrite_legacy_order_imports(id,actor_id,request_hash,kind,state,total_orders,imported_orders,failed_orders,cancelled_orders,claim_token,lease_until,created_at,updated_at) VALUES(?,'1',?,'offline','RUNNING',1,0,0,0,?,'2026-06-15 06:31:00.000','2026-06-15 06:30:00.000','2026-06-15 06:30:00.000')",
        [jobId, 'a'.repeat(64), claimToken],
      );
      await f.connection.query(
        "INSERT INTO pos_rewrite_legacy_order_import_rows(job_id,sequence,first_row,operation_id,store_id,counter_id,state,payload,updated_at) VALUES(?,1,2,?,'1','2','STARTING','fixture-only','2026-06-15 06:30:00.000')",
        [jobId, input.state.scope.operationId],
      );
      Object.assign(data, { queue: { jobId, claimToken } });
      await f.connection.query(
        'UPDATE pos_rewrite_import_financial_preparations SET data=? WHERE id=?',
        [JSON.stringify(data), input.attemptId],
      );
      const supplied = await body(input);
      expect(run(supplied).status).toBe('200 OK');
      for (const query of [
        [
          'UPDATE pos_rewrite_legacy_order_imports SET claim_token=? WHERE id=?',
          [randomUUID(), jobId],
        ],
        [
          "UPDATE pos_rewrite_legacy_order_imports SET claim_token=?,lease_until='2026-06-15 06:29:59.999' WHERE id=?",
          [claimToken, jobId],
        ],
        [
          "UPDATE pos_rewrite_legacy_order_imports SET lease_until='2026-06-15 06:31:00.000' WHERE id=?",
          [jobId],
        ],
      ] as const) {
        await f.connection.query(query[0], [...query[1]]);
        if (query[0].includes('06:31:00.000'))
          await f.connection.query(
            "UPDATE pos_rewrite_legacy_order_import_rows SET state='PENDING' WHERE operation_id=?",
            [input.state.scope.operationId],
          );
        const result = run(supplied);
        expect(result.status).toBe('409 Conflict');
        expect(result.trace).toEqual([]);
      }
      await untouched();
    });
    it('roundtrips source NeedHistory→bounded qualified BQ adapter→same-source memory replay entirely before an order stage exists', async () => {
      const { input } = await command(false),
        previews: ReturnType<typeof run>[] = [];
      let historyScope: ReturnType<typeof csvMembershipHistoryRequestSchema.parse> | undefined;
      const execute = vi.fn(async () => {
        expect(previews).toHaveLength(1);
        expect(historyScope).toBeDefined();
        const document = membershipBigQueryFixture([], historyScope!).envelope;
        const publication = document.publications[0]!;
        publication.sourceSnapshotAt = '2026-06-15T06:30:00.000000Z';
        publication.sourceCdcThrough = publication.sourceSnapshotAt;
        publication.publishedAt = publication.sourceSnapshotAt;
        const { signature: _signature, ...unsigned } = publication;
        publication.signature = csvMembershipPublicationHash(
          unsigned,
          preparationKeys.publicationKey,
        );
        return [{ document: JSON.stringify(document) }];
      });
      const history = csvMembershipBigQueryHistory(
        membershipHistoryOptions,
        {
          historyKey: preparationKeys.historyKey,
          publicationKey: preparationKeys.publicationKey,
          memberProductIds: ['10', '12'],
        },
        { query: { estimate: async () => 1n, execute }, clock: () => financialClock },
      );
      const fetcher: typeof fetch = async (_url, options) => {
        const result = run(JSON.parse(String(options?.body)) as unknown);
        previews.push(result);
        if (result.response.historyScope)
          historyScope = csvMembershipHistoryRequestSchema.parse(result.response.historyScope);
        return Response.json(result.response, {
          status: result.status.startsWith('200') ? 200 : 409,
        });
      };
      const result = await sourceOrderPreparation(
        f.config,
        {
          ...f.options,
          ...preparationKeys,
          secret: f.options.secret,
          sourceUrl: 'https://private.example.test/internal/pos/legacy-order-imports',
        },
        preparationOptions(true),
        {
          fetcher,
          clock: () => financialClock,
          historyReader: history,
        },
      ).prepare(input, { signal: new AbortController().signal });
      expect(previews.map((row) => row.response.outcome)).toEqual(['need-history', 'ready']);
      expect(previews.every((row) => row.commits === 0 && row.scopeRestored)).toBe(true);
      expect(result.membershipHistory?.document.scope).toEqual(historyScope);
      expect(execute).toHaveBeenCalledOnce();
      await untouched();
    });
  },
);
