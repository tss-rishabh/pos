import { AppError } from '../../domain/errors.js';
import type { AdministrationTransaction } from '../administration/checkins.js';
import type {
  ImportFinancialResult,
  ImportFinancialScope,
  ImportFinancialStart,
} from './financial-contracts.js';
import type { LegacyImportFinancialOptions } from './financial-adapter-options.js';
import { financialOrderPreparationContract } from './financial-adapter-contracts.js';
import { financialImportScopeSchema } from './financial-adapter-contracts.js';
import {
  financialImportHash,
  equalImportHash,
  importFinancialError,
  expectedFinancialPlanHash,
} from './financial-adapter-crypto.js';
import {
  assertFinancialImportAuthority,
  lockFinancialImportScope,
} from './financial-adapter-authority.js';
import {
  legacyImportFinancialJournal,
  lockFinancialImportStore,
} from './financial-adapter-journal.js';
import type {
  FinancialImportProfileContext,
  FinancialImportProfiles,
} from './financial-adapter-profiles.js';
import { financialPreparationLedger } from './financial-adapter-preparation-ledger.js';
import { financialSavepoint } from './screening-transactions.js';
import { FinancialImportAdmissionDenied } from './financial-adapter-admission.js';
import { recoverImportCompletion } from './financial-adapter-proof.js';
import {
  financialPreparationExecutionSchema,
  preparationLeaseMilliseconds,
  type FinancialOrderPreparationPort,
  type FinancialPreparationExecution,
  type FinancialPreparationHooks,
  type FinancialQueueLease,
  type NativePreparationClosure,
} from './financial-adapter-preparation-contracts.js';

type Journal = ReturnType<typeof legacyImportFinancialJournal>;
type Context = FinancialImportProfileContext;
const retryCode = 'ORDER_IMPORT_PREPARATION_RETRY_REQUIRED';
const releaseCode = 'ORDER_IMPORT_PREPARATION_RELEASE_REQUIRED';
export const nativePreparationPauseCodes = [retryCode, releaseCode] as const;
/** A preparation callback is read-only work outside SQL; native proof/leases
 * independently decide whether any later financial dispatch may start. */
export function financialOrderPreparation(
  options: LegacyImportFinancialOptions,
  journal: Journal,
  profiles: FinancialImportProfiles,
  beforeCreate: (tx: AdministrationTransaction) => Promise<void>,
  port?: FinancialOrderPreparationPort,
) {
  const now = options.clock ?? Date.now,
    ledger = financialPreparationLedger(options.secret, now);
  const scope = (input: ImportFinancialScope) =>
    financialImportScopeSchema.parse({
      actorId: input.actorId,
      operationId: input.operationId,
      storeId: input.storeId,
      counterId: input.counterId,
    });
  const unknown = (context: Context): ImportFinancialResult => ({
    status: 'unknown',
    operationId: context.state.scope.operationId,
    stage: 'preparation',
    orderId: null,
  });
  async function closed(
    tx: AdministrationTransaction,
    context: Context,
    proof: NativePreparationClosure,
  ): Promise<ImportFinancialResult> {
    let code = proof.code === 'ORDER_IMPORT_PREPARATION_CANCELLED' ? proof.code : retryCode;
    const state = {
      ...context.state,
      status: 'rejected' as const,
      stage: 'preparation' as const,
      orderId: null,
      errorCode: code,
      updatedAt: now(),
    };
    await journal.save(tx, state);
    try {
      await financialSavepoint(tx, (savepoint) =>
        profiles.preparationClosed(savepoint, { ...context, state }, proof),
      );
    } catch (error: unknown) {
      // The local dispatch proof remains true when a retained screening key or
      // its ledger needs repair. Quota stays held; no release is fabricated.
      if (!(error instanceof AppError) || !error.code.startsWith('ORDER_IMPORT_SCREENING_'))
        throw error;
      code = releaseCode;
      await journal.save(tx, { ...state, errorCode: code });
    }
    return { status: 'rejected', operationId: state.scope.operationId, code };
  }
  async function originalAuthority(tx: AdministrationTransaction, context: Context) {
    await assertFinancialImportAuthority(tx, context.state.scope, context.state.authority);
    const checked = await journal.approvals.authorizeStart(tx, {
      ...context.state.scope,
      plan: context.plan,
      planHash: context.state.planHash,
      ...(context.state.correction ? { correction: context.state.correction } : {}),
    });
    if (
      !checked.ready ||
      !equalImportHash(
        financialImportHash(options.secret, 'dispatch-authority', checked.authority),
        financialImportHash(options.secret, 'dispatch-authority', context.state.authority),
      )
    )
      throw importFinancialError('ORDER_IMPORT_PREPARATION_AUTHORITY_CHANGED');
  }
  async function claim(
    tx: AdministrationTransaction,
    input: ImportFinancialStart,
    queue?: FinancialQueueLease,
  ) {
    await lockFinancialImportScope(tx, scope(input));
    if (queue) await ledger.queue(tx, scope(input), queue);
    else await ledger.direct(tx, scope(input));
    const context = await journal.reserve(input, beforeCreate, {
      transaction: tx,
      preparationContract: financialOrderPreparationContract,
    });
    if (
      context.admission ||
      context.state.status === 'completed' ||
      !context.state.preparationContract
    )
      return { context, execution: null };
    const prior = context.created ? null : await ledger.latest(tx, context.state);
    if (prior && prior.phase !== 'AUTHORIZED') return { context, execution: null };
    if (prior) await originalAuthority(tx, context);
    const execution = await ledger.begin(tx, context.state, queue);
    if (prior) {
      const history = await ledger.history(tx, context.state),
        proof = history[1]?.closure;
      if (!proof) throw importFinancialError('ORDER_IMPORT_PREPARATION_PROOF_INVALID');
      try {
        await financialSavepoint(tx, (savepoint) =>
          profiles.preparationResumed(savepoint, context, proof),
        );
      } catch (error: unknown) {
        if (!(error instanceof FinancialImportAdmissionDenied)) throw error;
        const negative = await ledger.close(
          tx,
          context.state,
          'ORDER_IMPORT_PREPARATION_FAILED',
          execution,
        );
        if (!negative) throw importFinancialError('ORDER_IMPORT_PREPARATION_PROOF_INVALID');
        await closed(tx, context, negative);
        return { context, execution: null };
      }
    }
    return { context, execution };
  }
  const recovery: Pick<FinancialPreparationHooks, 'lock' | 'cancel'> = {
    async lock(tx, input) {
      await lockFinancialImportScope(tx, input);
    },
    async cancel(tx, input) {
      const context = await journal.load(tx, scope(input));
      if (!context?.state.preparationContract) return;
      const proof = await ledger.close(tx, context.state, 'ORDER_IMPORT_PREPARATION_CANCELLED');
      if (!proof) throw importFinancialError(retryCode);
      await closed(tx, context, proof);
    },
  };
  const hooks: FinancialPreparationHooks | undefined = port
    ? {
        ...recovery,
        async claim(tx, input, queue) {
          const result = await claim(tx, input, queue);
          return result.execution ?? { kind: 'read', queue };
        },
        async resume(tx, input, commandId) {
          const context = await journal.load(tx, scope(input));
          if (
            !context ||
            context.state.planHash !== input.planHash ||
            context.state.preparationContract !== financialOrderPreparationContract
          )
            throw importFinancialError(retryCode);
          const latest = await ledger.latest(tx, context.state);
          if (
            latest.phase !== 'CLOSED' ||
            !latest.closure ||
            latest.closure.code === 'ORDER_IMPORT_PREPARATION_CANCELLED'
          )
            throw importFinancialError(retryCode);
          await originalAuthority(tx, context);
          // A rejected native operation cannot be rearmed around unreleased quota.
          await profiles.preparationClosed(tx, context, latest.closure);
          await ledger.authorize(tx, context.state, commandId);
          await journal.save(tx, {
            ...context.state,
            status: 'running',
            stage: 'preparation',
            errorCode: null,
            updatedAt: now(),
          });
        },
      }
    : undefined;
  return {
    hooks,
    recovery,
    async recover(
      tx: AdministrationTransaction,
      context: Context,
    ): Promise<ImportFinancialResult | null> {
      if (!context.state.preparationContract) return null;
      const latest = await ledger.latest(tx, context.state);
      if (latest.phase === 'DISPATCHED') return null;
      if (latest.phase === 'CLOSED') {
        const proof = await ledger.close(tx, context.state, latest.closure!.code);
        if (!proof) throw importFinancialError('ORDER_IMPORT_PREPARATION_PROOF_INVALID');
        return closed(tx, context, proof);
      }
      if (latest.phase === 'AUTHORIZED') return unknown(context);
      const proof = await ledger.close(tx, context.state, 'ORDER_IMPORT_PREPARATION_EXPIRED');
      return proof ? closed(tx, context, proof) : unknown(context);
    },
    async prepare(input: ImportFinancialStart, supplied?: FinancialPreparationExecution) {
      if (!port) throw importFinancialError('ORDER_IMPORT_PREPARATION_UNAVAILABLE', 503);
      const start = await journal.transaction(async (tx) => {
        const execution = supplied
          ? financialPreparationExecutionSchema.parse(supplied)
          : undefined;
        if (execution?.kind === 'read') {
          const context = await journal.load(tx, scope(input));
          if (!context) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
          return { context, execution: null, attempt: null };
        }
        let context: Context, owned: FinancialPreparationExecution;
        if (execution) {
          await lockFinancialImportStore(tx, scope(input));
          if (execution.queue) await ledger.queue(tx, scope(input), execution.queue);
          else await ledger.direct(tx, scope(input));
          const loaded = await journal.load(tx, scope(input));
          if (!loaded) throw importFinancialError('ORDER_IMPORT_FINANCIAL_SCOPE_INVALID');
          if (
            loaded.state.planHash !== input.planHash ||
            !equalImportHash(
              input.planHash,
              expectedFinancialPlanHash(options.secret, scope(input), input.plan, input.correction),
            )
          )
            throw importFinancialError('ORDER_IMPORT_PLAN_CHANGED');
          context = loaded;
          owned = execution;
        } else {
          const result = await claim(tx, input);
          context = result.context;
          if (!result.execution) return { context, execution: null, attempt: null };
          owned = result.execution;
        }
        if (await recoverImportCompletion(tx, context, options.secret))
          return { context, execution: null, attempt: null };
        const attempt = await ledger.consume(tx, context.state, owned);
        return { context, execution: attempt ? owned : null, attempt };
      });
      if (!start.execution || !start.attempt) return { context: start.context, command: null };
      const controller = new AbortController(),
        duration = Math.min(preparationLeaseMilliseconds, start.attempt.expiresAt! - now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (duration <= 0) throw importFinancialError(retryCode);
        const expired = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(importFinancialError('ORDER_IMPORT_PREPARATION_EXPIRED'));
          }, duration);
        });
        const output = await Promise.race([
          port.prepare(
            {
              state: structuredClone(start.context.state),
              plan: structuredClone(start.context.plan),
              attemptId: start.attempt.id,
              expiresAt: start.attempt.expiresAt!,
            },
            { signal: controller.signal },
          ),
          expired,
        ]);
        const command = await journal.transaction((tx) =>
          journal.dispatch(scope(input), 'order', {
            transaction: tx,
            execution: start.execution!,
            output,
          }),
        );
        return { context: start.context, command };
      } catch {
        // A failed local read is not an uncertain provider dispatch. Only an
        // authenticated current owner + exact native absence can close it.
        await journal.transaction(async (tx) => {
          const context = await journal.load(tx, scope(input));
          if (!context || !context.state.preparationContract) return;
          const latest = await ledger.latest(tx, context.state);
          if (
            latest.id !== start.attempt!.id ||
            latest.phase === 'DISPATCHED' ||
            latest.phase === 'AUTHORIZED'
          )
            return;
          const proof = await ledger.close(
            tx,
            context.state,
            'ORDER_IMPORT_PREPARATION_FAILED',
            start.execution!,
          );
          if (proof) await closed(tx, context, proof);
        });
        return { context: start.context, command: null };
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
