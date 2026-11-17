import type { Config } from '../../config.js';
import {
  financialImportPlanSchema,
  financialImportScopeSchema,
  financialImportAuthoritySchema,
} from './financial-adapter-contracts.js';
import { expectedFinancialPlanHash, importFinancialError } from './financial-adapter-crypto.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import { legacyImportPreparationTransport } from './financial-adapter-transport.js';
import {
  sourceOrderPreparationContract,
  type SourceOrderPreparationPort,
} from './source-order-preparation-contracts.js';
import type { SourceOrderPreparationOptions } from './source-order-preparation-options.js';
import {
  assertCsvMembershipPrefetch,
  prefetchCsvMembershipHistory,
  type CsvMembershipPrefetch,
} from './membership-profile/bridge.js';
import {
  csvMembershipBigQueryHistory,
  csvMembershipSourceInstant,
} from './membership-profile/bigquery.js';
import type { CsvMembershipHistoryPort } from './membership-profile/history.js';
import type { CsvCouponHistoryPort, CouponHistoryScope } from './benefit-profile/history.js';
import {
  assertCsvCouponPrefetch,
  couponSourceInstant,
  prefetchCsvCouponHistory,
  type CsvCouponPrefetch,
  type CouponHistoryWitness,
} from './benefit-profile/bridge.js';
import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { operationHash } from '../checkout/crypto.js';

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(signal.reason);
        signal.addEventListener('abort', listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener('abort', listener);
  }
}

/** Core invokes this only outside SQL, after its native RUNNING attempt commits
 * and before dispatch('order'). A failure is Node-local, never a source order
 * unknown. The returned complete document is copied/sealed by that core. */
export function sourceOrderPreparation(
  config: Pick<Config, 'NODE_ENV' | 'BUSINESS_TIMEZONE'>,
  financial: LegacyImportFinancialOptions,
  options: SourceOrderPreparationOptions,
  dependencies: {
    historyReader?: CsvMembershipHistoryPort;
    couponHistoryReader?: CsvCouponHistoryPort;
    /** Encrypted background demand only; this port must not capture history or
     * publish synchronously. Called after a genuine source preview is checked. */
    couponHistoryDemand?: {
      enqueue(
        scope: CouponHistoryScope,
        options: { witness: CouponHistoryWitness; signal?: AbortSignal },
      ): Promise<unknown>;
    };
    clock?: () => number;
    fetcher?: typeof fetch;
  } = {},
): SourceOrderPreparationPort {
  const clock = dependencies.clock ?? financial.clock ?? Date.now,
    transport = legacyImportPreparationTransport(config, {
      ...financial,
      clock,
      fetcher: dependencies.fetcher ?? financial.fetcher,
    });
  return {
    async prepare(supplied, { signal }) {
      signal.throwIfAborted();
      // Snapshot caller-owned objects before awaits. No fresh browser/state
      // lookup may silently substitute another plan, actor or contact later.
      const input = structuredClone(supplied),
        now = clock();
      if (
        options.contract !== sourceOrderPreparationContract ||
        input.state.preparationContract !== sourceOrderPreparationContract ||
        !z.uuid().safeParse(input.attemptId).success ||
        !financialImportScopeSchema.safeParse(input.state.scope).success ||
        !financialImportAuthoritySchema.safeParse(input.state.authority).success ||
        !financialImportPlanSchema.safeParse(input.plan).success ||
        input.state.status !== 'running' ||
        input.state.orderId !== null ||
        input.state.namespace !== 'pos-import-v1:' + input.state.scope.operationId ||
        input.plan.storeId !== input.state.scope.storeId ||
        !Number.isSafeInteger(now) ||
        !Number.isSafeInteger(input.expiresAt) ||
        now >= input.expiresAt ||
        input.state.planHash !==
          expectedFinancialPlanHash(
            financial.secret,
            input.state.scope,
            input.plan,
            input.state.correction,
          )
      )
        throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
      const artifacts: {
        membershipHistory?: CsvMembershipPrefetch;
        couponHistory?: CsvCouponPrefetch;
      } = {};
      // Each literal history escape can occur once. Both copied generations
      // survive later previews; no retry obtains a newer execution snapshot.
      for (let round = 0; round < 3; round++) {
        signal.throwIfAborted();
        if (clock() >= input.expiresAt)
          throw importFinancialError('ORDER_IMPORT_PREPARATION_EXPIRED');
        const preview = await transport.preview(input, { signal, ...artifacts });
        if (preview.sourceTimeZone !== config.BUSINESS_TIMEZONE)
          throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
        if (preview.outcome === 'ready') {
          if (artifacts.membershipHistory)
            assertCsvMembershipPrefetch(
              artifacts.membershipHistory,
              artifacts.membershipHistory.capability.scope,
              {
                historyKey: options.historyKey!,
                sourceTimeZone: preview.sourceTimeZone,
                memberProductIds: options.memberProductIds,
                maxLagSeconds: options.warehouse.CSV_MEMBERSHIP_MAX_LAG_SECONDS,
                clock,
              },
            );
          if (artifacts.couponHistory)
            assertCsvCouponPrefetch(
              artifacts.couponHistory,
              artifacts.couponHistory.capability.scope,
              {
                historyKey: options.couponHistoryKey!,
                sourceProofKey: financial.sourceProofKey!,
                guardKey: options.couponGuardKey!,
                clock,
              },
            );
          return artifacts;
        }
        if (preview.outcome === 'need-history') {
          if (artifacts.membershipHistory || round === 2)
            throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
          const scope = preview.historyScope!;
          if (
            scope.operationId !== input.state.scope.operationId ||
            scope.requestHash !== input.state.requestHash ||
            scope.planHash !== input.state.planHash ||
            scope.customerId !== input.state.authority.customerId ||
            csvMembershipSourceInstant(scope.asOf, preview.sourceTimeZone) > preview.issuedAt ||
            preview.issuedAt - csvMembershipSourceInstant(scope.asOf, preview.sourceTimeZone) >=
              60000 ||
            options.warehouse.CSV_MEMBERSHIP_SOURCE_TIMEZONE !== preview.sourceTimeZone ||
            !options.historyKey ||
            !options.publicationKey ||
            new Set([
              options.historyKey,
              options.publicationKey,
              financial.secret,
              financial.sourceAuthKey,
              financial.sourceProofKey,
              ...(options.membershipProofKey ? [options.membershipProofKey] : []),
            ]).size !== (options.membershipProofKey ? 6 : 5)
          )
            throw importFinancialError('ORDER_IMPORT_PREPARATION_HISTORY_REQUIRED', 503);
          const historyOptions = {
            historyKey: options.historyKey,
            sourceTimeZone: preview.sourceTimeZone,
            memberProductIds: options.memberProductIds,
            maxLagSeconds: options.warehouse.CSV_MEMBERSHIP_MAX_LAG_SECONDS,
            clock,
          };
          const reader =
            dependencies.historyReader ??
            csvMembershipBigQueryHistory(
              options.warehouse,
              {
                historyKey: options.historyKey,
                publicationKey: options.publicationKey,
                memberProductIds: options.memberProductIds,
              },
              { clock },
            );
          signal.throwIfAborted();
          // Abort propagates before/after the bounded SDK reader. It cannot produce
          // an order dispatch even if a cancelled read finishes in the background.
          let history: CsvMembershipPrefetch = await abortable(
            prefetchCsvMembershipHistory(reader, scope, historyOptions),
            signal,
          ).catch((error: unknown) => {
            signal.throwIfAborted();
            if (error instanceof AppError && /^ORDER_IMPORT_MEMBERSHIP_[A-Z_]+$/.test(error.code))
              throw error;
            throw importFinancialError('ORDER_IMPORT_PREPARATION_HISTORY_REQUIRED', 503);
          });
          signal.throwIfAborted();
          if (clock() >= input.expiresAt)
            throw importFinancialError('ORDER_IMPORT_PREPARATION_EXPIRED');
          if (history.capability.expiresAt > input.expiresAt) {
            const { signature: _signature, ...capability } = history.capability;
            const clipped = { ...capability, expiresAt: input.expiresAt };
            history = Object.freeze({
              document: history.document,
              capability: Object.freeze({
                ...clipped,
                signature: operationHash(
                  'legacy-order-imports.membership-prefetch.v1',
                  clipped,
                  options.historyKey,
                ),
              }),
            });
          }
          artifacts.membershipHistory = history;
          continue;
        }
        if (artifacts.couponHistory || round === 2)
          throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
        const scope = preview.couponHistoryScope!,
          witness = preview.couponHistoryWitness!,
          observation = preview.birthdayObservation!,
          reader = dependencies.couponHistoryReader,
          independentKeys = [
            options.couponHistoryKey,
            options.couponPublicationKey,
            options.couponGuardKey,
            financial.sourceProofKey,
            financial.sourceAuthKey,
            financial.secret,
            options.historyKey,
            options.publicationKey,
            options.membershipProofKey,
          ].filter((value): value is string => value !== undefined);
        if (
          input.state.benefitContracts?.automaticCoupon !== 'pos-csv-automatic-coupon-v1' ||
          scope.operationId !== input.state.scope.operationId ||
          scope.requestHash !== input.state.requestHash ||
          scope.planHash !== input.state.planHash ||
          scope.customerId !== input.state.authority.customerId ||
          scope.sourceTimeZone !== preview.sourceTimeZone ||
          couponSourceInstant(scope.asOf, scope.sourceTimeZone) > preview.issuedAt ||
          preview.issuedAt - couponSourceInstant(scope.asOf, scope.sourceTimeZone) >= 60000 ||
          !reader ||
          !options.couponHistoryKey ||
          !options.couponGuardKey ||
          !financial.sourceProofKey ||
          new Set(independentKeys).size !== independentKeys.length
        )
          throw importFinancialError('ORDER_IMPORT_PREPARATION_COUPON_HISTORY_REQUIRED', 503);
        artifacts.couponHistory = await abortable(
          prefetchCsvCouponHistory(
            reader,
            scope,
            witness,
            observation,
            {
              historyKey: options.couponHistoryKey,
              sourceProofKey: financial.sourceProofKey,
              guardKey: options.couponGuardKey,
              clock,
            },
            { signal, expiresAt: input.expiresAt },
          ),
          signal,
        ).catch(async (error: unknown) => {
          signal.throwIfAborted();
          if (
            dependencies.couponHistoryDemand &&
            error instanceof AppError &&
            error.code === 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_INCOMPLETE'
          ) {
            // Preserve the original preparation result even if the separate
            // queue is unavailable. This never authorizes financial dispatch.
            try {
              await abortable(
                dependencies.couponHistoryDemand.enqueue(scope, { witness, signal }),
                signal,
              );
            } catch {
              signal.throwIfAborted();
            }
          }
          if (error instanceof AppError && /^ORDER_IMPORT_COUPON_[A-Z_]+$/.test(error.code))
            throw error;
          throw importFinancialError('ORDER_IMPORT_PREPARATION_COUPON_HISTORY_REQUIRED', 503);
        });
      }
      throw importFinancialError('ORDER_IMPORT_PREPARATION_INVALID');
    },
  };
}
