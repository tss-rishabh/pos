import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { bigint, index, longtext, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { Databases } from '../../../db/pools.js';
import { identifier } from '../../../domain/validation.js';
import { csvMembershipSourceInstant } from '../../legacy-order-imports/membership-profile/bigquery.js';
import {
  assertMembershipHistoryKeys,
  membershipGenerationSchema,
  membershipGenerationPublicationSchema,
  membershipHistoryDigest,
  publicMembershipHeadSchema,
  publicMembershipHistoryError,
  publicMembershipHistoryRequestSchema,
  type PublicMembershipHistoryRequest,
  membershipExecution,
  membershipExecutionSchema,
  type MembershipExecution,
  type PublicMembershipHead,
  type MembershipGeneration,
} from './membership-history.js';
import {
  publishMembershipGeneration,
  type MembershipWarehouseGenerationPort,
} from './membership-history-publication.js';

export const membershipGenerationPublisherContract =
  'pos-public-membership-generation-publisher-v1';
export const membershipGenerationDemandContract = 'pos-public-membership-generation-demand-v1';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z
  .object({
    customerId: identifier,
    configurationHash: hash,
    sourceTimeZone: z.string().min(1).max(128),
    head: publicMembershipHeadSchema,
  })
  .strict();
const phaseSchema = z.enum([
  'queued',
  'capturing',
  'qualified',
  'publishing',
  'published',
  'failed',
]);
const artifactSchema = z
  .object({
    sourceCapture: membershipGenerationSchema,
    publication: membershipGenerationPublicationSchema,
    warehouseSelection: membershipGenerationSchema.shape.selection,
    publicationTable: z
      .string()
      .regex(/^tssgcp2025\.tss_mysql_raw_layer\.[A-Za-z_][A-Za-z0-9_]{0,1023}$/),
  })
  .strict();
export type MembershipGenerationArtifact = z.infer<typeof artifactSchema>;
const recordSchema = z
  .object({
    contract: z.literal(membershipGenerationPublisherContract),
    id: hash,
    version: z.string().regex(/^[1-9]\d{0,19}$/),
    phase: phaseSchema,
    scope: scopeSchema,
    bucket: z.number().int().positive().safe(),
    owner: z.uuid().nullable(),
    leaseUntil: z.number().int().nonnegative().safe(),
    artifact: artifactSchema.nullable(),
    writeHash: hash.nullable(),
    createdAt: z.number().int().positive().safe(),
    updatedAt: z.number().int().positive().safe(),
  })
  .strict();
export type MembershipGenerationRecord = z.infer<typeof recordSchema>;
export interface PublicMembershipGenerationDemands {
  request(
    request: PublicMembershipHistoryRequest,
    head: PublicMembershipHead,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
export const membershipGenerationJobs = mysqlTable(
  'pos_rewrite_public_membership_generations',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    version: bigint('version', { mode: 'bigint', unsigned: true }).notNull(),
    phase: varchar('phase', { length: 16 }).notNull(),
    payload: longtext('payload').notNull(),
    proof: varchar('proof', { length: 64 }).notNull(),
    leaseUntil: bigint('lease_until_ms', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('ix_public_member_generation_pending').on(
      table.phase,
      table.leaseUntil,
      table.updatedAt,
      table.id,
    ),
  ],
);
type Transaction = Parameters<Parameters<ReturnType<Databases['get']>['transaction']>[0]>[0];

/** Durable publication intent only. Customer identity and source primitives are
 * encrypted. A generic demand has no checkout/order nonce or financial power. */
export function publicMembershipGenerationJournal(
  db: Pick<Databases, 'get'>,
  journalKey: string,
  clock: () => number = Date.now,
) {
  assertMembershipHistoryKeys(journalKey);
  const key = createHmac('sha256', journalKey)
    .update('public-membership-generation:encryption:v1')
    .digest();
  const aad = (row: Pick<MembershipGenerationRecord, 'id' | 'phase' | 'version'>) =>
    Buffer.from(
      JSON.stringify([membershipGenerationPublisherContract, row.id, row.version, row.phase]),
    );
  function encode(value: MembershipGenerationRecord) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 3000000) throw publicMembershipHistoryError();
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(value));
    // getAuthTag is available only after final(). Keep packing explicit.
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const packed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
    return {
      payload: packed,
      proof: membershipHistoryDigest(
        'generation-journal',
        {
          id: value.id,
          phase: value.phase,
          version: value.version,
          payloadHash: createHash('sha256').update(packed).digest('hex'),
        },
        journalKey,
      ),
    };
  }
  function decode(row: typeof membershipGenerationJobs.$inferSelect) {
    try {
      const scope = {
        id: row.id,
        phase: phaseSchema.parse(row.phase),
        version: String(row.version),
      };
      if (
        row.payload.length > 4100000 ||
        !/^[A-Za-z0-9_-]+$/.test(row.payload) ||
        row.proof !==
          membershipHistoryDigest(
            'generation-journal',
            { ...scope, payloadHash: createHash('sha256').update(row.payload).digest('hex') },
            journalKey,
          )
      )
        throw publicMembershipHistoryError();
      const packed = Buffer.from(row.payload, 'base64url');
      if (packed.length < 28 || packed.length > 3000028) throw publicMembershipHistoryError();
      const cipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
      cipher.setAAD(aad(scope));
      cipher.setAuthTag(packed.subarray(12, 28));
      const bytes = Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]);
      const value = recordSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (
        value.id !== row.id ||
        value.version !== scope.version ||
        value.phase !== row.phase ||
        value.leaseUntil !== row.leaseUntil ||
        value.updatedAt !== row.updatedAt ||
        (value.artifact && value.artifact.sourceCapture.generationId !== value.id)
      )
        throw publicMembershipHistoryError();
      return value;
    } catch {
      throw publicMembershipHistoryError();
    }
  }
  async function load(tx: Transaction, id: string) {
    hash.parse(id);
    const [row] = await tx
      .select()
      .from(membershipGenerationJobs)
      .where(eq(membershipGenerationJobs.id, id))
      .limit(1)
      .for('update');
    if (!row) throw publicMembershipHistoryError();
    return decode(row);
  }
  async function save(tx: Transaction, row: MembershipGenerationRecord) {
    const value = recordSchema.parse({
      ...row,
      version: (BigInt(row.version) + 1n).toString(),
      updatedAt: clock(),
    });
    if (BigInt(value.version) > 18446744073709551615n) throw publicMembershipHistoryError();
    await tx
      .update(membershipGenerationJobs)
      .set({
        version: BigInt(value.version),
        phase: value.phase,
        leaseUntil: value.leaseUntil,
        updatedAt: value.updatedAt,
        ...encode(value),
      })
      .where(eq(membershipGenerationJobs.id, value.id));
    return value;
  }
  async function requestGeneration(
    request: MembershipExecution,
    head: PublicMembershipHead,
    call: { signal?: AbortSignal } = {},
  ): Promise<void> {
    call.signal?.throwIfAborted();
    request = membershipExecutionSchema.parse(request);
    const scope = scopeSchema.parse({
      customerId: request.customerId,
      configurationHash: request.configurationHash,
      sourceTimeZone: request.sourceTimeZone,
      head,
    });
    const now = clock(),
      bucket =
        Math.floor(csvMembershipSourceInstant(request.asOf, request.sourceTimeZone) / 10000) *
        10000;
    const id = membershipHistoryDigest('generation-demand', { scope, bucket }, journalKey);
    const value = recordSchema.parse({
      contract: membershipGenerationPublisherContract,
      id,
      version: '1',
      phase: 'queued',
      scope,
      bucket,
      owner: null,
      leaseUntil: 0,
      artifact: null,
      writeHash: null,
      createdAt: now,
      updatedAt: now,
    });
    await db
      .get('writer')
      .insert(membershipGenerationJobs)
      .values({
        id,
        version: 1n,
        phase: value.phase,
        leaseUntil: 0,
        updatedAt: now,
        ...encode(value),
      })
      .onDuplicateKeyUpdate({ set: { id: sql`${membershipGenerationJobs.id}` } });
    call.signal?.throwIfAborted();
  }
  return {
    async request(
      request: PublicMembershipHistoryRequest,
      head: PublicMembershipHead,
      call: { signal?: AbortSignal } = {},
    ): Promise<void> {
      return requestGeneration(
        membershipExecution(publicMembershipHistoryRequestSchema.parse(request)),
        head,
        call,
      );
    },
    requestGeneration,
    read: (id: string) => db.get('writer').transaction((tx) => load(tx, id)),
    async pending(limit = 5) {
      const amount = z.number().int().min(1).max(20).parse(limit);
      return db
        .get('writer')
        .select({ id: membershipGenerationJobs.id })
        .from(membershipGenerationJobs)
        .where(
          and(
            inArray(membershipGenerationJobs.phase, [
              'queued',
              'capturing',
              'qualified',
              'publishing',
            ]),
            lte(membershipGenerationJobs.leaseUntil, clock()),
          ),
        )
        .orderBy(asc(membershipGenerationJobs.updatedAt), asc(membershipGenerationJobs.id))
        .limit(amount);
    },
    async claimCapture(id: string) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (!['queued', 'capturing'].includes(row.phase) || row.leaseUntil > clock()) return null;
        return save(tx, {
          ...row,
          phase: 'capturing',
          owner: randomUUID(),
          leaseUntil: clock() + 30000,
        });
      });
    },
    async qualified(
      claim: MembershipGenerationRecord,
      artifact: MembershipGenerationArtifact,
      writeHash: string,
    ) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, claim.id);
        if (
          row.phase !== 'capturing' ||
          row.owner !== claim.owner ||
          row.version !== claim.version ||
          row.leaseUntil <= clock()
        )
          throw publicMembershipHistoryError();
        return save(tx, {
          ...row,
          phase: 'qualified',
          owner: null,
          leaseUntil: 0,
          artifact: artifactSchema.parse(artifact),
          writeHash: hash.parse(writeHash),
        });
      });
    },
    async claimWrite(id: string) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (row.phase !== 'qualified') return null;
        return save(tx, { ...row, phase: 'publishing', leaseUntil: clock() + 10000 });
      });
    },
    async acknowledge(
      id: string,
      expected: string,
      status: 'unknown' | 'pending' | 'succeeded' | 'failed',
    ) {
      return db.get('writer').transaction(async (tx) => {
        const row = await load(tx, id);
        if (
          row.writeHash !== expected ||
          !['publishing', 'published', 'failed'].includes(row.phase)
        )
          throw publicMembershipHistoryError();
        if (['published', 'failed'].includes(row.phase)) return row;
        return save(tx, {
          ...row,
          phase:
            status === 'succeeded' ? 'published' : status === 'failed' ? 'failed' : 'publishing',
          leaseUntil: clock() + 10000,
        });
      });
    },
  };
}
export type PublicMembershipGenerationJournal = ReturnType<
  typeof publicMembershipGenerationJournal
>;
export interface MembershipGenerationWritePort {
  readonly publicationTable: string;
  hash(artifact: MembershipGenerationArtifact): string;
  preflight(artifact: MembershipGenerationArtifact, signal: AbortSignal): Promise<void>;
  start(
    artifact: MembershipGenerationArtifact,
    signal: AbortSignal,
  ): Promise<'unknown' | 'pending' | 'succeeded' | 'failed'>;
  read(
    artifact: MembershipGenerationArtifact,
    signal: AbortSignal,
  ): Promise<'unknown' | 'pending' | 'succeeded' | 'failed'>;
}
/** Source snapshot + warehouse comparison is publication infrastructure only.
 * The app's history read never calls capture, prepare or advance. */
export function publicMembershipGenerationPublisher(
  authority: {
    sourceKey: string;
    publicationKey: string;
    memberIds: readonly string[];
  },
  dependencies: {
    journal: PublicMembershipGenerationJournal;
    source: {
      capture(
        input: { customerId: string; generationId: string; configurationHash: string },
        call: { signal: AbortSignal },
      ): Promise<MembershipGeneration>;
    };
    warehouse: MembershipWarehouseGenerationPort;
    writer: MembershipGenerationWritePort;
    enabled: () => boolean;
    clock?: () => number;
  },
) {
  assertMembershipHistoryKeys(authority.sourceKey, authority.publicationKey);
  const now = dependencies.clock ?? Date.now;
  return {
    async advance(id: string, signal: AbortSignal) {
      let row = await dependencies.journal.read(id);
      if (['published', 'failed'].includes(row.phase)) return row.phase;
      if (['queued', 'capturing'].includes(row.phase)) {
        if (!dependencies.enabled() || signal.aborted) return 'pending';
        const claim = await dependencies.journal.claimCapture(id);
        if (!claim) return 'pending';
        const capture = await dependencies.source.capture(
          {
            customerId: claim.scope.customerId,
            generationId: id,
            configurationHash: claim.scope.configurationHash,
          },
          { signal },
        );
        if (
          capture.sourceTimeZone !== claim.scope.sourceTimeZone ||
          JSON.stringify(capture.head) !== JSON.stringify(claim.scope.head)
        )
          throw publicMembershipHistoryError();
        if (!dependencies.enabled() || signal.aborted) return 'pending';
        const qualified = await publishMembershipGeneration(
          capture,
          dependencies.warehouse,
          authority,
          { signal, clock: now },
        );
        const artifact = artifactSchema.parse({
          ...qualified,
          publicationTable: dependencies.writer.publicationTable,
        });
        if (now() >= capture.capturedAt + 60000) throw publicMembershipHistoryError();
        row = await dependencies.journal.qualified(
          claim,
          artifact,
          dependencies.writer.hash(artifact),
        );
      }
      if (
        !row.artifact ||
        !row.writeHash ||
        dependencies.writer.hash(row.artifact) !== row.writeHash
      )
        throw publicMembershipHistoryError();
      let send = false;
      if (row.phase === 'qualified') {
        if (!dependencies.enabled() || signal.aborted) return 'pending';
        await dependencies.writer.preflight(row.artifact, signal);
        if (!dependencies.enabled() || signal.aborted) return 'pending';
        const claimed = await dependencies.journal.claimWrite(id);
        if (!claimed) return 'pending';
        row = claimed;
        send = true;
      }
      // An absent/unknown original job is not permission to publish again.
      const result = send
        ? await dependencies.writer.start(row.artifact!, signal)
        : await dependencies.writer.read(row.artifact!, signal);
      return (await dependencies.journal.acknowledge(id, row.writeHash!, result)).phase;
    },
  };
}
