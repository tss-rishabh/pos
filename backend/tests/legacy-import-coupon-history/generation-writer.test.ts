import type { Query } from '@google-cloud/bigquery';
import { describe, expect, it, vi } from 'vitest';
import {
  generationWritePlan,
  generationWarehouseWriter,
  restoreGenerationWritePlan,
  type GenerationWritePlan,
  type GenerationWriterClient,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-writer.js';
import { generationFixture } from './generation-fixtures.js';
function fixture() {
  const f = generationFixture(),
    snapshot = { capture: f.capture, controls: f.controls, logs: f.logRows },
    plan = generationWritePlan(snapshot, f.options, f.authority.sourceKey, undefined, f.now);
  const metadata = {
    jobReference: { projectId: 'tssgcp2025', location: 'asia-south1', jobId: plan.jobId },
    configuration: {
      query: {
        query: plan.statement,
        useLegacySql: false,
        queryParameters: Object.entries(plan.params).map(([name, value]) => ({
          name,
          parameterType: { type: plan.types[name] },
          parameterValue: { value: String(value) },
        })),
      },
    },
    statistics: { query: { statementType: 'SCRIPT', totalBytesProcessed: '12' } },
    status: { state: 'DONE' },
  };
  const job = {
    metadata,
    getMetadata: vi.fn(async () => [metadata] as const),
    getQueryResults: vi.fn(async () => [[], null, { jobComplete: true }] as const),
    cancel: vi.fn(async () => undefined),
  };
  const create = vi.fn(
    async (input: Query) =>
      [
        {
          ...job,
          metadata: input.dryRun
            ? { statistics: { query: { totalBytesProcessed: '12' } } }
            : metadata,
        },
      ] as const,
  );
  const client: GenerationWriterClient = {
      projectId: 'tssgcp2025',
      location: 'asia-south1',
      createQueryJob: create,
      job: vi.fn(() => job),
    },
    factory = vi.fn(() => client);
  const writer = generationWarehouseWriter({
    contract: 'pos-csv-coupon-generation-writer-v1',
    writerIdentity: 'separate-writer',
    readerIdentity: 'readonly-reader',
    maxBytes: 50000000,
    timeoutMs: 1000,
    clientFactory: factory,
  });
  return { ...f, snapshot, plan, metadata, job, client, create, factory, writer };
}
describe('explicit separate writer and immutable original job protocol', () => {
  it('is pure at construction, requires a distinct explicit writer and never defaults to readonly ADC', () => {
    const f = fixture();
    expect(f.factory).not.toHaveBeenCalled();
    expect(() =>
      generationWarehouseWriter({
        contract: 'pos-csv-coupon-generation-writer-v1',
        writerIdentity: 'same',
        readerIdentity: 'same',
        maxBytes: 1,
        timeoutMs: 1000,
        clientFactory: f.factory,
      }),
    ).toThrow();
    expect(f.factory).not.toHaveBeenCalled();
  });
  it('authors atomic immutable native-log/control export with raw orders and no raw-CDC completeness claim', () => {
    const f = fixture();
    expect(f.plan.statement).toContain('BEGIN TRANSACTION;');
    expect(f.plan.statement).toContain('COMMIT TRANSACTION;');
    expect(f.plan.statement).toContain('ASSERT NOT EXISTS');
    expect(f.plan.statement).toContain('tss_mysql_raw_layer.tss_orders');
    expect(f.plan.statement).not.toContain('tss_order_coupon_log');
    expect(f.plan.statement).not.toMatch(/\bDELETE\b|\bUPDATE\b|\bMERGE\b|\bEXPORT\b/);
    expect(f.plan.statement).not.toContain(f.scope.customerId);
    expect(f.plan.params.logsJson).toBe(JSON.stringify(f.logRows));
    expect(Object.isFrozen(f.plan)).toBe(true);
    expect(() =>
      restoreGenerationWritePlan(
        { ...f.plan, statement: f.plan.statement + ' changed' },
        f.authority.sourceKey,
      ),
    ).toThrow();
  });
  it('dry-runs before writing, uses original fixed job ID and authenticates exact original typed parameters', async () => {
    const f = fixture(),
      result = await f.writer.start(f.plan, new AbortController().signal);
    expect(result.status).toBe('succeeded');
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[0]![0].dryRun).toBe(true);
    expect(f.create.mock.calls[1]![0]).toMatchObject({
      jobId: f.plan.jobId,
      dryRun: false,
      location: 'asia-south1',
      useLegacySql: false,
    });
    const recovered = await f.writer.read(
      restoreGenerationWritePlan(f.plan, f.authority.sourceKey),
      new AbortController().signal,
    );
    expect(recovered).toEqual(result);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.job.getMetadata).toHaveBeenCalledTimes(1);
  });
  it.each(['job', 'query', 'parameter', 'project', 'error'] as const)(
    'never calls a mismatching %s result completed',
    async (kind) => {
      const f = fixture();
      if (kind === 'job') f.metadata.jobReference.jobId = 'wrong';
      if (kind === 'query') f.metadata.configuration.query.query = 'SELECT 1';
      if (kind === 'parameter')
        f.metadata.configuration.query.queryParameters[0]!.parameterValue.value = 'wrong';
      if (kind === 'project') f.metadata.jobReference.projectId = 'wrong';
      if (kind === 'error')
        Object.assign(f.metadata.status, { errorResult: { reason: 'invalidQuery' } });
      const result = await f.writer.start(f.plan, new AbortController().signal);
      expect(result.status).toBe(kind === 'error' ? 'failed' : 'unknown');
    },
  );
  it('unknown/404 read never executes another script or discloses SDK canaries', async () => {
    const f = fixture();
    f.job.getMetadata = vi.fn(async () => {
      throw Object.assign(Error('credential-canary'), {
        request: { authorization: 'header-canary' },
      });
    });
    const result = await f.writer.read(f.plan, new AbortController().signal);
    expect(result.status).toBe('unknown');
    expect(f.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/credential-canary|header-canary/);
  });
  it('refuses an unbranded plan before credentials or query I/O', async () => {
    const f = fixture();
    await expect(
      f.writer.start({ ...f.plan } as GenerationWritePlan, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(f.factory).not.toHaveBeenCalled();
  });
});
