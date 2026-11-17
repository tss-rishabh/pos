import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, or } from 'drizzle-orm';
import { mysqlTable, varchar, bigint, longtext, index } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { benefitDigest } from './crypto.js';
import { equalImportHash } from '../financial-adapter-primitives.js';
import {
  couponWarehouseControlRowSchema,
  couponWarehouseKeys,
} from './history-warehouse-contracts.js';
import { generationRowSchema } from './history-generation-projections.js';
import {
  generationCaptureSchema,
  generationPublicationSchema,
  verifyGenerationCapture,
  generationError,
} from './history-generation-contracts.js';
import { generationOptionsSchema, type GenerationOptions } from './history-generation-options.js';
import {
  generationWriteReplySchema,
  restoreGenerationWritePlan,
  type GenerationWritePlan,
  type GenerationWriteReply,
} from './history-generation-writer.js';
import type { GenerationSourceSnapshot } from './history-generation-source.js';
export const generationJournalTable = mysqlTable(
  'pos_rewrite_coupon_generation_journal',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 24 }).notNull(),
    payload: longtext('payload').notNull(),
    proof: varchar('proof', { length: 64 }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (t) => [index('ix_coupon_generation_pending').on(t.phase, t.updatedAt, t.id)],
);
export const generationJournalDdl =
  'CREATE TABLE pos_rewrite_coupon_generation_journal (id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,version BIGINT UNSIGNED NOT NULL,phase VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,payload LONGTEXT NOT NULL,proof VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,updated_at_ms BIGINT NOT NULL,KEY ix_coupon_generation_pending(phase,updated_at_ms,id)) ENGINE=InnoDB';
const phaseSchema = z.enum([
  'prepared',
  'materializing',
  'materialized',
  'qualified',
  'publishing',
  'published',
  'failed',
]);
const planSchema = z
  .object({
    kind: z.enum(['materialize', 'publish']),
    jobId: z.string().max(128),
    statement: z.string().max(20000),
    preflight: z.string().max(20000),
    params: z.record(z.string(), z.union([z.string().max(9000000), z.number().int().safe()])),
    types: z.record(z.string(), z.string().max(20)),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    authHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const recordSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().regex(/^[1-9][0-9]{0,19}$/),
    phase: phaseSchema,
    snapshot: z
      .object({
        capture: generationCaptureSchema,
        controls: z.array(couponWarehouseControlRowSchema).max(10000),
        logs: z.array(generationRowSchema).max(50000),
      })
      .strict(),
    options: generationOptionsSchema,
    materialize: planSchema,
    publication: generationPublicationSchema.nullable(),
    publish: planSchema.nullable(),
    materializeReply: generationWriteReplySchema.nullable(),
    publishReply: generationWriteReplySchema.nullable(),
    failure: z
      .string()
      .regex(/^ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_[A-Z_]{1,80}$/)
      .nullable(),
    updatedAt: z.number().int().positive().safe(),
  })
  .strict();
export type GenerationJournalRecord = z.infer<typeof recordSchema>;
type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];
/** Own durable intent, encrypted native export and exact original job IDs.
 * Existing outcomes remain readable independently of new-work selection. */
export function generationJournal(
  db: Pick<Databases, 'get'>,
  authority: { journalKey: string; sourceKey: string },
  clock: () => number = Date.now,
) {
  couponWarehouseKeys(authority.journalKey, authority.sourceKey);
  const secret = createHmac('sha256', authority.journalKey)
    .update('coupon-generation:journal-encryption:v1')
    .digest();
  function aad(record: Pick<GenerationJournalRecord, 'id' | 'version' | 'phase'>) {
    return Buffer.from(
      JSON.stringify(['coupon-generation-journal-v1', record.id, record.version, record.phase]),
    );
  }
  function encode(record: GenerationJournalRecord) {
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > 26000000) throw generationError('SOURCE_BYTES');
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(aad(record));
    const out = Buffer.concat([cipher.update(bytes), cipher.final()]),
      payload = Buffer.concat([nonce, cipher.getAuthTag(), out]).toString('base64url');
    const proof = benefitDigest(
      'coupon-generation-journal',
      {
        id: record.id,
        version: record.version,
        phase: record.phase,
        payloadHash: createHash('sha256').update(payload).digest('hex'),
      },
      authority.journalKey,
    );
    return { payload, proof };
  }
  function decode(row: typeof generationJournalTable.$inferSelect) {
    try {
      const scope = {
          id: row.id,
          version: row.version.toString(),
          phase: phaseSchema.parse(row.phase),
        },
        proof = benefitDigest(
          'coupon-generation-journal',
          { ...scope, payloadHash: createHash('sha256').update(row.payload).digest('hex') },
          authority.journalKey,
        );
      if (
        !equalImportHash(row.proof, proof) ||
        row.payload.length > 35000000 ||
        !/^[A-Za-z0-9_-]+$/.test(row.payload)
      )
        throw generationError('JOURNAL');
      const packed = Buffer.from(row.payload, 'base64url');
      if (packed.length < 28 || packed.length > 26000028) throw generationError('JOURNAL');
      const cipher = createDecipheriv('aes-256-gcm', secret, packed.subarray(0, 12));
      cipher.setAAD(aad(scope));
      cipher.setAuthTag(packed.subarray(12, 28));
      const bytes = Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]),
        value = recordSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (
        value.id !== row.id ||
        value.version !== scope.version ||
        value.phase !== row.phase ||
        value.updatedAt !== row.updatedAt ||
        value.snapshot.capture.generationId !== row.id ||
        value.materialize.jobId !== 'pos_coupon_gen_materialize_' + row.id ||
        (value.publish && value.publish.jobId !== 'pos_coupon_gen_publish_' + row.id)
      )
        throw generationError('JOURNAL');
      return value;
    } catch {
      throw generationError('JOURNAL');
    }
  }
  async function load(tx: Transaction, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw generationError('JOURNAL');
    const [row] = await tx
      .select()
      .from(generationJournalTable)
      .where(eq(generationJournalTable.id, id))
      .for('update');
    if (!row) throw generationError('JOURNAL_MISSING', 404);
    return decode(row);
  }
  async function save(tx: Transaction, record: GenerationJournalRecord) {
    const next = recordSchema.parse({
      ...record,
      version: (BigInt(record.version) + 1n).toString(),
      updatedAt: clock(),
    });
    if (BigInt(next.version) > 18446744073709551615n) throw generationError('JOURNAL');
    const encoded = encode(next);
    await tx
      .update(generationJournalTable)
      .set({
        version: BigInt(next.version),
        phase: next.phase,
        ...encoded,
        updatedAt: next.updatedAt,
      })
      .where(eq(generationJournalTable.id, next.id));
    return next;
  }
  return {
    async create(
      snapshot: GenerationSourceSnapshot,
      options: GenerationOptions,
      materialize: GenerationWritePlan,
    ) {
      verifyGenerationCapture(snapshot.capture, authority.sourceKey, clock());
      restoreGenerationWritePlan(materialize, authority.sourceKey);
      const record = recordSchema.parse({
          id: snapshot.capture.generationId,
          version: '1',
          phase: 'prepared',
          snapshot,
          options,
          materialize,
          publication: null,
          publish: null,
          materializeReply: null,
          publishReply: null,
          failure: null,
          updatedAt: clock(),
        }),
        encoded = encode(record);
      await db
        .get('writer')
        .insert(generationJournalTable)
        .values({
          id: record.id,
          version: 1n,
          phase: record.phase,
          ...encoded,
          updatedAt: record.updatedAt,
        });
      return record;
    },
    async read(id: string) {
      return db.get('writer').transaction((tx) => load(tx, id));
    },
    async pending(limit = 10, after?: { updatedAt: number; id: string }) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw generationError('JOURNAL');
      if (
        after &&
        (!Number.isSafeInteger(after.updatedAt) ||
          after.updatedAt <= 0 ||
          !/^[a-f0-9]{64}$/.test(after.id))
      )
        throw generationError('JOURNAL');
      // Each branch uses the phase/updated/id index. No scan of completed history.
      const rows: { id: string; updatedAt: number }[] = [];
      for (const phase of [
        'prepared',
        'materializing',
        'materialized',
        'qualified',
        'publishing',
      ] as const) {
        rows.push(
          ...(await db
            .get('writer')
            .select({ id: generationJournalTable.id, updatedAt: generationJournalTable.updatedAt })
            .from(generationJournalTable)
            .where(
              and(
                eq(generationJournalTable.phase, phase),
                after
                  ? or(
                      gt(generationJournalTable.updatedAt, after.updatedAt),
                      and(
                        eq(generationJournalTable.updatedAt, after.updatedAt),
                        gt(generationJournalTable.id, after.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(generationJournalTable.updatedAt), asc(generationJournalTable.id))
            .limit(limit)),
        );
      }
      const selected = rows
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .slice(0, limit);
      return { ids: selected.map((v) => v.id), next: selected.at(-1) ?? null };
    },
    async claim(id: string, kind: 'materialize' | 'publish') {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id),
          expected = kind === 'materialize' ? 'prepared' : 'qualified';
        if (row.phase !== expected) return { send: false as const, record: row };
        verifyGenerationCapture(row.snapshot.capture, authority.sourceKey, clock());
        const next = await save(tx, {
          ...row,
          phase: kind === 'materialize' ? 'materializing' : 'publishing',
        });
        return { send: true as const, record: next };
      });
    },
    async acknowledge(id: string, kind: 'materialize' | 'publish', supplied: GenerationWriteReply) {
      const reply = generationWriteReplySchema.parse(supplied);
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id),
          plan = kind === 'materialize' ? row.materialize : row.publish;
        if (!plan || reply.jobId !== plan.jobId || reply.queryHash !== plan.hash)
          throw generationError('JOURNAL');
        const key = kind === 'materialize' ? 'materializeReply' : 'publishReply',
          prior = row[key];
        if (prior?.evidenceHash === reply.evidenceHash) return row;
        if (prior?.status === 'succeeded' || prior?.status === 'failed') {
          if (reply.status === 'pending' || reply.status === 'unknown') return row;
          throw generationError('JOURNAL');
        }
        if (row.phase !== (kind === 'materialize' ? 'materializing' : 'publishing'))
          throw generationError('JOURNAL');
        let phase: GenerationJournalRecord['phase'] = row.phase;
        if (reply.status === 'failed') phase = 'failed';
        else if (reply.status === 'succeeded' && kind === 'materialize') phase = 'materialized';
        return save(tx, {
          ...row,
          [key]: reply,
          phase,
          failure:
            reply.status === 'failed'
              ? 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_WRITE_FAILED'
              : row.failure,
        });
      });
    },
    async qualified(
      id: string,
      publication: GenerationJournalRecord['publication'],
      publish: GenerationWritePlan,
    ) {
      restoreGenerationWritePlan(publish, authority.sourceKey);
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (row.phase === 'qualified' && row.publish?.hash === publish.hash) return row;
        if (
          row.phase !== 'materialized' ||
          publication?.captureHash !== row.snapshot.capture.signature ||
          publish.kind !== 'publish'
        )
          throw generationError('JOURNAL');
        return save(tx, { ...row, phase: 'qualified', publication, publish });
      });
    },
    async completed(id: string, captureHash: string, publicationSeal: string) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (row.phase === 'published') return row;
        if (
          row.phase !== 'publishing' ||
          row.publishReply?.status !== 'succeeded' ||
          row.snapshot.capture.signature !== captureHash ||
          row.publication?.seal !== publicationSeal
        )
          throw generationError('JOURNAL');
        return save(tx, { ...row, phase: 'published' });
      });
    },
    async refuse(id: string, code: string) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (!['prepared', 'materialized'].includes(row.phase)) return row;
        return save(tx, { ...row, phase: 'failed', failure: code });
      });
    },
  };
}
export type GenerationJournal = ReturnType<typeof generationJournal>;
