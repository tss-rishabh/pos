import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { MUser } from '../../../db/legacy-schema.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import type {
  FinancialImportProfileContext,
  FinancialImportProfileHooks,
  FinancialProfilePhase,
} from '../financial-adapter-profiles.js';
import {
  sourceConfirmationReceiptSchema,
  type ImportFinancialState,
  type SourceOrderReceipt,
} from '../financial-adapter-contracts.js';
import {
  financialImportSourceReceipts,
  financialImportStages,
} from '../financial-adapter-schema.js';
import { equalImportHash, financialSourceHash } from '../financial-adapter-crypto.js';
import { csvMembershipImportProfile } from '../membership-profile/adapter.js';
import type { CsvMembershipOptions } from '../membership-profile/native.js';
import { csvBenefitProfileHooks, type CsvBenefitProfileOptions } from './adapter.js';
import { readCsvBenefitDescriptors } from './native.js';
import { verifyCsvBenefitComposition, type SealedBenefit } from './ownership.js';
import { automaticCouponContract, complementaryContract, benefitError } from './contracts.js';
import {
  csvBenefitCompletionSchema,
  csvFinancialBenefitSnapshotSchema,
  validateCsvFinancialBenefitSnapshot,
  type CsvFinancialBenefitSnapshot,
} from './completion.js';

type Transaction = AdministrationTransaction;
type Context = FinancialImportProfileContext;
type StagedSnapshot = z.infer<typeof csvBenefitCompletionSchema>;
const qualificationBrand: unique symbol = Symbol('verified-import-benefits');
export interface CsvBenefitQualification {
  readonly [qualificationBrand]: true;
}
interface QualificationRecord {
  tx: Transaction;
  key: string;
  phase: FinancialProfilePhase;
  snapshot: StagedSnapshot;
}
const qualifications = new WeakMap<CsvBenefitQualification, QualificationRecord>();
const scopeKey = (state: ImportFinancialState) =>
  JSON.stringify([
    state.scope.actorId,
    state.scope.operationId,
    state.scope.storeId,
    state.scope.counterId,
    state.planHash,
    state.requestHash,
    state.authority.customerId,
  ]);
const orderKey = (state: ImportFinancialState, order: SourceOrderReceipt) =>
  JSON.stringify([scopeKey(state), order.orderId, order.headerHash, order.lineHash]);

/** A writer cannot turn an expected quantity map or a plain object into a
 * coupon allowance. Only verified current receipts in this exact TX mint it. */
export function assertCsvBenefitQualification(
  tx: Transaction,
  value: CsvBenefitQualification,
  state: ImportFinancialState,
  order: SourceOrderReceipt,
  phase: FinancialProfilePhase,
) {
  const record = qualifications.get(value);
  if (
    !record ||
    record.tx !== tx ||
    record.key !== orderKey(state, order) ||
    record.phase !== phase
  )
    throw benefitError();
  return { couponId: record.snapshot.coupon?.receipt.headerCouponId ?? null };
}
interface Checked {
  qualification: CsvBenefitQualification;
  snapshot: StagedSnapshot;
  confirmationHash: string | null;
  expected: ReadonlyMap<string, number>;
  view: { plan: Context['plan']; order: SourceOrderReceipt };
}
export interface CsvFinancialBenefitProfile extends FinancialImportProfileHooks {
  readonly requiresCurrentReads: true;
}

/** Server-only membership +coupon/complementary composition. The independently
 * qualified ownership reducer removes only proven POS selections from the
 * membership admission view; full source hashes/financial scope are retained. */
export function csvFinancialBenefitProfile(
  memberOptions: CsvMembershipOptions,
  options: CsvBenefitProfileOptions,
): CsvFinancialBenefitProfile {
  const member = csvMembershipImportProfile(memberOptions),
    locks = new WeakMap<Transaction, string>(),
    cache = new WeakMap<Transaction, Map<string, Checked>>();
  async function descriptors(tx: Transaction, context: Context) {
    const values = await readCsvBenefitDescriptors(
      tx,
      context.state.scope.operationId,
      context.state.requestHash,
    );
    if (!Object.keys(values).length) return null;
    if (
      (values['coupon-benefit'] && options.automaticCoupon !== automaticCouponContract) ||
      (values['pos-complement'] && options.complementary !== complementaryContract) ||
      (values['coupon-consume'] && !values['coupon-benefit'])
    )
      throw benefitError();
    return values;
  }
  async function locked(tx: Transaction, context: Context) {
    if (locks.get(tx) !== scopeKey(context.state)) throw benefitError();
  }
  async function memberDescriptor(
    tx: Transaction,
    context: Context,
  ): Promise<SealedBenefit | undefined> {
    const rows = await tx
      .select({
        id: financialImportSourceReceipts.id,
        status: financialImportSourceReceipts.status,
        requestHash: financialImportSourceReceipts.requestHash,
        seal: financialImportSourceReceipts.proofHash,
        value:
          sql<unknown>`CASE WHEN OCTET_LENGTH(${financialImportSourceReceipts.proof})<=262144 THEN ${financialImportSourceReceipts.proof} ELSE NULL END`.mapWith(
            financialImportSourceReceipts.proof,
          ),
      })
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.operationId, context.state.scope.operationId),
          eq(financialImportSourceReceipts.kind, 'membership'),
        ),
      )
      .limit(2)
      .for('share');
    if (!rows.length) return undefined;
    const row = rows[0]!;
    if (
      rows.length !== 1 ||
      row.id !== context.state.scope.operationId + ':membership' ||
      row.status !== 'completed' ||
      row.requestHash !== context.state.requestHash ||
      row.value === null
    )
      throw benefitError();
    return { value: row.value, seal: row.seal };
  }
  async function manifest(tx: Transaction, context: Context, order: SourceOrderReceipt) {
    const values = await descriptors(tx, context);
    if (!values) return null;
    await locked(tx, context);
    const membership = await memberDescriptor(tx, context),
      input = {
        ...context,
        order,
        sourceProofKey: options.sourceProofKey,
        coupon: values['coupon-benefit'],
        complementary: values['pos-complement'],
        ...(membership
          ? {
              membership: {
                ...membership,
                membershipProofKey: memberOptions.membershipProofKey,
                productIds: memberOptions.productIds,
                freeProductId: memberOptions.freeProductId,
              },
            }
          : {}),
      },
      ownership = verifyCsvBenefitComposition(input);
    return { input, ownership };
  }
  async function confirmationHash(tx: Transaction, context: Context, order: SourceOrderReceipt) {
    const rows = await tx
      .select({
        id: financialImportSourceReceipts.id,
        status: financialImportSourceReceipts.status,
        requestHash: financialImportSourceReceipts.requestHash,
        hash: financialImportSourceReceipts.proofHash,
        value:
          sql<unknown>`CASE WHEN OCTET_LENGTH(${financialImportSourceReceipts.proof})<=16000 THEN ${financialImportSourceReceipts.proof} ELSE NULL END`.mapWith(
            financialImportSourceReceipts.proof,
          ),
      })
      .from(financialImportSourceReceipts)
      .where(
        and(
          eq(financialImportSourceReceipts.operationId, context.state.scope.operationId),
          eq(financialImportSourceReceipts.kind, 'confirmation'),
        ),
      )
      .limit(2)
      .for('share');
    const [stage] = await tx
      .select({ nonce: financialImportStages.nonce, status: financialImportStages.status })
      .from(financialImportStages)
      .where(
        and(
          eq(financialImportStages.operationId, context.state.scope.operationId),
          eq(financialImportStages.kind, 'confirmation'),
        ),
      )
      .limit(1)
      .for('share');
    const row = rows[0],
      parsed = sourceConfirmationReceiptSchema.safeParse(row?.value);
    if (
      rows.length !== 1 ||
      !row ||
      row.id !== context.state.scope.operationId + ':confirmation' ||
      row.status !== 'completed' ||
      row.requestHash !== context.state.requestHash ||
      !parsed.success ||
      !stage ||
      stage.status !== 'confirmed'
    )
      throw benefitError();
    const proof = parsed.data;
    if (
      proof.operationId !== context.state.scope.operationId ||
      proof.requestHash !== context.state.requestHash ||
      proof.orderId !== order.orderId ||
      proof.customerId !== context.state.authority.customerId ||
      proof.storeId !== context.state.scope.storeId ||
      proof.counterId !== context.state.scope.counterId ||
      proof.headerHash !== order.headerHash ||
      proof.nonce !== stage.nonce ||
      !equalImportHash(row.hash, financialSourceHash(options.sourceProofKey, 'confirmation', proof))
    )
      throw benefitError();
    return row.hash;
  }
  async function checked(
    tx: Transaction,
    context: Context,
    order: SourceOrderReceipt,
    phase: FinancialProfilePhase,
  ): Promise<Checked | null> {
    const key = JSON.stringify([orderKey(context.state, order), phase]),
      prior = cache.get(tx)?.get(key);
    if (prior) return prior;
    const m = await manifest(tx, context, order);
    if (!m) return null;
    const hash =
        phase === 'settled' && context.plan.kind === 'offline'
          ? await confirmationHash(tx, context, order)
          : null,
      hooks = csvBenefitProfileHooks(options),
      result = await (phase === 'staged' ? hooks.assertStaged : hooks.assertSettled)(tx, {
        ...m.input,
        ...(hash ? { confirmationHash: hash } : {}),
      }),
      view = result.membershipAdmissionView;
    await member.expectedQuantities?.(tx, { ...context, plan: view.plan }, view.order, phase);
    const expected = new Map<string, number>();
    for (const line of result.ownership)
      expected.set(line.productId, (expected.get(line.productId) ?? 0) + line.quantity);
    const qualification: CsvBenefitQualification = Object.freeze({
        [qualificationBrand]: true as const,
      }),
      snapshot = csvBenefitCompletionSchema.parse(result.snapshot),
      value: Checked = { qualification, snapshot, confirmationHash: hash, expected, view };
    qualifications.set(qualification, { tx, key: orderKey(context.state, order), phase, snapshot });
    let values = cache.get(tx);
    if (!values) {
      values = new Map();
      cache.set(tx, values);
    }
    values.set(key, value);
    return value;
  }
  async function lock(tx: Transaction, context: Context) {
    await member.lock?.(tx, context);
    if (!(await descriptors(tx, context))) return;
    const key = scopeKey(context.state);
    if (locks.has(tx) && locks.get(tx) !== key) throw benefitError();
    const [customer] = await tx
      .select({ id: MUser.id })
      .from(MUser)
      .where(eq(MUser.id, BigInt(context.state.authority.customerId)))
      .limit(1)
      .for('update');
    if (!customer) throw benefitError();
    locks.set(tx, key);
  }
  return {
    requiresCurrentReads: true,
    assertReady: (plan) => member.assertReady?.(plan),
    lock,
    dispatch: lock,
    async sourceReceipt(tx, context, order) {
      const m = await manifest(tx, context, order),
        view = m?.ownership.membershipAdmissionView;
      await member.sourceReceipt?.(
        tx,
        view ? { ...context, plan: view.plan } : context,
        view?.order ?? order,
      );
    },
    async expectedQuantities(tx, context, order, phase) {
      const result = await checked(tx, context, order, phase);
      return (
        result?.expected ?? (await member.expectedQuantities?.(tx, context, order, phase)) ?? null
      );
    },
    async qualifiedBenefits(tx, context, order, phase) {
      return (await checked(tx, context, order, phase))?.qualification ?? null;
    },
    async benefitSnapshot(tx, context, order): Promise<CsvFinancialBenefitSnapshot | null> {
      const result = await checked(tx, context, order, 'settled');
      if (!result) return null;
      const snapshot = csvFinancialBenefitSnapshotSchema.parse({
        ...result.snapshot,
        confirmationHash: result.confirmationHash,
      });
      return validateCsvFinancialBenefitSnapshot(snapshot, {
        ...context.state,
        order,
        kind: context.plan.kind,
      });
    },
    async captureConsumedReferences(tx, context, order, approval) {
      const result = await checked(tx, context, order, 'settled');
      await member.captureConsumedReferences?.(
        tx,
        result ? { ...context, plan: result.view.plan } : context,
        result?.view.order ?? order,
        approval,
      );
    },
    async completionSnapshot(tx, context, order) {
      const result = await checked(tx, context, order, 'settled');
      return member.completionSnapshot(
        tx,
        result ? { ...context, plan: result.view.plan } : context,
        result?.view.order ?? order,
      );
    },
  };
}
