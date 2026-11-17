import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MUser } from '../../../db/legacy-schema.js';
import { identifier } from '../../../domain/validation.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { equalImportHash, importFinancialError } from '../financial-adapter-crypto.js';
import type { SourceOrderReceipt } from '../financial-adapter-contracts.js';
import type {
  FinancialImportProfileContext,
  FinancialImportProfileHooks,
  FinancialProfilePhase,
} from '../financial-adapter-profiles.js';
import { financialImportSourceReceipts } from '../financial-adapter-schema.js';
import type { LegacyOrderImportPlan } from '../plans.js';
import {
  csvMembershipContract,
  csvMembershipError,
  csvMembershipReceiptHash,
  csvMembershipReceiptSchema,
  membershipProvenanceHash,
  verifyCsvMembershipDescriptor,
} from './domain.js';
import { assertCsvMembershipProfile, type CsvMembershipOptions } from './native.js';
import {
  csvMembershipCompletionSnapshotSchema,
  csvMembershipSnapshotMaximumBytes,
  type CsvMembershipCompletionSnapshot,
} from './completion.js';
import { captureMembershipReference, readCapturedMembershipReference } from './references.js';
import {
  captureStagedMembershipReference,
  readStagedMembershipReference,
  sameStagedReferenceFacts,
} from './staged-references.js';

type Transaction = AdministrationTransaction;
type Context = FinancialImportProfileContext;
interface Descriptor {
  receipt: z.infer<typeof csvMembershipReceiptSchema>;
  sourceReceiptHash: string;
}
export interface CsvMembershipImportProfile extends FinancialImportProfileHooks {
  readonly requiresCurrentReads: true;
  /** Called before the new immutable financial proof is sealed, under its TX. */
  completionSnapshot(
    transaction: Transaction,
    context: Context,
    order: SourceOrderReceipt,
  ): Promise<CsvMembershipCompletionSnapshot | null>;
}
const registry = z
  .array(identifier)
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length);

/** Server-installed composition only. Empty/unselected options allow ordinary
 * imports, but can never admit planned members or ignore a retained descriptor. */
export function csvMembershipImportProfile(
  supplied: CsvMembershipOptions,
): CsvMembershipImportProfile {
  const parsed = registry.safeParse(supplied.productIds);
  if (!parsed.success) throw csvMembershipError();
  const options = { ...supplied, productIds: [...parsed.data] },
    products = new Set(options.productIds),
    locks = new WeakMap<Transaction, string>();
  function selected() {
    if (
      options.contract !== csvMembershipContract ||
      options.freshReaderContract !== 'pos-membership-fresh-reader-v1' ||
      Buffer.byteLength(options.sourceProofKey) < 32 ||
      Buffer.byteLength(options.membershipProofKey) < 32 ||
      !products.size ||
      !identifier.safeParse(options.freeProductId).success ||
      !products.has(options.freeProductId)
    )
      throw csvMembershipError();
  }
  const plannedMember = (plan: LegacyOrderImportPlan) =>
    plan.lines.some((line) => products.has(line.productId));
  const scopeKey = ({ state }: Context) =>
    JSON.stringify([
      state.scope.actorId,
      state.scope.storeId,
      state.scope.counterId,
      state.scope.operationId,
      state.requestHash,
      state.planHash,
      state.authority.customerId,
    ]);
  async function descriptor(tx: Transaction, context: Context): Promise<Descriptor | null> {
    const { state } = context;
    const rows = await tx
      .select({
        id: financialImportSourceReceipts.id,
        status: financialImportSourceReceipts.status,
        requestHash: financialImportSourceReceipts.requestHash,
        sourceReceiptHash: financialImportSourceReceipts.proofHash,
        bytes: sql<string>`CAST(OCTET_LENGTH(${financialImportSourceReceipts.proof}) AS CHAR)`,
        // Do not load an oversized value, and do not filter its row away.
        value: sql<unknown>`CASE WHEN OCTET_LENGTH(${financialImportSourceReceipts.proof})<=${csvMembershipSnapshotMaximumBytes} THEN ${financialImportSourceReceipts.proof} ELSE NULL END`,
      })
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.operationId, state.scope.operationId),
          eq(financialImportSourceReceipts.kind, 'membership'),
        ),
      )
      .limit(2)
      .for('share');
    if (!rows.length) return null;
    selected();
    const row = rows[0]!;
    if (
      rows.length !== 1 ||
      row.id !== `${state.scope.operationId}:membership` ||
      row.status !== 'completed' ||
      row.requestHash !== state.requestHash ||
      !/^\d{1,10}$/.test(row.bytes) ||
      BigInt(row.bytes) < 1n ||
      BigInt(row.bytes) > BigInt(csvMembershipSnapshotMaximumBytes) ||
      !/^[a-f0-9]{64}$/.test(row.sourceReceiptHash)
    )
      throw csvMembershipError();
    let value: unknown = row.value;
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw csvMembershipError();
      }
    }
    const receipt = csvMembershipReceiptSchema.safeParse(value);
    if (
      !receipt.success ||
      !equalImportHash(
        row.sourceReceiptHash,
        csvMembershipReceiptHash(receipt.data, options.sourceProofKey),
      ) ||
      !equalImportHash(
        receipt.data.provenance.proofHash,
        membershipProvenanceHash(receipt.data.provenance, options.membershipProofKey),
      ) ||
      receipt.data.operationId !== state.scope.operationId ||
      receipt.data.actorId !== state.scope.actorId ||
      receipt.data.storeId !== state.scope.storeId ||
      receipt.data.counterId !== state.scope.counterId ||
      receipt.data.customerId !== state.authority.customerId ||
      receipt.data.requestHash !== state.requestHash ||
      receipt.data.planHash !== state.planHash ||
      receipt.data.namespace !== state.namespace
    )
      throw csvMembershipError();
    return { receipt: receipt.data, sourceReceiptHash: row.sourceReceiptHash };
  }
  async function lock(tx: Transaction, context: Context) {
    // Authenticating an existing completed financial proof must not depend on
    // present entitlement, contacts, source keys or profile flags.
    if (context.state.status === 'completed') return;
    if (plannedMember(context.plan)) selected();
    const found = await descriptor(tx, context);
    if (!found && !plannedMember(context.plan)) return;
    const key = scopeKey(context);
    if (locks.has(tx) && locks.get(tx) !== key) throw csvMembershipError();
    const [customer] = await tx
      .select({ id: MUser.id })
      .from(MUser)
      .where(eq(MUser.id, BigInt(identifier.parse(context.state.authority.customerId))))
      .limit(1)
      .for('update');
    if (!customer) throw csvMembershipError();
    locks.set(tx, key);
  }
  function locked(tx: Transaction, context: Context) {
    if (locks.get(tx) !== scopeKey(context))
      throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_LOCK_REQUIRED', 503);
  }
  async function boundDescriptor(tx: Transaction, context: Context, order: SourceOrderReceipt) {
    if (context.state.status === 'completed') throw csvMembershipError();
    const found = await descriptor(tx, context),
      member =
        plannedMember(context.plan) || order.lines.some((line) => products.has(line.productId));
    if (!found) {
      if (member) throw csvMembershipError();
      return null;
    }
    locked(tx, context);
    const checked = verifyCsvMembershipDescriptor({
      ...context,
      order,
      value: found.receipt,
      seal: found.sourceReceiptHash,
      ...options,
    });
    return { ...found, expectedQuantities: checked.expectedQuantities };
  }
  async function current(
    tx: Transaction,
    context: Context,
    order: SourceOrderReceipt,
    phase: FinancialProfilePhase,
  ) {
    phase = z.enum(['staged', 'settled']).parse(phase);
    const found = await boundDescriptor(tx, context, order);
    if (!found) return null;
    const checked = await assertCsvMembershipProfile(tx, { ...context, order, phase }, options);
    if (!checked || JSON.stringify(checked.receipt) !== JSON.stringify(found.receipt))
      throw csvMembershipError();
    return {
      ...found,
      expectedQuantities: checked.expectedQuantities,
      reference: checked.reference,
      stagedReference: checked.stagedReference,
      referenceActivation: checked.referenceActivation,
    };
  }
  return {
    requiresCurrentReads: true,
    assertReady(plan) {
      if (plannedMember(plan)) selected();
    },
    lock,
    dispatch: lock,
    async sourceReceipt(tx, context, order) {
      await boundDescriptor(tx, context, order);
    },
    async expectedQuantities(tx, context, order, phase) {
      return (await current(tx, context, order, phase))?.expectedQuantities ?? null;
    },
    async captureStagedReferences(tx, context, order, approval) {
      const found = await current(tx, context, order, 'staged');
      if (found?.stagedReference)
        await captureStagedMembershipReference(tx, found.stagedReference, approval, options);
    },
    async captureConsumedReferences(tx, context, order, approval) {
      // Shopify/staged membership has no consumed activation to authenticate.
      if (context.plan.kind !== 'offline') return;
      const found = await current(tx, context, order, 'settled');
      if (found?.reference)
        await captureMembershipReference(tx, found.reference, approval, options);
    },
    async completionSnapshot(tx, context, order) {
      const found = await current(tx, context, order, 'settled');
      const reference = found?.reference
        ? await readCapturedMembershipReference(
            tx,
            found.reference,
            context.state.authoritySuccession?.id ?? '',
            options,
          )
        : null;
      const stagedReference = found?.stagedReference
        ? await readStagedMembershipReference(
            tx,
            context.state.scope.operationId,
            context.state.authoritySuccession?.id ?? '',
            options,
          )
        : (found?.referenceActivation?.reference ?? null);
      if (found?.stagedReference && stagedReference)
        sameStagedReferenceFacts(stagedReference, found.stagedReference);
      return found
        ? csvMembershipCompletionSnapshotSchema.parse({
            receipt: found.receipt,
            sourceReceiptHash: found.sourceReceiptHash,
            ...(reference ? { reference } : {}),
            ...(stagedReference ? { stagedReference } : {}),
            ...(found.referenceActivation
              ? {
                  referenceActivation: {
                    data: found.referenceActivation.activation,
                    sourceHash: found.referenceActivation.sourceHash,
                  },
                }
              : {}),
          })
        : null;
    },
  };
}
