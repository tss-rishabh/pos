import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Query } from '@google-cloud/bigquery';
interface MockJob {
  metadata: unknown;
  getMetadata: () => Promise<[unknown]>;
  cancel: () => Promise<void>;
  getQueryResults: () => Promise<[unknown[]]>;
}
const sdk = vi.hoisted(() => ({
  clients: [] as string[],
  create: vi.fn<(email: string, input: Query) => Promise<[MockJob]>>(),
  read: vi.fn<(email: string, id: string, location: string) => MockJob>(),
}));
vi.mock('@google-cloud/bigquery', async () => {
  const actual =
    await vi.importActual<typeof import('@google-cloud/bigquery')>('@google-cloud/bigquery');
  class FakeBigQuery {
    static date = actual.BigQuery.date;
    static datetime = actual.BigQuery.datetime;
    static timestamp = actual.BigQuery.timestamp;
    static time = actual.BigQuery.time;
    static geography = actual.BigQuery.geography;
    timeout = 0;
    email: string;
    constructor(options: { credentials: { client_email: string } }) {
      this.email = options.credentials.client_email;
      sdk.clients.push(this.email);
    }
    createQueryJob(input: Query) {
      return sdk.create(this.email, input);
    }
    job(id: string, scope: { location: string }) {
      return sdk.read(this.email, id, scope.location);
    }
  }
  return { ...actual, BigQuery: FakeBigQuery };
});
import {
  counterGenerationPlan,
  counterGenerationWarehouse,
} from '../../src/modules/legacy-order-imports/screening-counter/counter-generation-warehouse.js';
import { screeningCounterWarehouseStatement } from '../../src/modules/legacy-order-imports/screening-counter/warehouse.js';
import { generationNow, generationOptions, generationSnapshot } from './generation-fixture.js';
const reader = 'reports-bigquery-reader@tssgcp2025.iam.gserviceaccount.com',
  writer = 'quota-independent-writer@tssgcp2025.iam.gserviceaccount.com';
const credentials = (email: string) => ({
  type: 'service_account' as const,
  project_id: 'tssgcp2025' as const,
  client_email: email,
  private_key: 'synthetic-not-a-private-key-'.repeat(3),
});
function job(metadata: unknown, rows: unknown[] = []): MockJob {
  return {
    metadata,
    getMetadata: vi.fn(async () => [metadata]),
    cancel: vi.fn(async () => undefined),
    getQueryResults: vi.fn(async () => [rows]),
  };
}
function metadata(plan: ReturnType<typeof counterGenerationPlan>, state = 'DONE', corrupt = false) {
  return {
    jobReference: { projectId: 'tssgcp2025', location: 'asia-south1', jobId: plan.jobId },
    configuration: {
      query: {
        query: plan.statement,
        useLegacySql: false,
        queryParameters: Object.entries(plan.params).map(([name, value]) => ({
          name,
          parameterType: { type: plan.types[name] },
          parameterValue: { value: corrupt && name === 'rowsJson' ? '[]' : value },
        })),
      },
    },
    statistics: { query: { statementType: 'SCRIPT' } },
    status: { state },
  };
}
describe('immutable quota warehouse materialization and independent verification', () => {
  beforeEach(() => {
    sdk.clients.length = 0;
    sdk.create.mockReset();
    sdk.read.mockReset();
    vi.restoreAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(generationNow);
  });
  it('constructs no SDK clients and refuses the report-reader identity as writer', () => {
    expect(() =>
      counterGenerationWarehouse(generationOptions(), {
        reader: credentials(reader),
        writer: credentials(reader),
      }),
    ).toThrow();
    expect(sdk.clients).toEqual([]);
    counterGenerationWarehouse(generationOptions(), {
      reader: credentials(reader),
      writer: credentials(writer),
    });
    expect(sdk.clients).toEqual([]);
  });
  it('dry-runs before one immutable script, preserving exact large row IDs and typed dates', async () => {
    const snapshot = generationSnapshot(),
      plan = counterGenerationPlan(snapshot, generationOptions()),
      queries: Query[] = [];
    sdk.create.mockImplementation(async (email, input) => {
      expect(email).toBe(writer);
      queries.push(input);
      return [
        input.dryRun
          ? job({ statistics: { query: { totalBytesProcessed: '1' } } })
          : job(metadata(plan)),
      ];
    });
    const result = await counterGenerationWarehouse(generationOptions(), {
      reader: credentials(reader),
      writer: credentials(writer),
    }).start(plan, new AbortController().signal);
    expect(result.status).toBe('succeeded');
    expect(queries).toHaveLength(2);
    expect(queries[0]?.dryRun).toBe(true);
    expect(queries[1]).toMatchObject({
      jobId: plan.jobId,
      useLegacySql: false,
      useQueryCache: false,
      maximumBytesBilled: '50000000',
    });
    expect(queries[1]!.params?.day).toMatchObject({ value: '2026-11-18' });
    expect(queries[1]!.params?.rowsJson).toContain('9007199254740993');
    expect(plan.statement).toMatch(/^BEGIN TRANSACTION;/);
    expect(plan.statement).toMatch(/COMMIT TRANSACTION;$/);
    expect(plan.statement).not.toMatch(/\b(?:CREATE|UPDATE|DELETE|MERGE|EXPORT)\b/);
  });
  it('a dry-run budget refusal proves no materialization was submitted', async () => {
    const plan = counterGenerationPlan(generationSnapshot(), generationOptions());
    sdk.create.mockResolvedValue([
      job({ statistics: { query: { totalBytesProcessed: '50000001' } } }),
    ]);
    const result = await counterGenerationWarehouse(generationOptions(), {
      reader: credentials(reader),
      writer: credentials(writer),
    }).start(plan, new AbortController().signal);
    expect(result.status).toBe('failed');
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(sdk.create.mock.calls[0]![1].dryRun).toBe(true);
  });
  it('lost write acknowledgement recovers only the exact original job, with no second POST', async () => {
    const plan = counterGenerationPlan(generationSnapshot(), generationOptions());
    let submissions = 0;
    sdk.create.mockImplementation(async (_email, input) => {
      if (input.dryRun) return [job({ statistics: { query: { totalBytesProcessed: '1' } } })];
      submissions++;
      throw new Error('synthetic lost ack');
    });
    const warehouse = counterGenerationWarehouse(generationOptions(), {
      reader: credentials(reader),
      writer: credentials(writer),
    });
    expect((await warehouse.start(plan, new AbortController().signal)).status).toBe('unknown');
    sdk.read.mockReturnValue(job(metadata(plan)));
    expect((await warehouse.recover(plan, new AbortController().signal)).status).toBe('succeeded');
    expect(submissions).toBe(1);
    expect(sdk.read).toHaveBeenCalledWith(writer, plan.jobId, 'asia-south1');
  });
  it('refuses DONE metadata that changed one exact typed parameter', async () => {
    const plan = counterGenerationPlan(generationSnapshot(), generationOptions());
    sdk.read.mockReturnValue(job(metadata(plan, 'DONE', true)));
    expect(
      (
        await counterGenerationWarehouse(generationOptions(), {
          reader: credentials(reader),
          writer: credentials(writer),
        }).recover(plan, new AbortController().signal)
      ).status,
    ).toBe('unknown');
  });
  it('verifies a complete generation through a separate SELECT-only reader and exact cohort comparison', async () => {
    const snapshot = generationSnapshot(),
      plan = counterGenerationPlan(snapshot, generationOptions()),
      o = generationOptions(),
      c = snapshot.capture;
    const document = JSON.stringify({
      publications: [
        {
          contract: 'pos-screening-counter-bq-candidate-v1',
          generationId: plan.jobId.slice('pos_screening_counter_'.length),
          snapshotId: c.snapshotId,
          sourceCaptureHash: c.signature,
          sourceCdcThrough: String(c.finishedAt),
          complete: true,
          expectedRows: c.rows,
          rowsHash: c.rowsHash,
        },
      ],
      actual: { rows: '1', uniqueRows: '1', invalidRows: '0' },
      rows: snapshot.rows,
    });
    sdk.create.mockImplementation(async (email, input) => {
      expect(email).toBe(reader);
      expect(input.query).toBe(
        screeningCounterWarehouseStatement({ publicationsView: o.publications, rowsView: o.rows }),
      );
      expect(input.query).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|EXPORT)\b/);
      return [job({ statistics: { query: { totalBytesProcessed: '3' } } }, [{ document }])];
    });
    const result = await counterGenerationWarehouse(o, {
      reader: credentials(reader),
      writer: credentials(writer),
    }).verify(snapshot, new AbortController().signal);
    expect(result.rows).toEqual(snapshot.rows);
    expect(sdk.clients).toEqual([reader]);
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });
  it('refuses an expired source capture without SDK construction or another query', async () => {
    const snapshot = generationSnapshot();
    vi.spyOn(Date, 'now').mockReturnValue(generationNow + 60001);
    await expect(
      counterGenerationWarehouse(generationOptions(), {
        reader: credentials(reader),
        writer: credentials(writer),
      }).verify(snapshot, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SCREENING_COUNTER_SOURCE_CHANGED' });
    expect(sdk.clients).toEqual([]);
  });
});
