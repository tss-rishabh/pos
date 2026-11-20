import { Check, RefreshCw } from 'lucide-react';
import { RequestReference } from '../../components/common';
import type { CheckoutReviewView } from './useCheckoutReview';

/** The status and recovery messages above the sale. */
export function renderCheckoutStatus(view: CheckoutReviewView) {
  const {
    online,
    onCheckoutCleared,
    recoveryNotice,
    checkout,
    busy,
    problem,
    problemCause,
    notice,
    setNotice,
    pendingId,
    recoveryError,
    notifiedClear,
    notifyClear,
    act,
    mutate,
    start,
    recover,
    disabled,
  } = view;
  return (
    <div className="checkout-status">
      {recoveryNotice && (
        <p role="status" className="caption">
          {recoveryNotice}
        </p>
      )}
      {recoveryError && (
        <p role="alert" className="inline-error">
          {recoveryError}
        </p>
      )}
      {!online && (
        <p role="status">
          Your draft is saved on this device. Reconnect to confirm prices, benefits and payment.
        </p>
      )}
      {problem && (
        <p role="alert" className="inline-error">
          {problem}
        </p>
      )}
      {problem && <RequestReference error={problemCause} />}
      {notice && (
        <p role="status" className="sync-message">
          <Check size={16} />
          {notice}
        </p>
      )}
      {pendingId && (
        <div>
          <p>The last action is awaiting confirmation. Reference {pendingId}.</p>
          <button
            className="button secondary"
            disabled={disabled}
            onClick={() => void act(recover)}
          >
            <RefreshCw size={16} /> Check action status
          </button>
        </div>
      )}
      {checkout?.draftImport?.status === 'pending' &&
        !pendingId &&
        checkout.phase !== 'uncertain' && (
          <div>
            <p>Every saved line must be confirmed before this sale can be quoted.</p>
            <button
              className="button primary full"
              disabled={disabled}
              onClick={() => void act(start)}
            >
              Finish loading saved sale
            </button>
          </div>
        )}
      {checkout?.phase === 'uncertain' && !checkout.orderId && (
        <p role="alert">
          This sale needs administrator review before another order or payment can be attempted.
          Checkout reference: {checkout.id}.
        </p>
      )}
      {checkout?.phase === 'cleared' && (
        <div>
          <p role="status">
            This checkout is cleared. Its original items cannot be submitted again.
          </p>
          {checkout.lastClear && onCheckoutCleared && (
            <button
              className="button secondary full"
              disabled={busy || Boolean(recoveryError)}
              onClick={() => {
                notifiedClear.current = null;
                notifyClear(checkout.lastClear!);
              }}
            >
              Finish clearing this device
            </button>
          )}
          {!checkout.lastClear && (
            <p role="alert">
              The original draft binding is unavailable. Keep the local cart and review this
              reference.
            </p>
          )}
        </div>
      )}
      {checkout?.registrationRequestRecovery && (
        <div>
          <p>The registration delivery is saved, but its checkout checkpoint was interrupted.</p>
          <button
            className="button secondary full"
            disabled={disabled}
            onClick={() =>
              void act(async () => {
                await mutate('customer-registration-request-reconciliations', 'POST');
                setNotice('The queued registration request is recovered. No new message was sent.');
              })
            }
          >
            Recover queued registration request
          </button>
        </div>
      )}
      {checkout?.orderId &&
        ['order-created', 'uncertain'].includes(checkout.phase) &&
        ['dispatching', 'acknowledged'].includes(checkout.confirmationPhase ?? '') && (
          <div>
            <p>
              Order {checkout.orderId} has a saved confirmation reference. Check its committed stock
              and wallet updates before continuing.
            </p>
            <button
              className="button secondary full"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await mutate('confirmation-reconciliations', 'POST');
                  setNotice('The saved confirmation is proved and order preparation is complete.');
                })
              }
            >
              Reconcile saved confirmation
            </button>
          </div>
        )}
      {checkout?.phase === 'order-created' && (
        <div role="status">
          <p>
            Order {checkout.orderId} is saved.{' '}
            {checkout.confirmationPhase === 'acknowledged'
              ? 'Invoice preparation needs to finish before payment can continue.'
              : 'Its confirmation needs administrator review before payment can continue.'}
          </p>
          {checkout.confirmationPhase === 'acknowledged' && (
            <button
              className="button secondary full"
              disabled={disabled || Boolean(pendingId) || Boolean(checkout.busyOperationId)}
              onClick={() =>
                void act(async () => {
                  await mutate('order-finalizations', 'POST');
                })
              }
            >
              Finish order preparation
            </button>
          )}
        </div>
      )}
    </div>
  );
}
