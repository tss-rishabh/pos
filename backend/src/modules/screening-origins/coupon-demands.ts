import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, lte } from 'drizzle-orm';
import { bigint, index, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../db/pools.js';
import { originDigest, originError, originHashSchema, sameOriginHash } from './contracts.js';
import { originHistoryKeys } from './history-contracts.js';
import {
  originCouponHistoryRequestSchema,
  type OriginCouponHistoryRequest,
} from './coupon-contracts.js';
import { generationScopeSchema } from '../legacy-order-imports/benefit-profile/history-generation-contracts.js';
import type {
  GenerationJournalRecord,
  GenerationJournalTransaction,
} from '../legacy-order-imports/benefit-profile/history-generation-journal.js';
export const originCouponDemandContract = 'pos-screening-origin-coupon-demands-v1';
export const originCouponDemandTable = mysqlTable(
  'pos_rewrite_origin_coupon_generation_demands',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 16 }).notNull(),
    payload: longtext('payload').notNull(),
    dueAt: bigint('due_at_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (t) => [index('ix_origin_coupon_demand_due').on(t.phase, t.dueAt, t.id)],
);
const point = z.number().int().positive().safe(),
  phase = z.enum(['pending', 'capturing', 'prepared', 'superseded']);
const recordSchema = z
  .object({
    id: originHashSchema,
    version: z.string().regex(/^[1-9][0-9]{0,19}$/),
    phase,
    request: originCouponHistoryRequestSchema,
    generationId: originHashSchema.nullable(),
    lease: z.uuid().nullable(),
    dueAt: point,
    updatedAt: point,
  })
  .strict();
export type OriginCouponDemand = z.infer<typeof recordSchema>;
function generic(request: OriginCouponHistoryRequest) {
  return generationScopeSchema.parse({
    customerId: request.command.customerId,
    couponId: request.selection.couponId,
    configurationHash: request.selection.configurationHash,
    sourceTimeZone: request.selection.sourceTimeZone,
    sourceDay: request.selection.asOf.slice(0, 10),
  });
}
/** Leaf encrypted queue. Reader construction/queue admission never invokes a
 * source capture, source order, warehouse publisher, SDK or env factory. */
export function originCouponDemandJournal(
  db: Pick<Databases, 'get'>,
  authority: { journalKey: string; originKey?: string },
  clock = Date.now,
) {
  originHistoryKeys(authority.journalKey, ...(authority.originKey ? [authority.originKey] : []));
  const secret = createHmac('sha256', authority.journalKey)
    .update('origin-coupon:demand-encryption:v1')
    .digest();
  const header = (
    value: Pick<OriginCouponDemand, 'id' | 'version' | 'phase' | 'dueAt' | 'updatedAt'>,
  ) =>
    Buffer.from(
      JSON.stringify([
        originCouponDemandContract,
        value.id,
        value.version,
        value.phase,
        value.dueAt,
        value.updatedAt,
      ]),
    );
  function encode(value: OriginCouponDemand) {
    const plain = Buffer.from(JSON.stringify(value));
    if (plain.length > 32000) throw originError('SCREENING_ORIGIN_COUPON_DEMAND_INVALID');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(header(value));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  function decode(row: typeof originCouponDemandTable.$inferSelect): OriginCouponDemand {
    try {
      const scope = {
        id: originHashSchema.parse(row.id),
        version: row.version.toString(),
        phase: phase.parse(row.phase),
        dueAt: point.parse(row.dueAt),
        updatedAt: point.parse(row.updatedAt),
      };
      if (row.payload.length > 43000 || !/^[A-Za-z0-9_-]+$/.test(row.payload)) throw originError();
      const bytes = Buffer.from(row.payload, 'base64url');
      if (bytes.length < 28 || bytes.length > 32028) throw originError();
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAAD(header(scope));
      cipher.setAuthTag(bytes.subarray(12, 28));
      const value = recordSchema.parse(
        JSON.parse(
          Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'),
        ) as unknown,
      );
      if (
        Object.entries(scope).some(
          ([name, raw]) => value[name as keyof OriginCouponDemand] !== raw,
        ) ||
        value.id !== identity(value.request)
      )
        throw originError();
      return value;
    } catch {
      throw originError('SCREENING_ORIGIN_COUPON_DEMAND_INVALID');
    }
  }
  const identity = (request: OriginCouponHistoryRequest) =>
    originDigest(authority.journalKey, 'coupon-demand', {
      scope: generic(request),
      witness: request.witness,
    });
  async function load(tx: GenerationJournalTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(originCouponDemandTable)
      .where(eq(originCouponDemandTable.id, originHashSchema.parse(id)))
      .limit(1)
      .for('update');
    if (!row) throw originError('SCREENING_ORIGIN_COUPON_DEMAND_MISSING');
    return decode(row);
  }
  async function save(tx: GenerationJournalTransaction, value: OriginCouponDemand) {
    const next = { ...value, version: String(BigInt(value.version) + 1n), updatedAt: clock() };
    if (BigInt(next.version) > 18446744073709551615n)
      throw originError('SCREENING_ORIGIN_COUPON_DEMAND_OVERFLOW');
    await tx
      .update(originCouponDemandTable)
      .set({
        version: BigInt(next.version),
        phase: next.phase,
        payload: encode(next),
        dueAt: next.dueAt,
        updatedAt: next.updatedAt,
      })
      .where(eq(originCouponDemandTable.id, next.id));
    return next;
  }
  return {
    async enqueue(input: OriginCouponHistoryRequest, signal: AbortSignal) {
      signal.throwIfAborted();
      const request = originCouponHistoryRequestSchema.parse(input),
        key = authority.originKey,
        now = clock();
      if (
        !key ||
        request.command.phase !== 'PREPARED' ||
        request.command.orderId !== null ||
        request.expiresAt <= now ||
        request.issuedAt > now ||
        request.expiresAt > Math.min(request.command.expiresAt, request.issuedAt + 30000) ||
        !sameOriginHash(request.commandProof, originDigest(key, 'command', request.command))
      )
        throw originError('SCREENING_ORIGIN_COUPON_DEMAND_UNAUTHORIZED');
      const value: OriginCouponDemand = {
        id: identity(request),
        version: '1',
        phase: 'pending',
        request,
        generationId: null,
        lease: null,
        dueAt: now,
        updatedAt: now,
      };
      await db.get('writer').transaction(async (tx) => {
        await tx
          .insert(originCouponDemandTable)
          .values({
            id: value.id,
            version: 1n,
            phase: value.phase,
            payload: encode(value),
            dueAt: now,
            updatedAt: now,
          })
          .onDuplicateKeyUpdate({ set: { id: value.id } });
        await load(tx, value.id);
      });
      signal.throwIfAborted();
    },
    read: (id: string) => db.get('writer').transaction((tx) => load(tx, id)),
    async due(limit = 2) {
      z.number().int().min(1).max(10).parse(limit);
      const ids: { id: string; dueAt: number }[] = [];
      for (const selected of ['pending', 'capturing'] as const)
        ids.push(
          ...(await db
            .get('writer')
            .select({ id: originCouponDemandTable.id, dueAt: originCouponDemandTable.dueAt })
            .from(originCouponDemandTable)
            .where(
              and(
                eq(originCouponDemandTable.phase, selected),
                lte(originCouponDemandTable.dueAt, clock()),
              ),
            )
            .orderBy(asc(originCouponDemandTable.dueAt), asc(originCouponDemandTable.id))
            .limit(limit)),
        );
      return ids
        .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((row) => row.id);
    },
    claim: (id: string) =>
      db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (!['pending', 'capturing'].includes(row.phase) || row.dueAt > clock()) return null;
        return save(tx, {
          ...row,
          phase: 'capturing',
          lease: randomUUID(),
          dueAt: clock() + 120000,
        });
      }),
    /** Passed to publisher.prepare; its native journal/create and this bind share
     * one transaction. A losing/expired readonly capture publishes no job. */
    async bind(
      tx: GenerationJournalTransaction,
      id: string,
      lease: string,
      record: GenerationJournalRecord,
    ) {
      const row = await load(tx, id),
        capture = record.snapshot.capture;
      if (row.phase !== 'capturing' || row.lease !== lease || row.dueAt <= clock())
        throw originError('SCREENING_ORIGIN_COUPON_DEMAND_LEASE_LOST');
      if (
        JSON.stringify(capture.scope) !== JSON.stringify(generic(row.request)) ||
        capture.serverUuid !== row.request.witness.serverUuid ||
        capture.sourceSchema !== row.request.witness.sourceSchema ||
        capture.writersDefinitionHash !== row.request.witness.writersDefinitionHash ||
        JSON.stringify(capture.heads) !== JSON.stringify(row.request.witness.heads)
      )
        throw originError('SCREENING_ORIGIN_COUPON_GENERATION_SUPERSEDED');
      await save(tx, { ...row, phase: 'prepared', generationId: record.id, lease: null });
    },
    reschedule: (id: string, lease: string, superseded = false) =>
      db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (row.phase !== 'capturing' || row.lease !== lease) return row;
        return save(tx, {
          ...row,
          phase: superseded ? 'superseded' : 'pending',
          lease: null,
          dueAt: clock() + 30000,
        });
      }),
  };
}
export const originCouponGenericScope = generic;
