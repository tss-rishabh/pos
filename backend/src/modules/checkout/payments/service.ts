import { createHash } from 'node:crypto';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { amount, minorUnits } from '../../../domain/money.js';
import { readJson, sharedStateStore, withStateLock, type PosStateStore } from '../state-store.js';
import {
  PaymentOutcomeUnknown,
  paymentAttemptRecordSchema,
  type PaymentAttemptRecord,
  type PaymentGateway,
  type PaymentInput,
  type PaymentResult,
  type PaymentStatusInput,
  type PaytmTerminal,
  type PineTerminal,
} from './contracts.js';
import {
  classifyPaytmRequest,
  classifyPaytmStatus,
  classifyPineCancel,
  classifyPineStatus,
  classifyPineUpload,
  type Classified,
} from './legacy.js';
import type { ActiveTransaction, PaymentRepository } from './repository.js';
import type { OrderPushes } from './order-pushes.js';

/** Redis keys (table-disposition.md, checkout/payments). */
export const paymentKeys = {
  attempt: (attemptId: string) => `pos:payment_attempt:${attemptId}`,
  lock: (orderId: string) => `pos:payment_lock:${orderId}`,
};
const ATTEMPT_TTL_SECONDS = 86400,
  LOCK_TTL_SECONDS = 120;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export const paymentRequestHash = (storeId: string, orderId: string, input: PaymentInput) =>
  createHash('sha256')
    .update(JSON.stringify(canonical({ storeId, orderId, input })))
    .digest('hex');

const money = (value: string) => amount(minorUnits(value));
const busy = () =>
  new AppError(
    409,
    'PAYMENT_OPERATION_INFLIGHT',
    'Another payment action on this order is still running. Wait a moment, then check its status.',
  );
const uncertain = (legacyStatus = 'Failed') =>
  new AppError(
    502,
    'PAYMENT_OUTCOME_UNCERTAIN',
    `${legacyStatus}: the terminal did not confirm this request. Check the terminal before sending the payment again.`,
  );
const rejected = (classified: Classified) =>
  new AppError(409, 'PAYMENT_PROVIDER_REJECTED', classified.message);

export interface PaymentServiceOptions {
  stateStore?: PosStateStore;
  pushes?: OrderPushes;
}
/**
 * `stateStore` must be the shared Redis store in production. Two-argument call sites (offline
 * sync) get the application's configured store through `sharedStateStore()`.
 */
export function paymentService(
  repository: PaymentRepository,
  gateway: PaymentGateway,
  options: PaymentServiceOptions = {},
) {
  const store = options.stateStore ?? sharedStateStore();
  const locked = <T>(orderId: string, run: () => Promise<T>) =>
    withStateLock(store, paymentKeys.lock(orderId), run, {
      ttlSeconds: LOCK_TTL_SECONDS,
      waitMs: 2000,
      busy,
    });
  async function pushPaid(orderId: string) {
    // Legacy pushes synchronously after the paid write and ignores failures.
    await options.pushes?.paid(orderId).catch(() => undefined);
  }
  function result(attemptId: string | null, record: PaymentAttemptRecord): PaymentResult {
    return {
      attemptId,
      orderId: record.orderId,
      transactionId: record.transactionId,
      provider: record.provider,
      status: record.status,
      legacyStatus: record.legacyStatus,
      message: record.message,
      cashAmount: record.cashAmount,
      onlineAmount: record.onlineAmount,
    };
  }
  /** A replayed start returns (or re-raises) exactly what the original request produced. */
  function replay(attemptId: string, record: PaymentAttemptRecord): PaymentResult {
    if (record.status === 'dispatching') throw busy();
    if (record.status === 'uncertain')
      throw new AppError(502, record.errorCode ?? 'PAYMENT_OUTCOME_UNCERTAIN', record.message);
    if (record.status === 'failed')
      throw new AppError(409, record.errorCode ?? 'PAYMENT_PROVIDER_REJECTED', record.message);
    return result(attemptId, record);
  }
  async function save(attemptId: string, record: PaymentAttemptRecord) {
    await store.set(
      paymentKeys.attempt(attemptId),
      JSON.stringify(paymentAttemptRecordSchema.parse(record)),
      ATTEMPT_TTL_SECONDS,
    );
    return record;
  }
  async function existing(
    user: Principal,
    storeId: string,
    orderId: string,
    input: PaymentInput,
    hash: string,
  ) {
    const record = await readJson(
      store,
      paymentKeys.attempt(input.operationId),
      paymentAttemptRecordSchema,
    );
    if (!record) return null;
    if (
      record.operatorId !== user.id ||
      record.storeId !== storeId ||
      record.orderId !== orderId ||
      record.requestHash !== hash
    )
      throw new AppError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'This payment key was used with different data.',
      );
    return replay(input.operationId, record);
  }

  return {
    paymentContext(user: Principal, storeId: string, orderId: string) {
      return repository.paymentContext(user, storeId, orderId);
    },
    options(user: Principal, storeId: string, orderId: string) {
      return repository.options(user, storeId, orderId);
    },
    /** Lost-response recovery for one start request (no provider call). */
    async get(user: Principal, storeId: string, orderId: string, attemptId: string) {
      const record = await readJson(
        store,
        paymentKeys.attempt(attemptId),
        paymentAttemptRecordSchema,
      );
      if (
        !record ||
        record.operatorId !== user.id ||
        record.storeId !== storeId ||
        record.orderId !== orderId
      )
        throw new AppError(404, 'PAYMENT_ATTEMPT_NOT_FOUND', 'Payment attempt was not found.');
      return result(attemptId, record);
    },
    /** `AjaxTransactionUploadView.post` (order/views.py:3020-3069). */
    async start(user: Principal, storeId: string, orderId: string, input: PaymentInput) {
      const hash = paymentRequestHash(storeId, orderId, input);
      const previous = await existing(user, storeId, orderId, input, hash);
      if (previous) return previous;
      return locked(orderId, async () => {
        const again = await existing(user, storeId, orderId, input, hash);
        if (again) return again;
        const prepared = await repository.prepareStart(user, storeId, orderId, input);
        if (prepared.provider === 'pine' || prepared.provider === 'paytm')
          gateway.configured(prepared.provider);
        const transactionId =
          prepared.provider === 'paytm'
            ? prepared.transactionId.replaceAll('-', '')
            : prepared.transactionId;
        let record: PaymentAttemptRecord = {
          orderId,
          storeId,
          operatorId: user.id,
          requestHash: hash,
          status: 'dispatching',
          transactionId,
          provider: prepared.provider,
          legacyStatus: '',
          errorCode: null,
          message: '',
          cashAmount: money(input.cashAmount),
          onlineAmount: money(input.onlineAmount),
        };
        if (
          !(await store.set(
            paymentKeys.attempt(input.operationId),
            JSON.stringify(paymentAttemptRecordSchema.parse(record)),
            ATTEMPT_TTL_SECONDS,
            true,
          ))
        )
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This payment key is already in use.');
        const fail = async (
          error: AppError,
          status: 'failed' | 'uncertain',
          legacyStatus: string,
        ) => {
          await save(input.operationId, {
            ...record,
            status,
            legacyStatus,
            errorCode: error.code,
            message: error.message,
          });
          throw error;
        };
        if (prepared.provider === 'cash' || prepared.provider === 'others') {
          try {
            await repository.completeCounter(user, storeId, orderId, input, transactionId);
          } catch (error) {
            // Nothing was dispatched; the original request may simply be repeated.
            await store.del(paymentKeys.attempt(input.operationId)).catch(() => undefined);
            throw error;
          }
          const legacyStatus =
            prepared.provider === 'cash' ? 'Cash Delivered' : 'Cash/Online(Others) Delivered';
          record = await save(input.operationId, {
            ...record,
            status: 'paid',
            legacyStatus,
            message: legacyStatus,
          });
          await pushPaid(orderId);
          return result(input.operationId, record);
        }
        const terminal = prepared.terminal!;
        let classified: Classified,
          apiResponse = '',
          plutusId: string | undefined,
          sentAt: string | undefined;
        try {
          if (terminal.provider === 'pine') {
            const reply = await gateway.pineUpload(
              terminal,
              transactionId,
              input.onlineAmount,
              prepared.mode,
              user.id,
            );
            classified = classifyPineUpload(reply);
            apiResponse = reply.apiResponse;
            plutusId = reply.plutusId ?? undefined;
          } else {
            sentAt = repository.now();
            const reply = await gateway.paytmRequest(
              terminal,
              transactionId,
              input.onlineAmount,
              input.channel === 'paytm-card' ? 'CARD' : 'QR',
              sentAt,
            );
            classified =
              reply.resultCode === 'HTTP'
                ? { status: 'failed', legacyStatus: 'Failed', message: 'Failed' }
                : classifyPaytmRequest(reply);
            apiResponse = reply.apiResponse;
          }
        } catch (error) {
          if (error instanceof PaymentOutcomeUnknown)
            return fail(uncertain(), 'uncertain', 'Failed');
          throw error;
        }
        if (classified.status !== 'pending')
          return fail(rejected(classified), 'failed', classified.legacyStatus);
        try {
          await repository.recordUploaded(user, storeId, orderId, {
            provider: terminal.provider,
            transactionId,
            input,
            paymentMode: prepared.mode,
            apiResponse,
            plutusId,
            terminal,
            transactionDateTime: sentAt,
          });
        } catch {
          // The terminal accepted the request but it could not be recorded.
          return fail(
            new AppError(
              502,
              'PAYMENT_RECORD_UNCONFIRMED',
              'Approved on the terminal, but the payment could not be saved. Cancel it on the terminal before sending again.',
            ),
            'uncertain',
            'Approved',
          );
        }
        record = await save(input.operationId, {
          ...record,
          status: 'pending',
          legacyStatus: classified.legacyStatus,
          message: classified.message,
        });
        return result(input.operationId, record);
      });
    },
    /** `AjaxTransactionStatusCheckView` / `...PaytmView` (order/views.py:3117-3158). */
    async status(user: Principal, storeId: string, orderId: string, transactionId: string) {
      return locked(orderId, async () => {
        const found = await repository.uploaded(user, storeId, orderId, transactionId);
        if (!found)
          throw new AppError(404, 'PAYMENT_TRANSACTION_NOT_FOUND', 'TRANSACTION NOT FOUND');
        const { row, terminal } = found;
        if (!terminal)
          throw new AppError(
            409,
            'PAYMENT_MACHINE_UNAVAILABLE',
            'Status :Failed, Check Status Again',
          );
        gateway.configured(row.provider);
        let classified: Classified, apiResponse: string, sentAt: string | undefined;
        try {
          if (terminal.provider === 'pine') {
            const reply = await gateway.pineStatus(terminal, row.plutusId);
            classified = classifyPineStatus(reply);
            apiResponse = reply.apiResponse;
          } else {
            sentAt = repository.now();
            const reply = await gateway.paytmStatus(terminal, row.transactionId, sentAt);
            classified = classifyPaytmStatus(reply);
            apiResponse = reply.apiResponse;
          }
        } catch (error) {
          if (error instanceof PaymentOutcomeUnknown)
            throw new AppError(
              502,
              'PAYMENT_STATUS_UNAVAILABLE',
              'Status :Failed, Check Status Again',
            );
          throw error;
        }
        if (classified.status === 'paid') {
          const settled = await repository.completeTerminal(user, row, orderId, {
            apiResponse,
            terminal,
            transactionDateTime: sentAt,
          });
          if (settled) await pushPaid(orderId);
        } else if (classified.legacyStatus === 'INVALID PLUTUS ID')
          await repository.timedOut(user, row, orderId);
        else if (classified.legacyStatus === 'Merchant transaction id does not exits..!')
          await repository.logOnly(user, row, orderId, classified.legacyStatus);
        return statusResult(row, orderId, classified);
      });
    },
    /** `AjaxTransactionCancelledView` / `...PaytmView` (order/views.py:3071-3115). */
    async cancel(user: Principal, storeId: string, orderId: string, transactionId: string) {
      return locked(orderId, async () => {
        const found = await repository.uploaded(user, storeId, orderId, transactionId);
        if (!found)
          throw new AppError(404, 'PAYMENT_TRANSACTION_NOT_FOUND', 'TRANSACTION NOT FOUND');
        const { row } = found;
        if (row.provider === 'pine') {
          const terminal = found.terminal as PineTerminal | null;
          if (!terminal) throw new AppError(409, 'PAYMENT_MACHINE_UNAVAILABLE', 'Failed');
          gateway.configured('pine');
          let classified: Classified | null;
          let apiResponse = '';
          try {
            const reply = await gateway.pineCancel(terminal, row.plutusId, row.amount);
            classified = classifyPineCancel(reply);
            apiResponse = reply.apiResponse;
          } catch (error) {
            if (error instanceof PaymentOutcomeUnknown)
              throw new AppError(
                502,
                'PAYMENT_CANCEL_UNCONFIRMED',
                'Status :Failed, Check Status Again',
              );
            throw error;
          }
          if (!classified)
            throw new AppError(
              409,
              'PAYMENT_CANCEL_REJECTED',
              'Status :Failed, Check Status Again',
            );
          if (classified.status !== 'cancelled')
            throw new AppError(409, 'PAYMENT_CANCEL_REJECTED', classified.message);
          await repository.cancelled(user, row, orderId, { apiResponse, terminal });
          return statusResult(row, orderId, classified);
        }
        const facts = await repository.paytmCancelFacts(row, orderId);
        if (facts.completed)
          throw new AppError(
            409,
            'PAYMENT_ALREADY_PROCESSED',
            'Can not cancel as payment is already processed',
          );
        // Rewrite safety: ask Paytm before the legacy local-only cancel so an approved
        // payment is settled instead of being dropped (legacy never asks).
        const terminal = found.terminal as PaytmTerminal | null;
        if (terminal) {
          gateway.configured('paytm');
          const sentAt = repository.now();
          let paid = false,
            apiResponse = '';
          try {
            const reply = await gateway.paytmStatus(terminal, row.transactionId, sentAt);
            paid = classifyPaytmStatus(reply).status === 'paid';
            apiResponse = reply.apiResponse;
          } catch (error) {
            if (error instanceof PaymentOutcomeUnknown)
              throw new AppError(
                502,
                'PAYMENT_CANCEL_UNCONFIRMED',
                'The Paytm status could not be checked. Check the terminal and try again.',
              );
            throw error;
          }
          if (paid) {
            const settled = await repository.completeTerminal(user, row, orderId, {
              apiResponse,
              terminal,
              transactionDateTime: sentAt,
            });
            if (settled) await pushPaid(orderId);
            return statusResult(row, orderId, {
              status: 'paid',
              legacyStatus: 'Approved',
              message: 'Transaction Completed Successfully',
            });
          }
        }
        await repository.cancelled(user, row, orderId, {
          apiResponse: 'NIL',
          terminal: null,
          mid: facts.mid,
          tid: facts.tid,
          now: repository.now(),
        });
        return statusResult(row, orderId, {
          status: 'cancelled',
          legacyStatus: 'Approved',
          message: 'Transaction Cancelled Successfully',
        });
      });
    },
    /** `AjaxPaymentStatusView.post` (order/views.py:685-775). */
    async paymentStatus(
      user: Principal,
      storeId: string,
      orderId: string,
      input: PaymentStatusInput,
    ) {
      const outcome = await locked(orderId, () =>
        repository.paymentStatus(user, storeId, orderId, input),
      );
      if (outcome.paid) await pushPaid(orderId);
      return { status: 'success' as const, message: 'Payment status updated successfully.' };
    },
  };
}
function statusResult(
  row: ActiveTransaction,
  orderId: string,
  classified: Classified,
): PaymentResult {
  return {
    attemptId: null,
    orderId,
    transactionId: row.transactionId,
    provider: row.provider,
    status: classified.status,
    legacyStatus: classified.legacyStatus,
    message: classified.message,
    cashAmount: amount(minorUnits(Number(row.cashAmount).toFixed(2))),
    onlineAmount: amount(minorUnits(Number(row.amount).toFixed(2))),
  };
}
export type PaymentService = ReturnType<typeof paymentService>;
