import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { identifier } from '../../../domain/validation.js';
import { operationHash } from '../../checkout/crypto.js';
import type { LegacyOrderImportPlan } from '../plans.js';
import type { ImportFinancialState, SourceOrderReceipt } from '../financial-adapter-contracts.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';

export const csvMembershipContract = 'pos-legacy-import-membership-v1';
export const stagedMembershipContract = 'pos-cancellation-membership-staged-v2';
export const activatedMembershipContract = 'pos-cancellation-membership-provenance-v2';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().regex(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
export const csvMemberStateSchema = z
  .object({
    attribute: z.enum(['EXCLUSIVE_EXPIRY', 'EXCLUSIVE_MEMBER']),
    value: z.string().max(65535).nullable(),
    active: z.number().int().min(0).max(1),
    createdAt: timestamp,
    updatedAt: timestamp,
    hash,
  })
  .strict();
const states = z
  .array(csvMemberStateSchema)
  .max(2)
  .refine(
    (value) =>
      (value.length === 0 || value.length === 2) &&
      new Set(value.map((row) => row.attribute)).size === value.length,
  );
export const csvMembershipProvenanceSchema = z
  .object({
    orderId: identifier,
    customerId: identifier,
    revision: z.string().regex(/^[1-9]\d{0,19}$/),
    headerHash: hash,
    before: states,
    confirmed: states.refine((value) => value.length === 2),
    contract: z.enum([stagedMembershipContract, activatedMembershipContract]),
    operationId: z.uuid(),
    createdAt: timestamp,
    entityDigest: hash,
    proofHash: hash,
  })
  .strict();
const line = z
  .object({ id: identifier, productId: identifier, quantity: z.literal(1), inputHash: hash })
  .strict();
export const csvMembershipReceiptSchema = z
  .object({
    contract: z.literal(csvMembershipContract),
    operationId: z.uuid(),
    requestHash: hash,
    planHash: hash,
    actorId: identifier,
    authorityHash: hash,
    namespace: z.string().regex(/^pos-import-v1:[a-f0-9-]{36}$/),
    orderId: identifier,
    customerId: identifier,
    storeId: identifier,
    counterId: identifier,
    method: z.union([z.literal(14), z.literal(15)]),
    sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
    kind: z.enum(['new', 'upgrade', 'auto-free']),
    eligibility: z.enum([
      'not-added',
      'no-ordinary-items',
      'source-cart-over-2000',
      'source-qualified-history',
    ]),
    headerHash: hash,
    lineHash: hash,
    memberLines: z.array(line).length(1),
    additionalLines: z.array(line).max(1),
    provenance: csvMembershipProvenanceSchema.refine(
      (value) => value.contract === stagedMembershipContract,
    ),
    cacheInvalidations: z.number().int().min(0).max(2),
    historyEvidence: z
      .object({
        generationId: hash,
        fetchedAt: z.number().int().safe().positive(),
        asOf: timestamp,
        cutoff: timestamp,
        proofHash: hash,
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((value, ctx) => {
    const member = value.memberLines[0];
    if (
      value.kind === 'auto-free'
        ? !['source-cart-over-2000', 'source-qualified-history'].includes(value.eligibility) ||
          value.additionalLines.length !== 1 ||
          JSON.stringify(value.additionalLines[0]) !== JSON.stringify(member)
        : value.additionalLines.length !== 0
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Explicit source membership additions are required.',
      });
    if (value.eligibility === 'source-qualified-history') {
      try {
        if (
          !value.historyEvidence ||
          Temporal.PlainDateTime.from(value.historyEvidence.asOf.replace(' ', 'T'))
            .subtract({ days: 45 })
            .toString({ smallestUnit: 'second' })
            .replace('T', ' ') !== value.historyEvidence.cutoff
        )
          throw new Error();
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Qualified source history evidence is required.' });
      }
    } else if (value.historyEvidence)
      ctx.addIssue({ code: 'custom', message: 'Unexpected history evidence.' });
  });
export type CsvMembershipReceipt = z.infer<typeof csvMembershipReceiptSchema>;
export type CsvMembershipProvenance = z.infer<typeof csvMembershipProvenanceSchema>;
export const csvMembershipError = () =>
  importFinancialError('ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID');
export function membershipProvenanceHash(value: CsvMembershipProvenance, key: string) {
  const { proofHash: _seal, ...body } = value;
  return operationHash('pending-cancellation.membership-provenance.v2', body, key);
}
export function csvMembershipReceiptHash(value: CsvMembershipReceipt, key: string) {
  return operationHash('legacy-order-imports.source.membership.v1', value, key);
}
/** Explicit additional line manifest; never infer source causality from equal cart quantities. */
export function verifyCsvMembershipDescriptor(input: {
  state: ImportFinancialState;
  plan: LegacyOrderImportPlan;
  order: SourceOrderReceipt;
  value: unknown;
  seal: string;
  sourceProofKey: string;
  membershipProofKey: string;
  productIds: readonly string[];
  freeProductId: string;
}) {
  const parsed = csvMembershipReceiptSchema.safeParse(input.value);
  if (
    !parsed.success ||
    Buffer.byteLength(input.sourceProofKey) < 32 ||
    Buffer.byteLength(input.membershipProofKey) < 32
  )
    throw csvMembershipError();
  const value = parsed.data,
    { state, plan, order } = input;
  if (
    !equalImportHash(csvMembershipReceiptHash(value, input.sourceProofKey), input.seal) ||
    !equalImportHash(
      membershipProvenanceHash(value.provenance, input.membershipProofKey),
      value.provenance.proofHash,
    ) ||
    value.operationId !== state.scope.operationId ||
    value.requestHash !== state.requestHash ||
    value.planHash !== state.planHash ||
    value.actorId !== state.scope.actorId ||
    value.authorityHash !==
      operationHash(
        'legacy-order-imports.source.membership-authority.v1',
        state.authority,
        input.sourceProofKey,
      ) ||
    value.namespace !== state.namespace ||
    value.orderId !== order.orderId ||
    value.customerId !== state.authority.customerId ||
    value.storeId !== state.scope.storeId ||
    value.counterId !== state.scope.counterId ||
    value.method !== order.method ||
    value.method !== (plan.kind === 'offline' ? 14 : 15) ||
    value.headerHash !== order.headerHash ||
    value.lineHash !== order.lineHash ||
    value.provenance.orderId !== order.orderId ||
    value.provenance.customerId !== order.customerId
  )
    throw csvMembershipError();
  const member = value.memberLines[0]!;
  const ids = new Set(input.productIds);
  if (
    !ids.has(member.productId) ||
    new Set(input.productIds).size !== input.productIds.length ||
    !ids.has(input.freeProductId) ||
    order.lines.filter((row) => ids.has(row.productId)).length !== 1 ||
    !order.lines.some(
      (row) =>
        row.id === member.id &&
        row.productId === member.productId &&
        row.quantity === member.quantity &&
        row.inputHash === member.inputHash,
    )
  )
    throw csvMembershipError();
  const expected = new Map(plan.lines.map((row) => [row.productId, row.quantity]));
  for (const extra of value.additionalLines) {
    if (extra.productId !== input.freeProductId || expected.has(extra.productId))
      throw csvMembershipError();
    expected.set(extra.productId, extra.quantity);
  }
  if (value.kind !== 'auto-free' && !expected.has(member.productId)) throw csvMembershipError();
  const actual = new Map<string, number>();
  for (const row of order.lines)
    actual.set(row.productId, (actual.get(row.productId) ?? 0) + row.quantity);
  if (expected.size !== actual.size || [...expected].some(([id, qty]) => actual.get(id) !== qty))
    throw csvMembershipError();
  return { receipt: value, expectedQuantities: expected };
}
