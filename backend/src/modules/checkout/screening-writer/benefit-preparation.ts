import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import { json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { Payload } from '../payloads.js';
import {
  nodeScreeningWriterSchema,
  screeningPortableHash,
  type NodeScreeningWriterCapability,
} from './capability.js';
import { publicScreeningHash } from './proof.js';
import { publicScreeningBenefitsContract } from './benefit-contracts.js';
import {
  publicMembershipHistorySchema,
  publicMembershipHistoryRequestSchema,
  publicMembershipHeadSchema,
  type PublicMembershipHistory,
  type PublicMembershipHistoryPort,
  publicMembershipHistoryError,
  membershipHistoryDigest,
} from './membership-history.js';

export const publicBenefitPreparationContract = 'pos-public-screening-benefit-preparation-v1';
export const publicBenefitPreparationSchema = z
  .object({
    contract: z.literal(publicBenefitPreparationContract),
    operationId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    cartHash: z.string().regex(/^[a-f0-9]{64}$/),
    membershipHistory: publicMembershipHistorySchema.nullable(),
    preparedAt: z.number().int().positive().safe(),
  })
  .strict();
export type PublicBenefitPreparation = z.infer<typeof publicBenefitPreparationSchema>;
export const publicBenefitPreparations = mysqlTable(
  'pos_rewrite_public_screening_benefit_preparations',
  {
    operationId: varchar('operation_id', { length: 36 }).primaryKey(),
    data: json('data').$type<PublicBenefitPreparation>().notNull(),
    proofHash: varchar('proof_hash', { length: 64 }).notNull(),
  },
);
export interface PublicBenefitPreparationPort {
  prepare(
    input: { capability: NodeScreeningWriterCapability; header: string; payload: Payload },
    call: { signal: AbortSignal },
  ): Promise<PublicBenefitPreparation>;
}
const responseSchema = z
  .object({
    contract: z.literal(publicBenefitPreparationContract),
    operationId: z.uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    cartHash: z.string().regex(/^[a-f0-9]{64}$/),
    outcome: z.enum(['ready', 'need-history', 'quote-changed']),
    historyScope: publicMembershipHistoryRequestSchema.optional(),
    head: publicMembershipHeadSchema.optional(),
    membershipHistoryHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    issuedAt: z.number().int().positive().safe(),
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const body = response.body;
  if (!response.ok || !body || response.redirected) throw publicMembershipHistoryError();
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 100000) throw publicMembershipHistoryError();
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function publicBenefitPreparation(
  options: {
    contract?: typeof publicBenefitPreparationContract;
    url?: string;
    key?: string;
    sourceKey?: string;
    historyKey?: string;
    customerContextKey?: string;
    membershipProofKey?: string;
  },
  dependencies: {
    history?: PublicMembershipHistoryPort;
    fetcher?: typeof fetch;
    clock?: () => number;
  } = {},
): PublicBenefitPreparationPort {
  const clock = dependencies.clock ?? Date.now,
    fetcher = dependencies.fetcher ?? fetch;
  return {
    async prepare(input, call) {
      try {
        const cap = nodeScreeningWriterSchema.parse(input.capability);
        const known = [
          options.key,
          options.sourceKey,
          options.historyKey,
          options.customerContextKey,
          options.membershipProofKey,
        ].filter((value): value is string => value !== undefined);
        if (
          options.contract !== publicBenefitPreparationContract ||
          cap.benefitsContract !== publicScreeningBenefitsContract ||
          !options.url ||
          !options.key ||
          !options.sourceKey ||
          known.some((key) => !/^[!-~]{32,4096}$/.test(key)) ||
          new Set(known).size !== known.length ||
          screeningPortableHash(input.payload) !== cap.requestHash
        )
          throw publicMembershipHistoryError();
        const url = new URL(options.url);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/internal/pos/public-screening/preparations'
        )
          throw publicMembershipHistoryError();
        let history: PublicMembershipHistory | null = null;
        for (let round = 0; round < 2; round++) {
          const remaining = cap.expiresAt - clock();
          if (remaining <= 0) throw publicMembershipHistoryError();
          const signal = AbortSignal.any([
            call.signal,
            AbortSignal.timeout(Math.min(10000, remaining)),
          ]);
          const body = JSON.stringify({
            capability: input.header,
            payload: input.payload,
            ...(history ? { membershipHistory: history } : {}),
          });
          if (Buffer.byteLength(body) > 1200000) throw publicMembershipHistoryError();
          const response = await fetcher(url, {
            method: 'POST',
            signal,
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              'X-POS-Screening-Preparation-Key': options.key,
            },
            body,
          });
          const wire = z
            .object({ data: responseSchema, proofHash: z.string().regex(/^[a-f0-9]{64}$/) })
            .strict()
            .parse(await boundedJson(response, signal));
          const value = wire.data,
            now = clock();
          if (
            publicScreeningHash(options.sourceKey, 'benefit-preparation', value) !==
              wire.proofHash ||
            value.operationId !== cap.operationId ||
            value.requestHash !== cap.requestHash ||
            value.cartHash !== cap.cartHash ||
            value.expiresAt !== cap.expiresAt ||
            value.issuedAt < cap.issuedAt ||
            value.issuedAt > now ||
            now >= cap.expiresAt ||
            value.membershipHistoryHash !== (history ? screeningPortableHash(history) : null)
          )
            throw publicMembershipHistoryError();
          if (value.outcome === 'quote-changed')
            throw new AppError(
              409,
              'SCREENING_WRITER_QUOTE_CHANGED',
              'Membership eligibility changed the sale. No order was dispatched. Keep the original draft, close its unsent admission, and review a fresh quote before collecting payment.',
            );
          if (value.outcome === 'ready') {
            if (value.historyScope || value.head) throw publicMembershipHistoryError();
            return publicBenefitPreparationSchema.parse({
              contract: publicBenefitPreparationContract,
              operationId: cap.operationId,
              requestHash: cap.requestHash,
              cartHash: cap.cartHash,
              membershipHistory: history,
              preparedAt: now,
            });
          }
          if (
            history ||
            round > 0 ||
            !value.historyScope ||
            !value.head ||
            !dependencies.history ||
            !options.historyKey
          )
            throw publicMembershipHistoryError();
          const requested = value.historyScope;
          if (
            (['operationId', 'checkoutId', 'customerId', 'requestHash', 'cartHash'] as const).some(
              (name) => requested[name] !== cap[name],
            )
          )
            throw publicMembershipHistoryError();
          history = await dependencies.history.read(value.historyScope, value.head, {
            signal,
            expiresAt: cap.expiresAt,
          });
          const { signature, ...document } = history;
          if (
            signature !== membershipHistoryDigest('document', document, options.historyKey) ||
            JSON.stringify(history.scope) !== JSON.stringify(value.historyScope) ||
            JSON.stringify(history.head) !== JSON.stringify(value.head) ||
            history.expiresAt > cap.expiresAt ||
            history.expiresAt <= clock()
          )
            throw publicMembershipHistoryError();
        }
        throw publicMembershipHistoryError();
      } catch (error) {
        // Source/network/JSON/validation errors never expose payloads, remote
        // exception text or credentials. The original prepared UUID remains.
        if (error instanceof AppError && error.code === 'SCREENING_WRITER_QUOTE_CHANGED')
          throw error;
        throw publicMembershipHistoryError();
      }
    },
  };
}
