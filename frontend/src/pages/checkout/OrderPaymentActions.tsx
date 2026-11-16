import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { captureOperatorScope, post, request } from '../../api/client';
import { useOnline } from '../../hooks/use-pos';
import type { ConfirmedPayment } from './receipts';
import { PaymentPanel, paymentSchema } from './PaymentPanel';
import { paymentStorageKey, readPaymentRecovery, savePaymentRecovery } from './payment-recovery';

export const orderPaymentContextSchema = z
  .object({
    orderId: z.string().regex(/^[1-9]\d{0,18}$/),
    storeId: z.string(),
    counterId: z.string(),
    payable: z.string(),
    canRecordPayment: z.boolean(),
    activeAttemptId: z.uuid().nullable(),
    legacyPayment: z
      .object({
        provider: z.enum(['pine', 'paytm']),
        legacyId: z.string().regex(/^[1-9]\d{0,18}$/),
      })
      .nullable(),
    blocker: z.string().nullable(),
  })
  .strict();
interface OrderPaymentActionsProps {
  ownerId: string;
  storeId: string;
  orderId: string;
  onPaid: (receipt: ConfirmedPayment, origin: 'read' | 'action') => void;
}
/** Existing orders have no local cart-completion callback. */
export function OrderPaymentActions({
  ownerId,
  storeId,
  orderId,
  onPaid,
}: OrderPaymentActionsProps) {
  const online = useOnline(),
    [context, setContext] = useState<z.infer<typeof orderPaymentContextSchema> | null>(null),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(false),
    [recovering, setRecovering] = useState(false);
  const lock = useRef(false),
    scope = useRef<AbortSignal | null>(null),
    base = `/api/v1/stores/${encodeURIComponent(storeId)}/orders/${encodeURIComponent(orderId)}`,
    key = paymentStorageKey(ownerId, 'order-details', orderId);
  const refresh = useCallback(async () => {
    const signal = captureOperatorScope(ownerId);
    const value = await request(
      base + '/payment-context',
      { operatorId: ownerId, signal },
      orderPaymentContextSchema,
    );
    signal.throwIfAborted();
    if (value.orderId !== orderId || value.storeId !== storeId)
      throw new Error('The payment response belongs to another order.');
    setContext(value);
    setRecovering(!!readPaymentRecovery(key));
    setProblem('');
  }, [base, ownerId, orderId, storeId, key]);
  useEffect(() => {
    if (!online) return;
    scope.current = captureOperatorScope(ownerId);
    void refresh().catch((error) => {
      if (!scope.current?.aborted)
        setProblem(error instanceof Error ? error.message : 'Payment state is unavailable.');
    });
  }, [online, ownerId, refresh]);
  async function recoverLegacy() {
    if (lock.current || !context?.legacyPayment) return;
    const signal = captureOperatorScope(ownerId);
    lock.current = true;
    setBusy(true);
    setProblem('');
    try {
      const saved = readPaymentRecovery(key);
      if (saved) {
        setRecovering(true);
        return;
      }
      const input = { operationId: crypto.randomUUID(), ...context.legacyPayment };
      savePaymentRecovery(key, { version: 1, kind: 'legacy', input });
      setRecovering(true);
      await post(base + '/legacy-payment-recoveries', input, paymentSchema, ownerId);
      signal.throwIfAborted();
      await refresh();
    } catch (error) {
      if (!signal.aborted)
        setProblem(
          error instanceof Error
            ? error.message
            : 'Keep the original payment reference and check its state.',
        );
    } finally {
      lock.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  const showPanel = context && (context.activeAttemptId || context.canRecordPayment || recovering);
  return (
    <section aria-label="Order payment actions">
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {!online && <p>Reconnect to review or record an existing order payment.</p>}
      {online && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void refresh().catch((error) =>
              setProblem(error instanceof Error ? error.message : 'Payment state is unavailable.'),
            )
          }
        >
          Refresh payment state
        </button>
      )}
      {!busy && showPanel && (
        <PaymentPanel
          ownerId={ownerId}
          draftId="order-details"
          storeId={storeId}
          orderId={orderId}
          online={online}
          allowNewPayments={context.canRecordPayment}
          onConfirmed={(receipt, origin) => {
            onPaid(receipt, origin);
            void refresh().catch((error) =>
              setProblem(error instanceof Error ? error.message : 'Payment state is unavailable.'),
            );
          }}
        />
      )}
      {online && context?.legacyPayment && !recovering && !context.activeAttemptId && (
        <>
          <p>
            An earlier terminal payment needs confirmation. Recover its original reference before
            taking another payment.
          </p>
          <button className="button primary" disabled={busy} onClick={() => void recoverLegacy()}>
            {busy ? 'Saving original payment…' : 'Recover original terminal payment'}
          </button>
        </>
      )}
      {context?.blocker && !context.activeAttemptId && !recovering && (
        <p role="status">
          This order needs review before another payment can be taken. Reference: {context.blocker}
        </p>
      )}
    </section>
  );
}
