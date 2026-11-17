import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { bigint, index, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { identifier } from '../../domain/validation.js';
import { originDigest, originError, originHashSchema } from './contracts.js';
import { originHistoryKeys, originHistoryWitnessSchema } from './history-contracts.js';

export const originHistoryDemandContract = 'pos-screening-origin-history-demands-v1';
export const originHistoryDemandSchema = z
  .object({
    commandId: z.uuid(),
    customerId: identifier,
    requestHash: originHashSchema,
    cartHash: originHashSchema,
    witness: originHistoryWitnessSchema,
  })
  .strict();
export interface OriginHistoryDemandPort {
  enqueue(
    scope: z.infer<typeof originHistoryDemandSchema>,
    request: { signal: AbortSignal },
  ): Promise<{ id: string }>;
}
const phases = z.enum([
  'demand',
  'capturing',
  'prepared',
  'materializing',
  'materialized',
  'qualified',
  'publishing',
  'published',
  'failed',
  'superseded',
]);
export const originHistoryGenerationJobs = mysqlTable(
  'pos_rewrite_origin_history_generation_jobs',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 24 }).notNull(),
    payload: longtext('payload').notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
    leaseToken: varchar('lease_token', { length: 36 }),
    leaseUntil: bigint('lease_until_ms', { mode: 'number' }),
  },
  (table) => [index('ix_origin_history_jobs_pending').on(table.phase, table.updatedAt, table.id)],
);
export interface OriginHistoryJournalRecord {
  id: string;
  version: string;
  phase: z.infer<typeof phases>;
  data: unknown;
  updatedAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
}
/** Leaf encrypted queue/journal only. No source capture, publisher, SDK, HTTP,
 * credential factory or env loader can be reached from web demand enqueue. */
export function originHistoryJournal(
  db: Pick<Databases, 'get'>,
  journalKey: string,
  clock = Date.now,
) {
  originHistoryKeys(journalKey);
  const key = createHmac('sha256', journalKey)
    .update('screening-origin-history:journal-encryption:v1')
    .digest();
  const aad = (r: Omit<OriginHistoryJournalRecord, 'data'>) =>
    Buffer.from(
      JSON.stringify([r.id, r.version, r.phase, r.updatedAt, r.leaseToken, r.leaseUntil]),
    );
  function encode(record: OriginHistoryJournalRecord) {
    const { data, ...scope } = record,
      plain = Buffer.from(JSON.stringify(data));
    if (plain.length > 26000000) throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_BYTES');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(scope));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  function decode(
    row: typeof originHistoryGenerationJobs.$inferSelect,
  ): OriginHistoryJournalRecord {
    try {
      const scope = {
        id: originHashSchema.parse(row.id),
        version: String(row.version),
        phase: phases.parse(row.phase),
        updatedAt: z.number().int().positive().safe().parse(row.updatedAt),
        leaseToken: z.uuid().nullable().parse(row.leaseToken),
        leaseUntil: z.number().int().positive().safe().nullable().parse(row.leaseUntil),
      };
      if (row.payload.length > 35000000 || !/^[A-Za-z0-9_-]+$/.test(row.payload))
        throw originError();
      const bytes = Buffer.from(row.payload, 'base64url');
      if (bytes.length < 28 || bytes.length > 26000028) throw originError();
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAAD(aad(scope));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return {
        ...scope,
        data: JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
        ) as unknown,
      };
    } catch {
      throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_INVALID');
    }
  }
  type Tx = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
  const load = async (tx: Tx, id: string) => {
    originHashSchema.parse(id);
    const [row] = await tx
      .select()
      .from(originHistoryGenerationJobs)
      .where(eq(originHistoryGenerationJobs.id, id))
      .limit(1)
      .for('update');
    if (!row) throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_MISSING');
    return decode(row);
  };
  return {
    async create(id: string, data: unknown) {
      originHashSchema.parse(id);
      return db.get('writer').transaction(async (tx) => {
        const record: OriginHistoryJournalRecord = {
          id,
          version: '1',
          phase: 'demand',
          data,
          updatedAt: clock(),
          leaseToken: null,
          leaseUntil: null,
        };
        await tx
          .insert(originHistoryGenerationJobs)
          .values({
            id,
            version: 1n,
            phase: record.phase,
            payload: encode(record),
            updatedAt: record.updatedAt,
            leaseToken: null,
            leaseUntil: null,
          })
          .onDuplicateKeyUpdate({ set: { id } });
        return load(tx, id);
      });
    },
    read: (id: string) => db.get('writer').transaction((tx) => load(tx, id)),
    async change(
      id: string,
      change: (record: OriginHistoryJournalRecord) => OriginHistoryJournalRecord | null,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const prior = await load(tx, id),
          candidate = change(prior);
        if (!candidate) return prior;
        const next = {
          ...candidate,
          id: prior.id,
          version: String(BigInt(prior.version) + 1n),
          updatedAt: clock(),
        };
        phases.parse(next.phase);
        if (BigInt(next.version) > 18446744073709551615n)
          throw originError('SCREENING_ORIGIN_HISTORY_JOURNAL_OVERFLOW');
        const payload = encode(next);
        await tx
          .update(originHistoryGenerationJobs)
          .set({
            version: BigInt(next.version),
            phase: next.phase,
            payload,
            updatedAt: next.updatedAt,
            leaseToken: next.leaseToken,
            leaseUntil: next.leaseUntil,
          })
          .where(eq(originHistoryGenerationJobs.id, id));
        return next;
      });
    },
    async pending(limit = 10) {
      z.number().int().min(1).max(100).parse(limit);
      const results: { id: string; updatedAt: number }[] = [];
      for (const phase of [
        'demand',
        'capturing',
        'prepared',
        'materializing',
        'materialized',
        'qualified',
        'publishing',
      ] as const)
        results.push(
          ...(await db
            .get('writer')
            .select({
              id: originHistoryGenerationJobs.id,
              updatedAt: originHistoryGenerationJobs.updatedAt,
            })
            .from(originHistoryGenerationJobs)
            .where(eq(originHistoryGenerationJobs.phase, phase))
            .orderBy(
              asc(originHistoryGenerationJobs.updatedAt),
              asc(originHistoryGenerationJobs.id),
            )
            .limit(limit)),
        );
      return results
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((row) => row.id);
    },
  };
}
export function originHistoryDemands(
  db: Pick<Databases, 'get'>,
  authority: { journalKey: string; sourceKey: string },
  clock = Date.now,
): OriginHistoryDemandPort {
  originHistoryKeys(authority.journalKey, authority.sourceKey);
  const journal = originHistoryJournal(db, authority.journalKey, clock);
  return {
    async enqueue(input, request) {
      request.signal.throwIfAborted();
      const scope = originHistoryDemandSchema.parse(input),
        id = originDigest(authority.journalKey, 'history-demand', {
          customerId: scope.customerId,
          witness: scope.witness,
        });
      await journal.create(id, { contract: originHistoryDemandContract, scope });
      request.signal.throwIfAborted();
      return { id };
    },
  };
}
