import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import { bigint, index, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { Databases } from '../../../db/pools.js';
import { counterError, counterHash, counterPublicationSchema } from './contracts.js';
import {
  counterGenerationRecordSchema,
  counterGenerationId,
  counterGenerationDigest,
  verifyCounterGenerationSnapshot,
  type CounterGenerationSnapshot,
  type CounterGenerationRecord,
  type CounterGenerationPlan,
  type CounterGenerationReply,
} from './counter-generation-contracts.js';
export const counterGenerationJobs = mysqlTable(
  'pos_rewrite_screening_counter_generation_jobs',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 20 }).notNull(),
    payload: longtext('payload').notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (t) => [index('ix_screening_counter_generation_phase').on(t.phase, t.updatedAt, t.id)],
);
type Tx = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
export function counterGenerationJournal(
  db: Pick<Databases, 'get'>,
  keys: { journalKey: string; sourceKey: string },
  clock = Date.now,
) {
  const secret = Buffer.from(counterGenerationDigest(keys.journalKey, 'encryption', null), 'hex');
  const header = (r: Pick<CounterGenerationRecord, 'id' | 'phase' | 'version' | 'updatedAt'>) =>
    Buffer.from(JSON.stringify([r.id, r.phase, r.version, r.updatedAt]));
  function encode(record: CounterGenerationRecord) {
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > 2500000) throw counterError('GENERATION_JOURNAL');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(header(record));
    return Buffer.concat([
      nonce,
      cipher.getAuthTag(),
      cipher.update(bytes),
      cipher.final(),
    ]).toString('base64url');
  }
  function decode(row: typeof counterGenerationJobs.$inferSelect) {
    try {
      if (row.payload.length > 3400000 || !/^[A-Za-z0-9_-]+$/.test(row.payload))
        throw counterError('GENERATION_JOURNAL');
      const bytes = Buffer.from(row.payload, 'base64url'),
        h = {
          id: row.id,
          phase: row.phase,
          version: String(row.version),
          updatedAt: row.updatedAt,
        };
      if (bytes.length < 28 || bytes.length > 2500028) throw counterError('GENERATION_JOURNAL');
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAAD(header(h as CounterGenerationRecord));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const r = counterGenerationRecordSchema.parse(
        JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
        ) as unknown,
      );
      if (
        r.id !== row.id ||
        r.phase !== row.phase ||
        r.version !== String(row.version) ||
        r.updatedAt !== row.updatedAt ||
        r.id !== counterGenerationId(r.snapshot)
      )
        throw counterError('GENERATION_JOURNAL');
      verifyCounterGenerationSnapshot(r.snapshot, keys.sourceKey);
      if (r.publication !== null) counterPublicationSchema.parse(r.publication);
      return r;
    } catch {
      throw counterError('GENERATION_JOURNAL');
    }
  }
  async function load(tx: Tx, id: string) {
    const [row] = await tx
      .select()
      .from(counterGenerationJobs)
      .where(eq(counterGenerationJobs.id, counterHash.parse(id)))
      .limit(1)
      .for('update');
    if (!row) throw counterError('GENERATION_MISSING');
    return decode(row);
  }
  async function save(tx: Tx, r: CounterGenerationRecord) {
    const next = counterGenerationRecordSchema.parse({
      ...r,
      version: String(BigInt(r.version) + 1n),
      updatedAt: clock(),
    });
    if (BigInt(next.version) > 18446744073709551615n) throw counterError('GENERATION_JOURNAL');
    await tx
      .update(counterGenerationJobs)
      .set({
        phase: next.phase,
        version: BigInt(next.version),
        updatedAt: next.updatedAt,
        payload: encode(next),
      })
      .where(eq(counterGenerationJobs.id, next.id));
    return next;
  }
  return {
    async create(
      snapshot: CounterGenerationSnapshot,
      plan: CounterGenerationPlan,
      expectedGeneration: string | null,
    ) {
      verifyCounterGenerationSnapshot(snapshot, keys.sourceKey);
      if (expectedGeneration !== null) counterHash.parse(expectedGeneration);
      const now = clock(),
        r: CounterGenerationRecord = {
          id: counterGenerationId(snapshot),
          version: '1',
          phase: 'prepared',
          snapshot,
          plan,
          expectedGeneration,
          reply: null,
          publication: null,
          createdAt: now,
          updatedAt: now,
        };
      return db.get('writer').transaction(async (tx) => {
        await tx
          .insert(counterGenerationJobs)
          .values({ id: r.id, version: 1n, phase: r.phase, payload: encode(r), updatedAt: now })
          .onDuplicateKeyUpdate({ set: { id: r.id } });
        const stored = await load(tx, r.id);
        if (
          JSON.stringify(stored.snapshot) !== JSON.stringify(snapshot) ||
          JSON.stringify(stored.plan) !== JSON.stringify(plan) ||
          stored.expectedGeneration !== expectedGeneration
        )
          throw counterError('GENERATION_JOURNAL');
        return stored;
      });
    },
    read: (id: string) => db.get('writer').transaction((tx) => load(tx, id)),
    async due(limit = 2) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
        throw counterError('GENERATION_CONFIGURATION');
      return (
        await db
          .get('writer')
          .select({ id: counterGenerationJobs.id })
          .from(counterGenerationJobs)
          .where(
            inArray(counterGenerationJobs.phase, [
              'prepared',
              'materializing',
              'materialized',
              'verified',
              'seeding',
            ]),
          )
          .orderBy(asc(counterGenerationJobs.updatedAt), asc(counterGenerationJobs.id))
          .limit(limit)
      ).map((r) => r.id);
    },
    claim: (id: string, phase: 'prepared' | 'verified') =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (r.phase !== phase) return { send: false, record: r };
        return {
          send: true,
          record: await save(tx, {
            ...r,
            phase: phase === 'prepared' ? 'materializing' : 'seeding',
          }),
        };
      }),
    acknowledge: (id: string, reply: CounterGenerationReply) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (r.phase !== 'materializing') return r;
        if (reply.jobId !== r.plan.jobId || reply.queryHash !== r.plan.hash)
          throw counterError('GENERATION_JOURNAL');
        return save(tx, {
          ...r,
          reply,
          phase:
            reply.status === 'succeeded'
              ? 'materialized'
              : reply.status === 'failed'
                ? 'failed'
                : 'materializing',
        });
      }),
    verified: (id: string, publication: unknown) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (r.phase !== 'materialized') return r;
        return save(tx, {
          ...r,
          phase: 'verified',
          publication: counterPublicationSchema.parse(publication),
        });
      }),
    polled: (id: string) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        return r.phase === 'seeding' ? save(tx, r) : r;
      }),
    finish: (id: string, seeded: boolean) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (['seeded', 'failed'].includes(r.phase)) return r;
        if (seeded && (r.phase !== 'seeding' || r.publication === null))
          throw counterError('GENERATION_JOURNAL');
        return save(tx, { ...r, phase: seeded ? 'seeded' : 'failed' });
      }),
  };
}
