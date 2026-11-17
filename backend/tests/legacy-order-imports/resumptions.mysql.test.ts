import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StoreCounter } from '../../src/db/legacy-schema.js';
import { legacyOrderImportRepository } from '../../src/modules/legacy-order-imports/repository.js';
import {
  legacyOrderImportResumptions,
  legacyOrderImportRows,
  legacyOrderImports,
} from '../../src/modules/legacy-order-imports/schema.js';
import type { ImportFinancialAdapter } from '../../src/modules/legacy-order-imports/financial-contracts.js';
import {
  orderImportRuntimeFixture,
  runtimeImportInput,
  runtimeImportSecret,
} from './runtime-fixture.js';

const template = process.env.LEGACY_ORDER_IMPORT_MYSQL_TEST_URL;
describe.skipIf(!template)('native resumption of original unsent CSV operations', () => {
  let fixture: Awaited<ReturnType<typeof orderImportRuntimeFixture>>,
    repository: ReturnType<typeof legacyOrderImportRepository>,
    starts: string[];
  const adapter: ImportFinancialAdapter = {
    async start(scope) {
      starts.push(scope.operationId);
      return {
        status: 'completed',
        operationId: scope.operationId,
        orderId: String(9007199254740993n + BigInt(starts.length)),
        receiptId: randomUUID(),
        businessDate: '2026-06-15',
        projectionHash: 'b'.repeat(64),
      };
    },
    async read() {
      throw new Error('An unsent row must not enter financial receipt recovery.');
    },
  };
  beforeAll(async () => {
    fixture = await orderImportRuntimeFixture(template!);
    repository = legacyOrderImportRepository(fixture.db, { secret: runtimeImportSecret });
  });
  beforeEach(async () => {
    await fixture.reset();
    starts = [];
  });
  afterAll(async () => fixture?.close());
  async function blockNextUnsent(jobId: string) {
    await fixture.db
      .get('writer')
      .update(StoreCounter)
      .set({ is_active: false })
      .where(eq(StoreCounter.id, 2n));
    expect(await repository.runOne(adapter)).toBeNull();
    const [job] = await fixture.db
      .get('writer')
      .select()
      .from(legacyOrderImports)
      .where(eq(legacyOrderImports.id, jobId));
    expect(job).toMatchObject({ state: 'BLOCKED', errorCode: 'ORDER_IMPORT_ACCESS_CHANGED' });
  }
  const restore = () =>
    fixture.db
      .get('writer')
      .update(StoreCounter)
      .set({ is_active: true })
      .where(eq(StoreCounter.id, 2n));

  it('resumes a partial job concurrently without changing original IDs or replaying an imported order', async () => {
    const input = runtimeImportInput();
    input.csv += '\n' + input.csv.split('\n')[1]!.replace('fixture-reference', 'second-reference');
    await repository.stage('1', 'stage-request', input);
    await repository.runOne(adapter);
    expect(starts).toHaveLength(1);
    const before = await fixture.db.get('writer').select().from(legacyOrderImportRows);
    await blockNextUnsent(input.id);
    const operationId = randomUUID();
    await expect(
      repository.resume('1', input.id, operationId, 'resume-denied'),
    ).rejects.toMatchObject({
      code: 'ORDER_IMPORT_COUNTER_UNAVAILABLE',
    });
    expect(await fixture.db.get('writer').select().from(legacyOrderImportResumptions)).toHaveLength(
      0,
    );
    await restore();
    const receipts = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.resume('1', input.id, operationId, 'resume-' + index),
      ),
    );
    expect(receipts.every((value) => JSON.stringify(value) === JSON.stringify(receipts[0]))).toBe(
      true,
    );
    expect(await fixture.db.get('writer').select().from(legacyOrderImportResumptions)).toHaveLength(
      1,
    );
    const after = await fixture.db.get('writer').select().from(legacyOrderImportRows);
    expect(after).toEqual(before);
    expect(await repository.detail('1', input.id)).toMatchObject({
      state: 'QUEUED',
      importedOrders: 1,
    });
    await repository.runOne(adapter);
    expect(starts).toHaveLength(2);
    expect(new Set(starts).size).toBe(2);
    expect(await repository.detail('1', input.id)).toMatchObject({
      state: 'COMPLETED',
      importedOrders: 2,
    });
    expect(await repository.readResumption('1', input.id, operationId)).toEqual(receipts[0]);
  });

  it('does not let a retry of an accepted resume command restart a later access block', async () => {
    const input = runtimeImportInput(),
      operationId = randomUUID();
    await repository.stage('1', 'stage', input);
    await blockNextUnsent(input.id);
    await restore();
    const accepted = await repository.resume('1', input.id, operationId, 'first-resume');
    await blockNextUnsent(input.id);
    await restore();
    expect(await repository.resume('1', input.id, operationId, 'lost-response-retry')).toEqual(
      accepted,
    );
    expect(await repository.detail('1', input.id)).toMatchObject({ state: 'BLOCKED' });
    await repository.resume('1', input.id, randomUUID(), 'explicit-second-resume');
    expect(await repository.detail('1', input.id)).toMatchObject({ state: 'QUEUED' });
    expect(starts).toHaveLength(0);
  });

  it('rejects other block reasons and any uncertain financial row atomically', async () => {
    const input = runtimeImportInput();
    await repository.stage('1', 'stage', input);
    await blockNextUnsent(input.id);
    await restore();
    await fixture.db
      .get('writer')
      .update(legacyOrderImports)
      .set({ errorCode: 'ORDER_IMPORT_PAYLOAD_INVALID' })
      .where(eq(legacyOrderImports.id, input.id));
    await expect(
      repository.resume('1', input.id, randomUUID(), 'bad-payload'),
    ).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RESUME_NOT_AVAILABLE',
    });
    await fixture.db
      .get('writer')
      .update(legacyOrderImports)
      .set({ errorCode: 'ORDER_IMPORT_ACCESS_CHANGED' })
      .where(eq(legacyOrderImports.id, input.id));
    await fixture.db.get('writer').update(legacyOrderImportRows).set({ state: 'RECONCILING' });
    await expect(
      repository.resume('1', input.id, randomUUID(), 'unknown-row'),
    ).rejects.toMatchObject({
      code: 'ORDER_IMPORT_IN_FLIGHT',
    });
    expect(await fixture.db.get('writer').select().from(legacyOrderImportResumptions)).toHaveLength(
      0,
    );
    expect(starts).toHaveLength(0);
  });

  it('binds accepted receipts to the original job, actor, encrypted request and retained proof key', async () => {
    const first = runtimeImportInput(),
      operationId = randomUUID();
    await repository.stage('1', 'first', first);
    await blockNextUnsent(first.id);
    await restore();
    await repository.resume('1', first.id, operationId, 'resume');
    const second = runtimeImportInput();
    await repository.stage('1', 'second', second);
    await expect(
      repository.resume('1', second.id, operationId, 'nonce-reuse'),
    ).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RESUMPTION_CONFLICT',
    });
    await expect(repository.readResumption('2', first.id, operationId)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_NOT_FOUND',
    });
    await fixture.db
      .get('writer')
      .update(legacyOrderImportResumptions)
      .set({ requestId: 'modified' })
      .where(eq(legacyOrderImportResumptions.id, operationId));
    await expect(repository.readResumption('1', first.id, operationId)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_RESUMPTION_CONFLICT',
    });
  });
});
