import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiError, captureOperatorScope, post, request } from '../../../api/client';
import { useOnline } from '../../../hooks/use-pos';
import {
  cancellationBenefitsSchema,
  cancellationContextSchema,
  cancellationIntentSchema,
  cancellationKey,
  cancellationReceiptSchema,
  readCancellationIntent,
  type CancellationIntent,
} from './client';
interface Props {
  ownerId: string;
  storeId: string;
  orderId: string;
  onCancelled: () => void;
}
function RestoredBenefits({
  value,
  confirmed,
}: {
  value: z.infer<typeof cancellationBenefitsSchema>;
  confirmed: boolean;
}) {
  const verb = confirmed ? 'Restored' : 'Restore';
  return (
    <div aria-label="Cancellation benefit restoration">
      {Number(value.moneyCredited) > 0 && (
        <p>
          {verb} TSS Money: {value.moneyCredited}
        </p>
      )}
      {Number(value.pointsCredited) > 0 && (
        <p>
          {verb} TSS Points: {value.pointsCredited}
        </p>
      )}
      {(Number(value.moneyExpired) > 0 || Number(value.pointsExpired) > 0) && (
        <p>
          Already expired value remains unusable: TSS Money {value.moneyExpired}, TSS Points{' '}
          {value.pointsExpired}. Original expiry dates are retained.
        </p>
      )}
      {Number(value.voucherCredited) > 0 && (
        <p>
          {verb} voucher value: {value.voucherCredited}.
          {value.voucherAvailable === false
            ? ' The credit remains unavailable under its current disabled, blocked or expired state.'
            : ' Existing validity and block settings are retained.'}
        </p>
      )}
      {value.membership === 'prior-entitlement-restored' && (
        <p>
          {confirmed
            ? 'The previously owned membership was restored.'
            : 'Preserve the previously owned membership.'}
        </p>
      )}
      {value.membership === 'deactivated' && (
        <p>
          {confirmed
            ? 'This order’s membership change was reversed.'
            : 'Reverse only this order’s proved membership change.'}
        </p>
      )}
    </div>
  );
}
export function OrderCancellationActions({ ownerId, storeId, orderId, onCancelled }: Props) {
  const online = useOnline(),
    [context, setContext] = useState<z.infer<typeof cancellationContextSchema> | null>(null),
    [intent, setIntent] = useState<CancellationIntent | null>(null),
    [receipt, setReceipt] = useState<z.infer<typeof cancellationReceiptSchema> | null>(null),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState(false),
    [missing, setMissing] = useState(false);
  const lock = useRef(false),
    scope = useRef<AbortSignal | null>(null),
    notified = useRef<string | null>(null),
    callback = useRef(onCancelled);
  callback.current = onCancelled;
  const key = cancellationKey(ownerId, storeId, orderId),
    base = `/api/v1/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}/cancellations`;
  const adopt = useCallback(
    (value: z.infer<typeof cancellationReceiptSchema>) => {
      if (value.orderId !== orderId || value.storeId !== storeId)
        throw new Error('The cancellation belongs to another order.');
      setReceipt(value);
      setMissing(false);
      setReview(false);
      setProblem('');
      if (notified.current !== value.id) {
        notified.current = value.id;
        callback.current();
      }
    },
    [storeId, orderId],
  );
  const readOriginal = useCallback(
    async (saved: CancellationIntent) => {
      const signal = captureOperatorScope(ownerId);
      try {
        const result = await request(
          base + '/' + saved.operationId,
          { operatorId: ownerId, signal },
          cancellationReceiptSchema,
        );
        signal.throwIfAborted();
        adopt(result);
        return result;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 404 &&
          error.code === 'CANCELLATION_NOT_FOUND'
        ) {
          setMissing(true);
          return null;
        }
        throw error;
      }
    },
    [base, ownerId, adopt],
  );
  useEffect(() => {
    if (!online) return;
    const signal = captureOperatorScope(ownerId);
    scope.current = signal;
    void (async () => {
      const saved = readCancellationIntent(key);
      setIntent(saved);
      const value = await request(base, { operatorId: ownerId, signal }, cancellationContextSchema);
      signal.throwIfAborted();
      if (value.orderId !== orderId || value.storeId !== storeId)
        throw new Error('The cancellation response belongs to another order.');
      setContext(value);
      if (value.receipt) adopt(value.receipt);
      else if (saved) await readOriginal(saved);
    })().catch((error) => {
      if (!signal.aborted)
        setProblem(error instanceof Error ? error.message : 'Cancellation state is unavailable.');
    });
  }, [online, key, base, ownerId, storeId, orderId, adopt, readOriginal]);
  async function act(task: () => Promise<void>) {
    if (lock.current) return;
    const signal = captureOperatorScope(ownerId);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      await task();
    } catch (error) {
      if (!signal.aborted)
        setProblem(
          error instanceof Error
            ? error.message
            : 'Keep the original cancellation reference and check its state.',
        );
    } finally {
      lock.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  async function submit() {
    let original = intent;
    if (original) {
      if (await readOriginal(original)) return;
    } else {
      if (!context?.eligible || !context.snapshotHash) return;
      original = cancellationIntentSchema.parse({
        operationId: crypto.randomUUID(),
        snapshotHash: context.snapshotHash,
      });
      localStorage.setItem(key, JSON.stringify(original));
      setIntent(original);
    }
    setMissing(false);
    adopt(await post(base, original, cancellationReceiptSchema, ownerId));
  }
  return (
    <section aria-label="Pending order cancellation">
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {receipt ? (
        <>
          <p role="status">
            Order cancellation confirmed. No cash refund was recorded. Reference: {receipt.id}
          </p>
          {receipt.benefits && <RestoredBenefits value={receipt.benefits} confirmed />}
        </>
      ) : intent ? (
        <>
          <p role="status">
            Keep the original cancellation reference until its outcome is confirmed:{' '}
            {intent.operationId}
          </p>
          <button
            className="button secondary"
            disabled={busy || !online}
            onClick={() =>
              void act(async () => {
                await readOriginal(intent);
              })
            }
          >
            Check original cancellation
          </button>
          {missing && (
            <button
              className="button secondary"
              disabled={busy || !online}
              onClick={() => void act(submit)}
            >
              Retry original cancellation
            </button>
          )}
        </>
      ) : context?.eligible ? (
        <>
          {review ? (
            <>
              <p>
                This cancels the pending order and restores its stock. No counter payment or cash
                refund will be recorded.
              </p>
              {context.benefits && <RestoredBenefits value={context.benefits} confirmed={false} />}
              <button
                className="button primary"
                disabled={busy || !online}
                onClick={() => void act(submit)}
              >
                Confirm pending order cancellation
              </button>
            </>
          ) : (
            <button
              className="button secondary"
              disabled={busy || !online}
              onClick={() => setReview(true)}
            >
              Cancel pending order
            </button>
          )}
        </>
      ) : context?.blocker === 'CANCELLATION_SCREENING_UNSUPPORTED' ? (
        <p>Screening tickets cannot be cancelled.</p>
      ) : context?.blocker && context.blocker !== 'ORDER_NOT_CANCELLABLE' ? (
        <p>Cancellation requires review: {context.blocker}</p>
      ) : null}
    </section>
  );
}
