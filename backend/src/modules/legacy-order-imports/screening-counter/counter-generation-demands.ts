import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { bigint, index, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { counterCount, counterCustomer, counterError, counterHash } from './contracts.js';
import {
  counterGenerationDigest,
  type CounterGenerationRecord,
} from './counter-generation-contracts.js';
import type { CounterGenerationTransaction as Tx } from './counter-generation-journal.js';
export const counterGenerationDemandsTable = mysqlTable(
  'pos_rewrite_screening_counter_generation_demands',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 20 }).notNull(),
    lane: varchar('lane', { length: 12 }).notNull(),
    payload: longtext('payload').notNull(),
    dueAt: bigint('due_at_ms', { mode: 'number' }).notNull(),
    createdAt: bigint('created_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('ix_screening_counter_demand_due').on(t.phase, t.dueAt, t.createdAt),
    index('ix_screening_counter_demand_new').on(t.lane, t.createdAt),
  ],
);
export const counterGenerationCursorsTable = mysqlTable(
  'pos_rewrite_screening_counter_generation_cursors',
  {
    lane: varchar('lane', { length: 12 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    payload: longtext('payload').notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
);
const laneSchema = z.enum(['new', 'backfill']),
  phase = z.enum(['pending', 'capturing', 'prepared', 'satisfied', 'superseded']),
  point = z.number().int().positive().safe();
export const counterGenerationDemandRequestSchema = z
  .object({
    customerId: counterCustomer,
    headRevision: counterCount,
    expectedGeneration: counterHash.nullable(),
  })
  .strict();
export type CounterGenerationDemandRequest = z.infer<typeof counterGenerationDemandRequestSchema>;
const demandSchema = z
  .object({
    id: counterHash,
    version: z.string().regex(/^[1-9][0-9]{0,19}$/),
    phase,
    lane: laneSchema,
    request: counterGenerationDemandRequestSchema,
    generationId: counterHash.nullable(),
    lease: z.uuid().nullable(),
    attempts: z.number().int().min(0).max(1000000),
    dueAt: point,
    createdAt: point,
    updatedAt: point,
  })
  .strict();
export type CounterGenerationDemand = z.infer<typeof demandSchema>;
const cursorSchema = z
  .object({
    lane: z.enum(['new', 'backfill', 'schedule']),
    version: z.string().regex(/^[1-9][0-9]{0,19}$/),
    after: counterCount,
    initialized: z.boolean(),
    dueAt: point,
    updatedAt: point,
  })
  .strict();
export type CounterGenerationCursor = z.infer<typeof cursorSchema>;
export function counterGenerationDemands(
  db: Pick<Databases, 'get'>,
  journalKey: string,
  clock = Date.now,
) {
  const secret = Buffer.from(counterGenerationDigest(journalKey, 'demand-encryption', null), 'hex');
  const identity = (request: CounterGenerationDemandRequest) =>
    counterGenerationDigest(journalKey, 'demand', request);
  function encrypt(value: unknown, aad: unknown) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(aad)));
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 16000) throw counterError('GENERATION_DEMAND_INVALID');
    return Buffer.concat([
      nonce,
      cipher.getAuthTag(),
      cipher.update(bytes),
      cipher.final(),
    ]).toString('base64url');
  }
  function decrypt(payload: string, aad: unknown): unknown {
    try {
      if (payload.length > 22000 || !/^[A-Za-z0-9_-]+$/.test(payload))
        throw counterError('GENERATION_DEMAND_INVALID');
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.length < 28) throw counterError('GENERATION_DEMAND_INVALID');
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(JSON.stringify(aad)));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
      ) as unknown;
    } catch {
      throw counterError('GENERATION_DEMAND_INVALID');
    }
  }
  const demandHeader = (
    r: Pick<
      CounterGenerationDemand,
      'id' | 'version' | 'phase' | 'lane' | 'dueAt' | 'createdAt' | 'updatedAt'
    >,
  ) => [r.id, r.version, r.phase, r.lane, r.dueAt, r.createdAt, r.updatedAt];
  function demandRow(row: typeof counterGenerationDemandsTable.$inferSelect) {
    const h = {
        id: counterHash.parse(row.id),
        version: String(row.version),
        phase: phase.parse(row.phase),
        lane: laneSchema.parse(row.lane),
        dueAt: point.parse(row.dueAt),
        createdAt: point.parse(row.createdAt),
        updatedAt: point.parse(row.updatedAt),
      },
      r = demandSchema.parse(decrypt(row.payload, demandHeader(h)));
    if (
      JSON.stringify(demandHeader(r)) !== JSON.stringify(demandHeader(h)) ||
      r.id !== identity(r.request)
    )
      throw counterError('GENERATION_DEMAND_INVALID');
    return r;
  }
  const cursorHeader = (r: Pick<CounterGenerationCursor, 'lane' | 'version' | 'updatedAt'>) => [
    'cursor',
    r.lane,
    r.version,
    r.updatedAt,
  ];
  function cursorRow(row: typeof counterGenerationCursorsTable.$inferSelect) {
    const h = {
        lane: cursorSchema.shape.lane.parse(row.lane),
        version: String(row.version),
        updatedAt: point.parse(row.updatedAt),
      },
      r = cursorSchema.parse(decrypt(row.payload, cursorHeader(h)));
    if (r.lane !== row.lane || r.version !== String(row.version) || r.updatedAt !== row.updatedAt)
      throw counterError('GENERATION_DEMAND_INVALID');
    return r;
  }
  async function load(tx: Tx, id: string) {
    const [row] = await tx
      .select()
      .from(counterGenerationDemandsTable)
      .where(eq(counterGenerationDemandsTable.id, counterHash.parse(id)))
      .limit(1)
      .for('update');
    if (!row) throw counterError('GENERATION_DEMAND_MISSING');
    return demandRow(row);
  }
  function nextVersion(version: string) {
    const next = BigInt(version) + 1n;
    if (next > 18446744073709551615n) throw counterError('GENERATION_DEMAND_INVALID');
    return String(next);
  }
  async function save(tx: Tx, value: CounterGenerationDemand) {
    const r = demandSchema.parse({
      ...value,
      version: nextVersion(value.version),
      updatedAt: clock(),
    });
    await tx
      .update(counterGenerationDemandsTable)
      .set({
        version: BigInt(r.version),
        phase: r.phase,
        lane: r.lane,
        payload: encrypt(r, demandHeader(r)),
        dueAt: r.dueAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })
      .where(eq(counterGenerationDemandsTable.id, r.id));
    return r;
  }
  async function admit(
    tx: Tx,
    input: CounterGenerationDemandRequest,
    lane: CounterGenerationDemand['lane'],
  ) {
    const request = counterGenerationDemandRequestSchema.parse(input),
      now = clock(),
      r: CounterGenerationDemand = {
        id: identity(request),
        version: '1',
        phase: 'pending',
        lane,
        request,
        generationId: null,
        lease: null,
        attempts: 0,
        dueAt: now,
        createdAt: now,
        updatedAt: now,
      };
    await tx
      .insert(counterGenerationDemandsTable)
      .values({
        id: r.id,
        version: 1n,
        phase: r.phase,
        lane,
        payload: encrypt(r, demandHeader(r)),
        dueAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { id: r.id } });
    const prior = await load(tx, r.id);
    if (['satisfied', 'superseded'].includes(prior.phase))
      return save(tx, {
        ...prior,
        phase: 'pending',
        lane,
        lease: null,
        generationId: null,
        dueAt: now,
      });
    if (lane === 'new' && prior.lane !== 'new') return save(tx, { ...prior, lane });
    return prior;
  }
  async function cursor(tx: Tx, lane: CounterGenerationCursor['lane']) {
    const now = clock(),
      value: CounterGenerationCursor = {
        lane,
        version: '1',
        after: '0',
        initialized: false,
        dueAt: now,
        updatedAt: now,
      };
    await tx
      .insert(counterGenerationCursorsTable)
      .values({ lane, version: 1n, payload: encrypt(value, cursorHeader(value)), updatedAt: now })
      .onDuplicateKeyUpdate({ set: { lane } });
    const [row] = await tx
      .select()
      .from(counterGenerationCursorsTable)
      .where(eq(counterGenerationCursorsTable.lane, lane))
      .limit(1)
      .for('update');
    if (!row) throw counterError('GENERATION_CURSOR_INVALID');
    return cursorRow(row);
  }
  return {
    cursor: (lane: 'new' | 'backfill') => db.get('writer').transaction((tx) => cursor(tx, lane)),
    async admitPage(
      observed: CounterGenerationCursor,
      requests: CounterGenerationDemandRequest[],
      after: string,
      intervalMs: number,
    ) {
      if (observed.lane === 'schedule') throw counterError('GENERATION_CURSOR_INVALID');
      const lane = observed.lane;
      counterCount.parse(after);
      if (
        requests.length > 100 ||
        !Number.isSafeInteger(intervalMs) ||
        intervalMs < 1000 ||
        intervalMs > 60000
      )
        throw counterError('GENERATION_CURSOR_INVALID');
      return db.get('writer').transaction(async (tx) => {
        const current = await cursor(tx, lane);
        if (current.version !== observed.version) return false;
        for (const request of requests) await admit(tx, request, lane);
        const next = cursorSchema.parse({
          ...current,
          version: nextVersion(current.version),
          after,
          initialized: true,
          dueAt: clock() + intervalMs,
          updatedAt: clock(),
        });
        await tx
          .update(counterGenerationCursorsTable)
          .set({
            version: BigInt(next.version),
            payload: encrypt(next, cursorHeader(next)),
            updatedAt: next.updatedAt,
          })
          .where(eq(counterGenerationCursorsTable.lane, next.lane));
        return true;
      });
    },
    async due(limit = 2) {
      if (!Number.isSafeInteger(limit) || limit < 2 || limit > 10)
        throw counterError('GENERATION_CONFIGURATION');
      const eligible = and(
        inArray(counterGenerationDemandsTable.phase, ['pending', 'capturing', 'prepared']),
        lte(counterGenerationDemandsTable.dueAt, clock()),
      );
      const newest = await db
        .get('writer')
        .select({ id: counterGenerationDemandsTable.id })
        .from(counterGenerationDemandsTable)
        .where(and(eligible, eq(counterGenerationDemandsTable.lane, 'new')))
        .orderBy(
          desc(counterGenerationDemandsTable.createdAt),
          asc(counterGenerationDemandsTable.id),
        )
        .limit(Math.floor(limit / 2));
      const turn = await db.get('writer').transaction(async (tx) => {
        const value = await cursor(tx, 'schedule'),
          tick = Number(BigInt(value.after) % 3n),
          next = cursorSchema.parse({
            ...value,
            version: nextVersion(value.version),
            after: String((BigInt(value.after) + 1n) % 3n),
            initialized: true,
            updatedAt: clock(),
            dueAt: clock(),
          });
        await tx
          .update(counterGenerationCursorsTable)
          .set({
            version: BigInt(next.version),
            payload: encrypt(next, cursorHeader(next)),
            updatedAt: next.updatedAt,
          })
          .where(eq(counterGenerationCursorsTable.lane, 'schedule'));
        return tick;
      });
      const fairFilter =
        turn === 0
          ? or(
              inArray(counterGenerationDemandsTable.phase, ['capturing', 'prepared']),
              sql`${counterGenerationDemandsTable.updatedAt}>${counterGenerationDemandsTable.createdAt}`,
            )
          : eq(counterGenerationDemandsTable.lane, turn === 1 ? 'new' : 'backfill');
      const fair = await db
        .get('writer')
        .select({ id: counterGenerationDemandsTable.id })
        .from(counterGenerationDemandsTable)
        .where(and(eligible, fairFilter))
        .orderBy(
          asc(counterGenerationDemandsTable.dueAt),
          asc(counterGenerationDemandsTable.updatedAt),
          asc(counterGenerationDemandsTable.id),
        )
        .limit(limit);
      const oldest = await db
        .get('writer')
        .select({ id: counterGenerationDemandsTable.id })
        .from(counterGenerationDemandsTable)
        .where(eligible)
        .orderBy(
          asc(counterGenerationDemandsTable.dueAt),
          asc(counterGenerationDemandsTable.updatedAt),
          asc(counterGenerationDemandsTable.id),
        )
        .limit(limit);
      return [...new Set([...newest, ...fair, ...oldest].map((row) => row.id))].slice(0, limit);
    },
    read: (id: string) => db.get('writer').transaction((tx) => load(tx, id)),
    claim: (id: string) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (!['pending', 'capturing'].includes(r.phase) || r.dueAt > clock()) return null;
        return save(tx, {
          ...r,
          phase: 'capturing',
          lease: randomUUID(),
          dueAt: clock() + 120000,
          attempts: Math.min(1000000, r.attempts + 1),
        });
      }),
    async bind(tx: Tx, id: string, lease: string, job: CounterGenerationRecord) {
      const r = await load(tx, id);
      if (r.phase !== 'capturing' || r.lease !== lease || r.dueAt <= clock())
        throw counterError('GENERATION_DEMAND_LEASE_LOST');
      if (
        job.snapshot.capture.scope.customerId !== r.request.customerId ||
        job.snapshot.capture.headRevision !== r.request.headRevision ||
        job.expectedGeneration !== r.request.expectedGeneration
      )
        throw counterError('GENERATION_DISCOVERY_HEAD_CHANGED');
      await save(tx, {
        ...r,
        phase: 'prepared',
        generationId: job.id,
        lease: null,
        dueAt: clock(),
      });
    },
    replace: (id: string, lease: string, request: CounterGenerationDemandRequest) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (r.phase !== 'capturing' || r.lease !== lease) return;
        await admit(tx, request, r.lane);
        await save(tx, { ...r, phase: 'superseded', lease: null });
      }),
    satisfied: (id: string, lease?: string) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (lease && r.lease !== lease) return r;
        return save(tx, { ...r, phase: 'satisfied', lease: null });
      }),
    retry: (id: string, lease: string) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (r.phase !== 'capturing' || r.lease !== lease) return r;
        return save(tx, {
          ...r,
          phase: 'pending',
          lease: null,
          dueAt: clock() + Math.min(60000, 5000 * Math.max(1, r.attempts)),
        });
      }),
    poll: (id: string, failed = false) =>
      db.get('writer').transaction(async (tx) => {
        const r = await load(tx, id);
        if (r.phase !== 'prepared') return r;
        return save(tx, {
          ...r,
          phase: failed ? 'pending' : 'prepared',
          generationId: failed ? null : r.generationId,
          dueAt: clock() + (failed ? Math.min(60000, 5000 * Math.max(1, r.attempts)) : 5000),
        });
      }),
  };
}
