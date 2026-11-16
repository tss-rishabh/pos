import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { identifier } from '../../domain/validation.js';
import { AppError, unavailable } from '../../domain/errors.js';
import { warehouseService, warehouseScalar } from '../warehouse.js';
import { warehouseView } from '../operational-reports/report-inputs.js';
import {
  importJobDto,
  stockImportCells,
  stockImportCommand,
  stockImportHeaders,
  stockCsv,
  type importHistoryInput,
  type importRowListInput,
} from './import-domain.js';
import type { inventoryImports } from './import-schema.js';
import { utcMediaTimestamp } from './media-domain.js';
import { historicalInventoryImport, warehouseImportCutoff } from './import-time.js';
import type { ImportCells, ImportCommand } from './import-profile.js';

type Job = Omit<typeof inventoryImports.$inferSelect, 'profile'> & {
  profile?: 'stock' | 'parent-store';
};
export interface ImportHistoryProfile {
  kind: 'stock' | 'parent-store';
  cells: z.ZodType<ImportCells>;
  command: z.ZodType<ImportCommand>;
  headers: readonly string[];
}
const stockHistoryProfile: ImportHistoryProfile = {
  kind: 'stock',
  cells: stockImportCells,
  command: stockImportCommand,
  headers: stockImportHeaders,
};
type Warehouse = Pick<ReturnType<typeof warehouseService>, 'queryReport'>;
const optionalView = z.preprocess((value) => (value === '' ? undefined : value), warehouseView);
export function readImportHistoryOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      BQ_INVENTORY_IMPORTS_VIEW: optionalView,
      BQ_INVENTORY_IMPORT_ROWS_VIEW: optionalView,
    })
    .parse(env);
}
export type ImportHistoryOptions = ReturnType<typeof readImportHistoryOptions>;
const integer = (minimum: number, maximum: number) =>
  z.preprocess(
    warehouseScalar,
    z
      .union([
        z.number().int().refine(Number.isSafeInteger),
        z
          .string()
          .regex(/^\d+$/)
          .transform((value, context) => {
            const parsed = BigInt(value);
            if (parsed > BigInt(maximum)) {
              context.addIssue({ code: 'custom', message: 'Integer range' });
              return z.NEVER;
            }
            return Number(parsed);
          }),
      ])
      .pipe(z.number().int().min(minimum).max(maximum)),
  );
const string = z.preprocess(warehouseScalar, z.string());
const nullableCode = z.preprocess(
  warehouseScalar,
  z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
);
const timestamp = string.transform((value, context) => {
  try {
    return utcMediaTimestamp(Temporal.Instant.from(value));
  } catch {
    context.addIssue({ code: 'custom', message: 'UTC timestamp required' });
    return z.NEVER;
  }
});
const rawJob = z.object({
  profile: z.preprocess(warehouseScalar, z.enum(['stock', 'parent-store']).default('stock')),
  id: z.preprocess(warehouseScalar, z.uuid()),
  sequence: z.preprocess(warehouseScalar, identifier),
  actorId: z.preprocess(warehouseScalar, identifier),
  checksum: string.pipe(z.string().regex(/^[a-f0-9]{64}$/)),
  name: string.pipe(z.string().min(1).max(120)),
  state: string.pipe(z.enum(['COMPLETED', 'CANCELLED'])),
  totalRows: integer(1, 5000),
  processedRows: integer(0, 5000),
  successfulRows: integer(0, 5000),
  failedRows: integer(0, 5000),
  errorCode: nullableCode,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const rawStats = rawJob.extend({
  recordCount: integer(1, 5000),
  distinctRecords: integer(1, 5000),
  minimumRecord: integer(2, 5001),
  maximumRecord: integer(2, 5001),
  succeededCount: integer(0, 5000),
  failedCount: integer(0, 5000),
  cancelledCount: integer(0, 5000),
  unexpectedCount: integer(0, 5000),
});
function json(value: unknown): unknown {
  const normalized = warehouseScalar(value);
  if (typeof normalized !== 'string') return normalized;
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return undefined;
  }
}
const historicalRowSchema = (profile: ImportHistoryProfile) =>
  z
    .object({
      profile: z.preprocess(warehouseScalar, z.enum(['stock', 'parent-store']).default('stock')),
      importId: z.preprocess(warehouseScalar, z.uuid()),
      actorId: z.preprocess(warehouseScalar, identifier),
      checksum: string.pipe(z.string().regex(/^[a-f0-9]{64}$/)),
      updatedAt: timestamp,
      rowNumber: integer(2, 5001),
      cells: z.preprocess(json, profile.cells),
      command: z.preprocess(json, profile.command.nullable()),
      state: string.pipe(z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED'])),
      errorCode: nullableCode,
      message: z.preprocess(warehouseScalar, z.string().max(255).nullable()),
    })
    .refine((row) => row.state !== 'SUCCEEDED' || row.command !== null);
const invalid = () =>
  new AppError(
    503,
    'INVENTORY_IMPORT_HISTORY_INVALID',
    'Historical import data is incomplete or inconsistent.',
  );
export function reduceHistoricalImport(value: unknown): Job {
  const parsed = rawJob.safeParse(value);
  if (!parsed.success) throw invalid();
  const row = parsed.data;
  if (
    row.successfulRows + row.failedRows !== row.processedRows ||
    row.processedRows > row.totalRows ||
    (row.state === 'COMPLETED' && row.processedRows !== row.totalRows) ||
    row.updatedAt < row.createdAt
  )
    throw invalid();
  return { ...row, sequence: BigInt(row.sequence), requestId: null };
}
const commonFields = `CAST(i.import_sequence AS STRING) AS sequence, i.import_id AS id, i.actor_id AS actorId, i.filename AS name, i.checksum, i.state,
 CAST(i.total_rows AS STRING) AS totalRows, CAST(i.processed_rows AS STRING) AS processedRows, CAST(i.successful_rows AS STRING) AS successfulRows, CAST(i.failed_rows AS STRING) AS failedRows, i.error_code AS errorCode,
 FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ',i.created_at,'UTC') AS createdAt, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ',i.updated_at,'UTC') AS updatedAt`;
export function inventoryImportHistory(
  config: Config,
  options: ImportHistoryOptions = readImportHistoryOptions(),
  warehouse: Warehouse = warehouseService(config),
  clock = () => Temporal.Now.instant(),
  profile: ImportHistoryProfile = stockHistoryProfile,
) {
  const fields = `${profile.kind === 'stock' ? "'stock'" : 'i.profile'} AS profile,${commonFields}`,
    jobProfileFilter = profile.kind === 'stock' ? '' : 'i.profile=@profile AND ',
    rowProfileFilter = profile.kind === 'stock' ? '' : 'job_profile=@profile AND ',
    rowProfileField = profile.kind === 'stock' ? "'stock'" : 'job_profile',
    rawRow = historicalRowSchema(profile),
    resource = (label: string) =>
      profile.kind === 'stock' ? label : label.replace('inventory-import', 'parent-store-import');
  const metadata = () =>
    options.BQ_INVENTORY_IMPORTS_VIEW
      ? '`' + options.BQ_INVENTORY_IMPORTS_VIEW + '`'
      : unavailable('BigQuery inventory import view');
  const records = () =>
    options.BQ_INVENTORY_IMPORT_ROWS_VIEW
      ? '`' + options.BQ_INVENTORY_IMPORT_ROWS_VIEW + '`'
      : unavailable('BigQuery inventory import records view');
  const snapshot = (anchor: Job) => ({
    ...(profile.kind === 'parent-store' ? { profile: profile.kind } : {}),
    importId: anchor.id,
    actorId: anchor.actorId,
    checksum: anchor.checksum,
    createdAt: anchor.createdAt.replace(' ', 'T') + 'Z',
    updatedAt: anchor.updatedAt.replace(' ', 'T') + 'Z',
  });
  const snapshotTypes: Record<string, string> = {
    ...(profile.kind === 'parent-store' ? { profile: 'STRING' } : {}),
    importId: 'STRING',
    actorId: 'STRING',
    checksum: 'STRING',
    createdAt: 'TIMESTAMP',
    updatedAt: 'TIMESTAMP',
  };
  async function verify(anchor: Job) {
    if ((anchor.profile || 'stock') !== profile.kind) throw invalid();
    const exactCutoff = clock().subtract({ hours: 24 });
    if (!historicalInventoryImport(anchor, exactCutoff)) throw invalid();
    const cutoff = warehouseImportCutoff(exactCutoff);
    const query = `WITH record_stats AS (
 SELECT CAST(COUNT(*) AS STRING) AS recordCount, CAST(COUNT(DISTINCT record_number) AS STRING) AS distinctRecords,
 CAST(MIN(record_number) AS STRING) AS minimumRecord, CAST(MAX(record_number) AS STRING) AS maximumRecord,
 CAST(COUNTIF(state='SUCCEEDED') AS STRING) AS succeededCount, CAST(COUNTIF(state='FAILED') AS STRING) AS failedCount,
 CAST(COUNTIF(state='CANCELLED') AS STRING) AS cancelledCount, CAST(COUNTIF(state IS NULL OR state NOT IN ('SUCCEEDED','FAILED','CANCELLED')) AS STRING) AS unexpectedCount
 FROM ${records()} WHERE ${rowProfileFilter}import_id=@importId AND actor_id=@actorId AND job_checksum=@checksum AND job_updated_at=@updatedAt AND job_created_at=@createdAt AND DATE(job_created_at)=DATE(@createdAt)
 ) SELECT ${fields},s.* FROM ${metadata()} i CROSS JOIN record_stats s
 WHERE ${jobProfileFilter}i.import_id=@importId AND i.actor_id=@actorId AND i.checksum=@checksum AND i.created_at=@createdAt AND i.updated_at=@updatedAt AND i.created_at<@cutoff AND i.state IN ('COMPLETED','CANCELLED') LIMIT 2`;
    const result = await warehouse.queryReport(
      query,
      { ...snapshot(anchor), cutoff },
      { ...snapshotTypes, cutoff: 'TIMESTAMP' },
      resource('inventory-import-history'),
    );
    if (result.length !== 1) throw invalid();
    const row = reduceHistoricalImport(result[0]);
    if (
      row.id !== anchor.id ||
      row.profile !== profile.kind ||
      row.actorId !== anchor.actorId ||
      row.sequence !== anchor.sequence ||
      row.checksum !== anchor.checksum ||
      row.name !== anchor.name ||
      row.state !== anchor.state ||
      row.totalRows !== anchor.totalRows ||
      row.processedRows !== anchor.processedRows ||
      row.successfulRows !== anchor.successfulRows ||
      row.failedRows !== anchor.failedRows ||
      row.createdAt !== anchor.createdAt ||
      row.updatedAt !== anchor.updatedAt ||
      row.errorCode !== anchor.errorCode
    )
      throw invalid();
    const parsed = rawStats.safeParse(result[0]);
    if (!parsed.success) throw invalid();
    const stats = parsed.data,
      cancelled = row.state === 'CANCELLED' ? row.totalRows - row.processedRows : 0;
    if (
      stats.recordCount !== row.totalRows ||
      stats.distinctRecords !== row.totalRows ||
      stats.minimumRecord !== 2 ||
      stats.maximumRecord !== row.totalRows + 1 ||
      stats.succeededCount !== row.successfulRows ||
      stats.failedCount !== row.failedRows ||
      stats.cancelledCount !== cancelled ||
      stats.unexpectedCount !== 0
    )
      throw invalid();
    return row;
  }
  async function page(anchor: Job, input: z.infer<typeof importRowListInput>, limit: number) {
    const result = await warehouse.queryReport(
      `SELECT ${rowProfileField} AS profile,import_id AS importId,actor_id AS actorId,job_checksum AS checksum,FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E3SZ',job_updated_at,'UTC') AS updatedAt,CAST(record_number AS STRING) AS rowNumber,cells_json AS cells,command_json AS command,state,error_code AS errorCode,message
 FROM ${records()} WHERE ${rowProfileFilter}import_id=@importId AND actor_id=@actorId AND job_checksum=@checksum AND job_updated_at=@updatedAt AND job_created_at=@createdAt AND DATE(job_created_at)=DATE(@createdAt) AND record_number>@after AND (@allStates OR state=@state) ORDER BY record_number ASC LIMIT @limit`,
      {
        ...snapshot(anchor),
        after: input.after,
        allStates: input.state === 'all',
        state: input.state,
        limit,
      },
      { ...snapshotTypes, after: 'INT64', allStates: 'BOOL', state: 'STRING', limit: 'INT64' },
      resource('inventory-import-records'),
    );
    if (result.length > limit) throw invalid();
    const rows = result
      .map((value) => {
        const parsed = rawRow.safeParse(value);
        if (!parsed.success) throw invalid();
        return parsed.data;
      })
      .sort((one, two) => one.rowNumber - two.rowNumber);
    const seen = new Set<number>();
    for (const row of rows) {
      if (
        row.importId !== anchor.id ||
        row.profile !== profile.kind ||
        row.actorId !== anchor.actorId ||
        row.checksum !== anchor.checksum ||
        row.updatedAt !== anchor.updatedAt ||
        row.rowNumber <= input.after ||
        row.rowNumber > anchor.totalRows + 1 ||
        seen.has(row.rowNumber) ||
        (input.state !== 'all' && row.state !== input.state)
      )
        throw invalid();
      seen.add(row.rowNumber);
    }
    return rows.map((row) => ({
      importId: row.importId,
      rowNumber: row.rowNumber,
      cells: row.cells,
      command: row.command,
      state: row.state,
      errorCode: row.errorCode,
      message: row.message,
    }));
  }
  return {
    enabled:
      !!config.BIGQUERY_PROJECT_ID &&
      !!options.BQ_INVENTORY_IMPORTS_VIEW &&
      !!options.BQ_INVENTORY_IMPORT_ROWS_VIEW,
    async list(
      scope: { actorId: string; allActors: boolean },
      input: z.infer<typeof importHistoryInput>,
    ) {
      identifier.parse(scope.actorId);
      const from = Temporal.PlainDate.from(input.from),
        to = Temporal.PlainDate.from(input.to),
        span = to.since(from, { largestUnit: 'days' }).days;
      if (span < 0 || span > 366)
        throw new AppError(400, 'INVALID_DATE_RANGE', 'Choose a history range up to 366 days.');
      const start = from
          .toZonedDateTime({ timeZone: config.BUSINESS_TIMEZONE, plainTime: '00:00' })
          .toInstant(),
        end = to
          .add({ days: 1 })
          .toZonedDateTime({ timeZone: config.BUSINESS_TIMEZONE, plainTime: '00:00' })
          .toInstant(),
        cutoff = clock().subtract({ hours: 24 });
      if (Temporal.Instant.compare(start, cutoff) >= 0)
        return { reader: 'bigquery' as const, data: [], nextCursor: null };
      const result = await warehouse.queryReport(
        `SELECT ${fields} FROM ${metadata()} i WHERE ${jobProfileFilter}i.created_at>=@start AND i.created_at<@end AND i.created_at<@cutoff AND i.state IN ('COMPLETED','CANCELLED') AND (@allActors OR i.actor_id=@actorId) AND (@after='0' OR CAST(i.import_sequence AS BIGNUMERIC)<CAST(@after AS BIGNUMERIC)) ORDER BY CAST(i.import_sequence AS BIGNUMERIC) DESC LIMIT @limit`,
        {
          ...(profile.kind === 'parent-store' ? { profile: profile.kind } : {}),
          start: start.toString(),
          end: end.toString(),
          cutoff: warehouseImportCutoff(cutoff),
          actorId: scope.actorId,
          allActors: scope.allActors,
          after: input.after,
          limit: input.limit + 1,
        },
        {
          ...(profile.kind === 'parent-store' ? { profile: 'STRING' } : {}),
          start: 'TIMESTAMP',
          end: 'TIMESTAMP',
          cutoff: 'TIMESTAMP',
          actorId: 'STRING',
          allActors: 'BOOL',
          after: 'STRING',
          limit: 'INT64',
        },
        resource('inventory-import-history'),
      );
      if (result.length > input.limit + 1) throw invalid();
      const rows = result
          .map(reduceHistoricalImport)
          .sort((one, two) => (one.sequence > two.sequence ? -1 : 1)),
        seen = new Set<string>(),
        sequences = new Set<string>();
      for (const row of rows) {
        const createdAt = Temporal.PlainDateTime.from(row.createdAt.replace(' ', 'T'))
          .toZonedDateTime('UTC')
          .toInstant();
        if (
          (!scope.allActors && row.actorId !== scope.actorId) ||
          row.profile !== profile.kind ||
          Temporal.Instant.compare(createdAt, start) < 0 ||
          Temporal.Instant.compare(createdAt, end) >= 0 ||
          Temporal.Instant.compare(createdAt, cutoff) >= 0 ||
          (input.after !== '0' && row.sequence >= BigInt(input.after)) ||
          seen.has(row.id) ||
          sequences.has(String(row.sequence))
        )
          throw invalid();
        seen.add(row.id);
        sequences.add(String(row.sequence));
      }
      return {
        reader: 'bigquery' as const,
        data: rows.slice(0, input.limit).map(importJobDto),
        nextCursor: rows.length > input.limit ? String(rows[input.limit - 1]!.sequence) : null,
      };
    },
    async detail(anchor: Job) {
      return importJobDto(await verify(anchor));
    },
    async rows(anchor: Job, input: z.infer<typeof importRowListInput>) {
      await verify(anchor);
      const rows = await page(anchor, input, input.limit + 1);
      return {
        data: rows.slice(0, input.limit),
        nextCursor: rows.length > input.limit ? String(rows[input.limit - 1]!.rowNumber) : null,
      };
    },
    async failedCsv(anchor: Job): Promise<AsyncGenerator<string>> {
      await verify(anchor);
      const rows = await page(anchor, { after: 0, limit: 100, state: 'FAILED' }, 5001);
      if (rows.length !== anchor.failedRows) throw invalid();
      return (async function* () {
        yield stockCsv([[...profile.headers, 'Message']], true);
        for (let index = 0; index < rows.length; index += 100)
          yield stockCsv(
            rows
              .slice(index, index + 100)
              .map((row) => [...row.cells, row.message || 'Error while traversing csv data.']),
            true,
          );
      })();
    },
  };
}
export type InventoryImportHistory = ReturnType<typeof inventoryImportHistory>;
