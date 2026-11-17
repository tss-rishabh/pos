import { z } from 'zod';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type {
  ImportFinancialState,
  SourceOrderReceipt,
  ImportCompletedProof,
} from './financial-adapter-contracts.js';
import type {
  sourceRejectionReceiptSchema,
  FinancialImportStage,
} from './financial-adapter-contracts.js';
import type { LegacyOrderImportPlan } from './plans.js';
import type { screeningImportProfile } from './screening-profile.js';
import { screeningTicketSku } from './screening-contracts.js';
import { importFinancialError } from './financial-adapter-crypto.js';
import { identifier } from '../../domain/validation.js';
import {
  csvFinancialBenefitProfile,
  type CsvBenefitQualification,
} from './benefit-profile/composition.js';
import type { CsvBenefitProfileOptions } from './benefit-profile/adapter.js';
import {
  csvFinancialBenefitSnapshotSchema,
  type CsvFinancialBenefitSnapshot,
} from './benefit-profile/completion.js';
import type { CsvMembershipOptions } from './membership-profile/native.js';
import type { NativePreparationClosure } from './financial-adapter-preparation-contracts.js';
import {
  csvMembershipCompletionSnapshotSchema,
  type CsvMembershipCompletionSnapshot,
} from './membership-profile/completion.js';

export interface FinancialImportProfileContext {
  readonly state: ImportFinancialState;
  readonly plan: LegacyOrderImportPlan;
}
type Transaction = AdministrationTransaction;
type Context = FinancialImportProfileContext;
type Rejection = z.infer<typeof sourceRejectionReceiptSchema>;
export type FinancialProfilePhase = 'staged' | 'settled';

/** Server-installed profile hooks. No request body can install these callbacks. */
export interface FinancialImportProfileHooks {
  readonly requiresCurrentReads?: boolean;
  assertReady?(plan: LegacyOrderImportPlan): void;
  reserved?(transaction: Transaction, context: Context): Promise<void>;
  lock?(transaction: Transaction, context: Context): Promise<void>;
  dispatch?(transaction: Transaction, context: Context, stage: FinancialImportStage): Promise<void>;
  sourceReceipt?(
    transaction: Transaction,
    context: Context,
    order: SourceOrderReceipt,
  ): Promise<void>;
  completed?(
    transaction: Transaction,
    context: Context,
    proof: ImportCompletedProof,
  ): Promise<void>;
  rejected?(transaction: Transaction, context: Context, proof: Rejection): Promise<void>;
  preparationClosed?(
    transaction: Transaction,
    context: Context,
    proof: NativePreparationClosure,
  ): Promise<void>;
  preparationResumed?(
    transaction: Transaction,
    context: Context,
    proof: NativePreparationClosure,
  ): Promise<void>;
  expectedQuantities?(
    transaction: Transaction,
    context: Context,
    order: SourceOrderReceipt,
    phase: FinancialProfilePhase,
  ): Promise<ReadonlyMap<string, number> | null>;
  completionSnapshot?(
    transaction: Transaction,
    context: Context,
    order: SourceOrderReceipt,
  ): Promise<CsvMembershipCompletionSnapshot | null>;
  qualifiedBenefits?(
    transaction: Transaction,
    context: Context,
    order: SourceOrderReceipt,
    phase: FinancialProfilePhase,
  ): Promise<CsvBenefitQualification | null>;
  benefitSnapshot?(
    transaction: Transaction,
    context: Context,
    order: SourceOrderReceipt,
  ): Promise<CsvFinancialBenefitSnapshot | null>;
}
export interface FinancialImportProfiles extends Required<FinancialImportProfileHooks> {
  readonly requiresCurrentReads: boolean;
  needsReservation(plan: LegacyOrderImportPlan): boolean;
}
export interface FinancialAdapterProfileOptions {
  /** Trusted options only; a default unselected descriptor guard is mandatory. */
  readonly membership?: CsvMembershipOptions;
  readonly benefits?: CsvBenefitProfileOptions;
  readonly screening?: {
    readonly profile: ReturnType<typeof screeningImportProfile>;
    /** Trusted source deployment setting; never accepted from an import request. */
    readonly lineItemsEnabled: boolean;
  };
  readonly extensions?: readonly FinancialImportProfileHooks[];
}
function usesScreening(plan: LegacyOrderImportPlan) {
  return plan.lines.some((line) => line.productId === screeningTicketSku);
}

/** Default composition rejects screening without querying its optional schema. */
export function financialAdapterProfiles(
  options: FinancialAdapterProfileOptions = {},
): FinancialImportProfiles {
  const screening = options.screening,
    lineItemsEnabled = screening?.lineItemsEnabled,
    extensions = [
      csvFinancialBenefitProfile(
        options.membership ?? {
          contract: '',
          sourceProofKey: '',
          membershipProofKey: '',
          freshReaderContract: '',
          productIds: [],
          freeProductId: '',
        },
        options.benefits ?? { sourceProofKey: options.membership?.sourceProofKey ?? '' },
      ),
      ...(options.extensions ?? []),
    ];
  function requireScreening(plan: LegacyOrderImportPlan) {
    if (!usesScreening(plan)) return null;
    if (!screening?.profile.qualified || typeof lineItemsEnabled !== 'boolean')
      throw importFinancialError('ORDER_IMPORT_SCREENING_UNQUALIFIED', 503);
    screening.profile.assertReady();
    return screening.profile;
  }
  return {
    requiresCurrentReads:
      screening?.profile.qualified === true ||
      extensions.some((extension) => extension.requiresCurrentReads === true),
    needsReservation(plan) {
      return (
        usesScreening(plan) || extensions.some((extension) => extension.reserved !== undefined)
      );
    },
    assertReady(plan) {
      requireScreening(plan);
      for (const extension of extensions) extension.assertReady?.(plan);
    },
    async reserved(tx, context) {
      const profile = requireScreening(context.plan);
      if (profile) await profile.reserve(tx, context.state.scope, lineItemsEnabled!);
      for (const extension of extensions) await extension.reserved?.(tx, context);
    },
    async lock(tx, context) {
      const profile = requireScreening(context.plan);
      if (profile) await profile.read(tx, context.state.scope);
      for (const extension of extensions) await extension.lock?.(tx, context);
    },
    async dispatch(tx, context, stage) {
      const profile = requireScreening(context.plan);
      if (profile) {
        const state = await profile.read(tx, context.state.scope);
        if (
          stage === 'order'
            ? state.phase !== 'RESERVED'
            : state.phase !== 'BOUND' || state.sourceReceiptHash === null
        )
          throw importFinancialError('ORDER_IMPORT_SCREENING_REPLAY_REQUIRED');
      }
      for (const extension of extensions) await extension.dispatch?.(tx, context, stage);
    },
    async sourceReceipt(tx, context, order) {
      const profile = requireScreening(context.plan);
      if (profile) {
        const value = await profile.attachSourceReceipt(tx, context.state.scope);
        if (value.orderId !== order.orderId || value.requestHash !== order.requestHash)
          throw importFinancialError('ORDER_IMPORT_SCREENING_ORDER_UNCONFIRMED');
      }
      for (const extension of extensions) await extension.sourceReceipt?.(tx, context, order);
    },
    async completed(tx, context, proof) {
      const profile = requireScreening(context.plan);
      if (profile) {
        const value = await profile.complete(tx, context.state.scope);
        if (value.orderId !== proof.order.orderId || value.requestHash !== proof.requestHash)
          throw importFinancialError('ORDER_IMPORT_SCREENING_COMPLETION_UNCONFIRMED');
      }
      for (const extension of extensions) await extension.completed?.(tx, context, proof);
    },
    async rejected(tx, context, proof) {
      const profile = requireScreening(context.plan);
      if (profile) {
        if (
          proof.operationId !== context.state.scope.operationId ||
          proof.requestHash !== context.state.requestHash
        )
          throw importFinancialError('ORDER_IMPORT_SCREENING_NO_EFFECTS_REQUIRED');
        await profile.releaseRejected(tx, context.state.scope);
      }
      for (const extension of extensions) await extension.rejected?.(tx, context, proof);
    },
    async preparationClosed(tx, context, proof) {
      if (usesScreening(context.plan)) {
        if (!screening?.profile)
          throw importFinancialError('ORDER_IMPORT_SCREENING_UNQUALIFIED', 503);
        await screening.profile.releaseUndispatched(tx, context.state.scope, proof);
      }
      for (const extension of extensions) await extension.preparationClosed?.(tx, context, proof);
    },
    async preparationResumed(tx, context, proof) {
      const profile = requireScreening(context.plan);
      if (profile)
        await profile.rearmUndispatched(tx, context.state.scope, proof, lineItemsEnabled!);
      for (const extension of extensions) await extension.preparationResumed?.(tx, context, proof);
    },
    async expectedQuantities(tx, context, order, phase) {
      phase = z.enum(['staged', 'settled']).parse(phase);
      // Current entitlement checks belong only at staged/settled mutation gates;
      // immutable completed reads use their frozen financial proof instead.
      let result: Map<string, number> | null = null;
      for (const extension of extensions) {
        const values = await extension.expectedQuantities?.(tx, context, order, phase);
        if (values == null) continue;
        if (values.size < 1 || values.size > 1000)
          throw importFinancialError('ORDER_IMPORT_PROFILE_QUANTITIES_INVALID');
        const candidate = new Map<string, number>();
        for (const [id, quantity] of values) {
          if (
            !identifier.safeParse(id).success ||
            !Number.isSafeInteger(quantity) ||
            quantity < 1 ||
            quantity > 999
          )
            throw importFinancialError('ORDER_IMPORT_PROFILE_QUANTITIES_INVALID');
          candidate.set(id, quantity);
        }
        if (
          result &&
          (result.size !== candidate.size ||
            [...result].some(([id, quantity]) => candidate.get(id) !== quantity))
        )
          throw importFinancialError('ORDER_IMPORT_PROFILE_QUANTITIES_CONFLICT');
        result = candidate;
      }
      return result;
    },
    async completionSnapshot(tx, context, order) {
      let result: CsvMembershipCompletionSnapshot | null = null;
      for (const extension of extensions) {
        const value = await extension.completionSnapshot?.(tx, context, order);
        if (value == null) continue;
        const parsed = csvMembershipCompletionSnapshotSchema.safeParse(value);
        if (!parsed.success || (result && JSON.stringify(result) !== JSON.stringify(parsed.data)))
          throw importFinancialError('ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID');
        result = parsed.data;
      }
      return result;
    },
    async qualifiedBenefits(tx, context, order, phase) {
      let result: CsvBenefitQualification | null = null;
      for (const extension of extensions) {
        const value = await extension.qualifiedBenefits?.(tx, context, order, phase);
        if (value == null) continue;
        if (result && result !== value)
          throw importFinancialError('ORDER_IMPORT_PROFILE_QUANTITIES_CONFLICT');
        result = value;
      }
      return result;
    },
    async benefitSnapshot(tx, context, order) {
      let result: CsvFinancialBenefitSnapshot | null = null;
      for (const extension of extensions) {
        const value = await extension.benefitSnapshot?.(tx, context, order);
        if (value == null) continue;
        const parsed = csvFinancialBenefitSnapshotSchema.safeParse(value);
        if (!parsed.success || (result && JSON.stringify(result) !== JSON.stringify(parsed.data)))
          throw importFinancialError('ORDER_IMPORT_BENEFIT_PROOF_INVALID');
        result = parsed.data;
      }
      return result;
    },
  };
}
