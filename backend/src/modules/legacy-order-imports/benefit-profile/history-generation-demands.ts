import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import { mysqlTable, varchar, bigint, longtext, index } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import type { Databases } from '../../../db/pools.js';
import { benefitDigest } from './crypto.js';
import { equalImportHash } from '../financial-adapter-primitives.js';
import { couponHistoryScopeSchema, type CouponHistoryScope } from './history.js';
import { couponHistoryWitnessSchema, type CouponHistoryWitness } from './bridge.js';
import { couponWarehouseKeys } from './history-warehouse-contracts.js';
import {
  generationScopeFor,
  generationHeadHash,
  generationError,
} from './history-generation-contracts.js';
import type {
  GenerationJournalRecord,
  GenerationJournalTransaction,
} from './history-generation-journal.js';
export const generationDemandContract = 'pos-csv-coupon-generation-demands-v1';
export const generationDemandTable = mysqlTable(
  'pos_rewrite_coupon_generation_demands',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 16 }).notNull(),
    payload: longtext('payload').notNull(),
    proof: varchar('proof', { length: 64 }).notNull(),
    dueAt: bigint('due_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (t) => [index('ix_coupon_generation_demand_due').on(t.phase, t.dueAt, t.id)],
);
export const generationDemandDdl =
  'CREATE TABLE pos_rewrite_coupon_generation_demands (id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,version BIGINT UNSIGNED NOT NULL,phase VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,payload LONGTEXT NOT NULL,proof VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,due_at_ms BIGINT NOT NULL,updated_at_ms BIGINT NOT NULL,KEY ix_coupon_generation_demand_due(phase,due_at_ms,id)) ENGINE=InnoDB';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  phase = z.enum(['pending', 'preparing', 'prepared', 'failed']),
  point = z.number().int().positive().safe();
const recordSchema = z
  .object({
    id: hash,
    version: z.string().regex(/^[1-9][0-9]{0,19}$/),
    status: phase,
    scope: couponHistoryScopeSchema,
    witness: couponHistoryWitnessSchema,
    generationId: hash.nullable(),
    attempts: z.number().int().min(0).max(5),
    dueAt: point,
    updatedAt: point,
    failure: z
      .string()
      .regex(/^ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_[A-Z_]{1,80}$/)
      .nullable(),
  })
  .strict();
export type GenerationDemand = z.infer<typeof recordSchema>;
export interface GenerationDemandPort {
  enqueue(
    scope: CouponHistoryScope,
    options: { witness: CouponHistoryWitness; signal?: AbortSignal },
  ): Promise<{ id: string; status: GenerationDemand['status']; generationId: string | null }>;
}
/** Trusted validated-preview admission only. Pure construction; enqueue performs
 * one encrypted native queue transaction and no history/resource/warehouse work. */
export function couponGenerationDemands(
  db: Pick<Databases, 'get'>,
  authority: { journalKey: string; sourceKey: string },
  clock: () => number = Date.now,
) {
  couponWarehouseKeys(authority.journalKey, authority.sourceKey);
  const secret = createHmac('sha256', authority.journalKey)
    .update('coupon-generation:demand-encryption:v1')
    .digest();
  const body = (r: Pick<GenerationDemand, 'id' | 'version' | 'status'>) => ({
    id: r.id,
    version: r.version,
    status: r.status,
  });
  const aad = (r: Pick<GenerationDemand, 'id' | 'version' | 'status'>) =>
    Buffer.from(JSON.stringify(['coupon-generation-demand-v1', body(r)]));
  const identity = (scope: CouponHistoryScope, witness: CouponHistoryWitness) =>
    benefitDigest('coupon-generation-demand-identity', { scope, witness }, authority.journalKey);
  function encode(record: GenerationDemand) {
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > 16000) throw generationError('DEMAND');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(aad(record));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    // Auth tag is available only after final().
    const packed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
    return {
      payload: packed,
      proof: benefitDigest(
        'coupon-generation-demand',
        { ...body(record), payload: packed },
        authority.journalKey,
      ),
    };
  }
  function decode(row: typeof generationDemandTable.$inferSelect) {
    try {
      const scope = { id: row.id, version: row.version.toString(), status: phase.parse(row.phase) },
        expected = benefitDigest(
          'coupon-generation-demand',
          { ...scope, payload: row.payload },
          authority.journalKey,
        );
      if (
        !equalImportHash(expected, row.proof) ||
        row.payload.length > 22000 ||
        !/^[A-Za-z0-9_-]+$/.test(row.payload)
      )
        throw generationError('DEMAND');
      const bytes = Buffer.from(row.payload, 'base64url');
      if (bytes.length < 28 || bytes.length > 16028) throw generationError('DEMAND');
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAAD(aad(scope));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const result = recordSchema.parse(
        JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
        ) as unknown,
      );
      if (
        result.id !== identity(result.scope, result.witness) ||
        JSON.stringify(body(result)) !== JSON.stringify(scope) ||
        result.updatedAt !== row.updatedAt ||
        result.dueAt !== row.dueAt ||
        BigInt(result.version) > 18446744073709551615n
      )
        throw generationError('DEMAND');
      return result;
    } catch {
      throw generationError('DEMAND');
    }
  }
  async function load(tx: GenerationJournalTransaction, id: string) {
    if (!hash.safeParse(id).success) throw generationError('DEMAND');
    const [row] = await tx
      .select()
      .from(generationDemandTable)
      .where(eq(generationDemandTable.id, id))
      .for('update');
    if (!row) throw generationError('DEMAND_MISSING', 404);
    return decode(row);
  }
  async function save(tx: GenerationJournalTransaction, row: GenerationDemand) {
    const next = recordSchema.parse({
      ...row,
      version: (BigInt(row.version) + 1n).toString(),
      updatedAt: clock(),
    });
    if (BigInt(next.version) > 18446744073709551615n) throw generationError('DEMAND');
    const encoded = encode(next);
    await tx
      .update(generationDemandTable)
      .set({
        version: BigInt(next.version),
        phase: next.status,
        ...encoded,
        dueAt: next.dueAt,
        updatedAt: next.updatedAt,
      })
      .where(eq(generationDemandTable.id, next.id));
    return next;
  }
  return {
    async enqueue(
      input: CouponHistoryScope,
      options: { witness: CouponHistoryWitness; signal?: AbortSignal },
    ) {
      options.signal?.throwIfAborted();
      const scope = couponHistoryScopeSchema.parse(input),
        witness = couponHistoryWitnessSchema.parse(options.witness),
        now = clock(),
        generic = generationScopeFor(scope);
      let at: number;
      try {
        at = Temporal.PlainDateTime.from(scope.asOf.replace(' ', 'T')).toZonedDateTime(
          scope.sourceTimeZone,
          { disambiguation: 'reject' },
        ).epochMilliseconds;
      } catch {
        throw generationError('DEMAND');
      }
      if (
        at > now ||
        now - at >= 60000 ||
        Temporal.Instant.fromEpochMilliseconds(now)
          .toZonedDateTimeISO(scope.sourceTimeZone)
          .toPlainDate()
          .toString() !== generic.sourceDay
      )
        throw generationError('DEMAND');
      generationHeadHash(generic, witness, authority.sourceKey);
      const id = identity(scope, witness),
        record = recordSchema.parse({
          id,
          version: '1',
          status: 'pending',
          scope,
          witness,
          generationId: null,
          attempts: 0,
          dueAt: now,
          updatedAt: now,
          failure: null,
        }),
        encoded = encode(record);
      const result = await db.get('writer').transaction(async (tx) => {
        options.signal?.throwIfAborted();
        // Insert-ignore does not claim a missing PK range before concurrent enqueue.
        await tx
          .insert(generationDemandTable)
          .ignore()
          .values({ id, version: 1n, phase: 'pending', ...encoded, dueAt: now, updatedAt: now });
        const prior = await load(tx, id);
        options.signal?.throwIfAborted();
        return { id: prior.id, status: prior.status, generationId: prior.generationId };
      });
      options.signal?.throwIfAborted();
      return result;
    },
    async read(id: string) {
      return db.get('writer').transaction((tx) => load(tx, id));
    },
    async pending(limit = 10) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw generationError('DEMAND');
      const result: { id: string; dueAt: number }[] = [];
      for (const status of ['pending', 'preparing'] as const)
        result.push(
          ...(await db
            .get('writer')
            .select({ id: generationDemandTable.id, dueAt: generationDemandTable.dueAt })
            .from(generationDemandTable)
            .where(
              and(
                eq(generationDemandTable.phase, status),
                lte(generationDemandTable.dueAt, clock()),
              ),
            )
            .orderBy(asc(generationDemandTable.dueAt), asc(generationDemandTable.id))
            .limit(limit)),
        );
      return result
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((v) => v.id);
    },
    async claim(id: string) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (!['pending', 'preparing'].includes(row.status) || row.dueAt > clock()) return null;
        if (row.attempts >= 5) {
          await save(tx, {
            ...row,
            status: 'failed',
            failure: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_DEMAND_EXHAUSTED',
          });
          return null;
        }
        return save(tx, {
          ...row,
          status: 'preparing',
          attempts: row.attempts + 1,
          dueAt: clock() + 60000,
        });
      });
    },
    /** Called by journal.create in its OWN transaction. A crash commits both
     * bindings or neither, before any possible warehouse dispatch. */
    async bind(
      tx: GenerationJournalTransaction,
      claim: GenerationDemand,
      generation: GenerationJournalRecord,
    ) {
      const row = await load(tx, claim.id),
        generic = generationScopeFor(row.scope),
        capture = generation.snapshot.capture;
      if (
        row.status !== 'preparing' ||
        row.version !== claim.version ||
        row.dueAt <= clock() ||
        JSON.stringify(generic) !== JSON.stringify(capture.scope) ||
        capture.headHash !== generationHeadHash(generic, row.witness, authority.sourceKey)
      )
        throw generationError('DEMAND_SCOPE_CHANGED');
      await save(tx, { ...row, status: 'prepared', generationId: generation.id, dueAt: clock() });
    },
    async defer(
      claim: GenerationDemand,
      code = 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_DEMAND_UNAVAILABLE',
    ) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, claim.id);
        if (row.status !== 'preparing' || row.version !== claim.version) return row;
        return save(tx, {
          ...row,
          status: row.attempts >= 5 ? 'failed' : 'pending',
          failure: code,
          dueAt: clock() + 30000,
        });
      });
    },
  };
}
export type GenerationDemands = ReturnType<typeof couponGenerationDemands>;
