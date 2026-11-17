import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, captureOperatorScope } from '../../api/client';
import {
  readScreening,
  reconcileScreening,
  abandonScreening,
  closeUnsentScreening,
  screeningAbandonSchema,
  type ScreeningScope,
  type ScreeningView,
} from './client';
const intentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reconcile') }).strict(),
  z.object({ kind: z.literal('close-unsent') }).strict(),
  z.object({ kind: z.literal('close-no-order') }).strict(),
  z.object({ kind: z.literal('abandon'), input: screeningAbandonSchema }).strict(),
]);
type Intent = z.infer<typeof intentSchema>;
export interface ScreeningRecoveryProps {
  scope: ScreeningScope;
  online: boolean;
  disabled?: boolean;
  onPending: (pending: boolean) => void;
  onSaved: () => Promise<void>;
}
export function ScreeningRecovery(props: ScreeningRecoveryProps) {
  return (
    <Recovery
      key={[
        props.scope.operatorId,
        props.scope.storeId,
        props.scope.checkoutId,
        props.scope.operationId,
      ].join(':')}
      {...props}
    />
  );
}
function Recovery({ scope, online, disabled = false, onPending, onSaved }: ScreeningRecoveryProps) {
  const key =
    'pos-screening-recovery:' +
    JSON.stringify([scope.operatorId, scope.storeId, scope.checkoutId, scope.operationId]);
  const [view, setView] = useState<ScreeningView | null>(null),
    [busy, setBusy] = useState(false),
    [intent, setIntent] = useState<Intent | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const alive = useRef(true),
    pending = useRef(onPending),
    saved = useRef(onSaved);
  pending.current = onPending;
  saved.current = onSaved;
  const current = () => {
    const signal = captureOperatorScope(scope.operatorId);
    signal.throwIfAborted();
    return signal;
  };
  function persist(value: Intent) {
    try {
      localStorage.setItem(key, JSON.stringify(intentSchema.parse(value)));
    } catch {
      setStorageBlocked(true);
      pending.current(true);
      throw new Error(
        'The original recovery reference could not be saved. Keep the sale reference.',
      );
    }
    setIntent(value);
    pending.current(true);
  }
  function clearIntent() {
    try {
      localStorage.removeItem(key);
    } catch {
      setStorageBlocked(true);
      /* Retained result remains authoritative. */
    }
    setIntent(null);
    pending.current(false);
  }
  async function adopt(result: ScreeningView, original: Intent | null, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!alive.current) return;
    setView(result);
    const confirmed =
      original &&
      ((original.kind === 'abandon' && result.status === 'abandoned') ||
        ((original.kind === 'close-unsent' || original.kind === 'close-no-order') &&
          (result.status === 'closed-unsent' || result.status === 'closed-no-order')) ||
        (original.kind === 'reconcile' && result.orderId !== null));
    if (confirmed) {
      // A failed parent refresh must not turn a confirmed action into a retry.
      clearIntent();
      setNotice('Original result confirmed. Refreshing this sale.');
      try {
        await saved.current();
        signal.throwIfAborted();
      } catch {
        signal.throwIfAborted();
        if (alive.current) setNotice('Original result confirmed. Refresh the sale to continue.');
      }
    }
  }
  async function check(original: Intent | null = intent) {
    let signal: AbortSignal;
    try {
      signal = current();
    } catch {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await adopt(await readScreening(scope), original, signal);
    } catch (e) {
      if (!signal.aborted && alive.current)
        setError(
          e instanceof ApiError
            ? e.message
            : 'Could not confirm the original screening result. Keep its reference and check again.',
        );
    } finally {
      if (!signal.aborted && alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    let restored: Intent | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) restored = intentSchema.parse(JSON.parse(raw) as unknown);
      setIntent(restored);
      pending.current(Boolean(restored));
    } catch {
      setStorageBlocked(true);
      setError('Saved screening recovery could not be read. Keep the original sale reference.');
      pending.current(true);
    }
    if (online) void check(restored);
    return () => {
      alive.current = false;
      pending.current(false);
    };
    // Every dependency is part of the keyed immutable scope. Reconnection uses
    // the explicit GET control and never repeats a saved action.
  }, []);
  async function action(value: Intent) {
    let signal: AbortSignal;
    try {
      signal = current();
    } catch {
      return;
    }
    if (!online || disabled || busy || intent || storageBlocked) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      persist(value);
      signal.throwIfAborted();
      if (value.kind === 'abandon')
        await adopt(await abandonScreening(scope, value.input), value, signal);
      else if (value.kind === 'reconcile')
        await adopt(await reconcileScreening(scope), value, signal);
      else {
        await closeUnsentScreening(scope);
        signal.throwIfAborted();
        await adopt(await readScreening(scope), value, signal);
      }
    } catch (e) {
      if (!signal.aborted && alive.current)
        setError(
          e instanceof ApiError
            ? e.message
            : 'The original action is awaiting confirmation. Check its status before doing anything else.',
        );
    } finally {
      if (!signal.aborted && alive.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Screening sale recovery" className="checkout-card">
      <h3>Screening sale</h3>
      <p>Reference {scope.operationId}</p>
      {view?.orderId && <p>Order {view.orderId}</p>}
      <p role="status">
        {view?.status === 'completed'
          ? 'Original payment is confirmed.'
          : view?.status === 'abandoned'
            ? 'The original unpaid order is fenced. Its audit is retained.'
            : view?.status === 'closed-unsent'
              ? 'The unsent admission is closed.'
              : view?.status === 'closed-no-order'
                ? 'The source proved that no order was created. The original command is fenced and your cart is retained.'
                : view?.status === 'source-rejected'
                  ? 'The source rejected and fenced the original command without creating an order. Close this admission to continue with the retained cart.'
                  : view?.status === 'awaiting-payment'
                    ? 'The original order exists. Confirm its payment or ask a manager to review the unpaid order.'
                    : 'Keep the original screening reference while its outcome is checked.'}
      </p>
      {view?.publicationStatus && !['accepted', 'cancelled'].includes(view.publicationStatus) && (
        <p>Order notifications are awaiting reconciliation.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <button className="button secondary" disabled={!online || busy} onClick={() => void check()}>
        Check screening status
      </button>
      {view?.orderId && !['completed', 'abandoned'].includes(view.status) && (
        <button
          className="button secondary"
          disabled={!online || disabled || busy || Boolean(intent) || storageBlocked}
          onClick={() => void action({ kind: 'reconcile' })}
        >
          Recover original order
        </button>
      )}
      {view?.status === 'prepared' && (
        <button
          className="button secondary"
          disabled={!online || disabled || busy || Boolean(intent) || storageBlocked}
          onClick={() => void action({ kind: 'close-unsent' })}
        >
          Close expired unsent admission
        </button>
      )}
      {view?.canCloseNoOrder && (
        <button
          className="button secondary"
          disabled={!online || disabled || busy || Boolean(intent) || storageBlocked}
          onClick={() => void action({ kind: 'close-no-order' })}
        >
          Close original command with source proof
        </button>
      )}
      {intent?.kind === 'close-no-order' &&
        view?.canCloseNoOrder &&
        ['source-rejected', 'awaiting-source'].includes(view.status) && (
          <button
            className="button secondary"
            disabled={!online || disabled || busy || storageBlocked}
            onClick={() => {
              // Explicit same-nonce closure retry after GET. It never repeats
              // creation/payment or treats an absent receipt as no-effects proof.
              void (async () => {
                let signal: AbortSignal;
                try {
                  signal = current();
                } catch {
                  return;
                }
                setBusy(true);
                try {
                  await closeUnsentScreening(scope);
                  signal.throwIfAborted();
                  await adopt(await readScreening(scope), intent, signal);
                } catch {
                  if (!signal.aborted && alive.current)
                    setError('The source fence is retained. Check the original closure again.');
                } finally {
                  if (!signal.aborted && alive.current) setBusy(false);
                }
              })();
            }}
          >
            {view.status === 'source-rejected'
              ? 'Finish original closure'
              : 'Retry original closure'}
          </button>
        )}
      {view?.canAbandon && (
        <button
          className="button secondary"
          disabled={!online || disabled || busy || Boolean(intent) || storageBlocked}
          onClick={() =>
            void action({
              kind: 'abandon',
              input: { commandId: crypto.randomUUID(), reason: 'cash-abandoned' },
            })
          }
        >
          Fence unpaid screening order
        </button>
      )}
      {intent && <p>The original action is retained. Checking status never resends it.</p>}
    </section>
  );
}
