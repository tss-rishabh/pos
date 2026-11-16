import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, captureOperatorScope } from '../../api/client';
import {
  acknowledgeOrderCopy,
  continueOrderCopy,
  currentOrderCopy,
  prepareOrderCopy,
  readOrderCopy,
  readOrderCopyReview,
  startOrderCopy,
  type CopyCommand,
  type CopyReview,
  type CopySource,
  type OrderCopyScope,
} from './client';
import { markOrderCopyOrigin } from './marker';

const intentSchema = z
  .object({
    reviewId: z.uuid().optional(),
    copy: z
      .object({
        operationId: z.uuid(),
        reviewId: z.uuid(),
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    acknowledgement: z
      .object({
        operationId: z.uuid(),
        expectedVersion: z.number().int().nonnegative(),
        resultHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
type Intent = z.infer<typeof intentSchema>;
export interface OrderCopyPanelProps {
  scope: OrderCopyScope;
  checkoutVersion: number;
  online: boolean;
  disabled?: boolean;
  onPending: (value: boolean) => void;
  onSaved: () => Promise<void>;
}
export function OrderCopyPanel(props: OrderCopyPanelProps) {
  const key = [
    props.scope.operatorId,
    props.scope.storeId,
    props.scope.checkoutId,
    props.scope.customerId,
  ].join(':');
  return <CopyPanel key={key} {...props} />;
}
function CopyPanel({
  scope,
  checkoutVersion,
  online,
  disabled = false,
  onPending,
  onSaved,
}: OrderCopyPanelProps) {
  const key =
    'pos-order-copy:' +
    JSON.stringify([scope.operatorId, scope.storeId, scope.checkoutId, scope.customerId]);
  const [orderId, setOrderId] = useState(''),
    [sourceKind, setSourceKind] = useState<'store' | 'customer'>('store'),
    [sourceStore, setSourceStore] = useState(scope.storeId);
  const [review, setReview] = useState<CopyReview | null>(null),
    [command, setCommand] = useState<CopyCommand | null>(null),
    [intent, setIntent] = useState<Intent>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [missing, setMissing] = useState(false),
    [loaded, setLoaded] = useState(false);
  const alive = useRef(true),
    pendingCallback = useRef(onPending),
    savedCallback = useRef(onSaved),
    intentRef = useRef<Intent>({});
  pendingCallback.current = onPending;
  savedCallback.current = onSaved;
  function save(value: Intent) {
    // Persist opaque IDs/version/hash only, before dispatch. A storage failure
    // blocks new work; a confirmed action is never undone by optional cleanup.
    localStorage.setItem(key, JSON.stringify(intentSchema.parse(value)));
    intentRef.current = value;
    setIntent(value);
  }
  function clear() {
    try {
      localStorage.removeItem(key);
    } catch {
      /* optional cleanup */
    }
    intentRef.current = {};
    setIntent({});
  }
  async function adopted(value: CopyCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!alive.current) return;
    markOrderCopyOrigin(scope.operatorId, scope.storeId, scope.checkoutId, value.id);
    setCommand(value);
    setReview(null);
    setMissing(false);
    if (value.status === 'acknowledged') clear();
    if (value.status === 'review-required' || value.status === 'acknowledged') {
      try {
        await savedCallback.current();
        signal.throwIfAborted();
      } catch {
        if (alive.current && !signal.aborted)
          setError('The copy is saved. Refresh the checkout before continuing.');
      }
    }
  }
  async function refresh() {
    const signal = captureOperatorScope(scope.operatorId);
    setBusy(true);
    setError(null);
    try {
      const pending = intentRef.current;
      if (pending.copy) {
        try {
          await adopted(await readOrderCopy(scope, pending.copy.operationId), signal);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            signal.throwIfAborted();
            setMissing(true);
            setCommand(null);
          } else throw error;
        }
      } else {
        const current = await currentOrderCopy(scope);
        signal.throwIfAborted();
        if (current) await adopted(current, signal);
        else if (pending.reviewId) {
          const value = await readOrderCopyReview(scope, pending.reviewId);
          signal.throwIfAborted();
          setReview(value);
        }
      }
      signal.throwIfAborted();
      setLoaded(true);
    } catch {
      if (alive.current && !signal.aborted)
        setError('The original copy could not be read. Keep its reference and refresh.');
    } finally {
      if (alive.current && !signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    try {
      const value = localStorage.getItem(key);
      const saved = value ? intentSchema.parse(JSON.parse(value) as unknown) : {};
      intentRef.current = saved;
      setIntent(saved);
    } catch {
      setError(
        'Saved copy recovery is unreadable. Keep its reference before starting another copy.',
      );
      return;
    }
    if (online) void refresh();
    else setLoaded(true);
    return () => {
      alive.current = false;
      pendingCallback.current(false);
    };
    // Scope is isolated by the keyed wrapper. Callbacks use current refs.
  }, [key, online]);
  useEffect(() => {
    const active =
      busy ||
      Boolean(intent.copy && (!command || command.status !== 'acknowledged')) ||
      Boolean(command && command.status !== 'acknowledged');
    pendingCallback.current(active);
  }, [busy, intent.copy, command]);
  async function act(action: (signal: AbortSignal) => Promise<void>) {
    if (!online || disabled || busy) return;
    const signal = captureOperatorScope(scope.operatorId);
    setBusy(true);
    setError(null);
    try {
      await action(signal);
      signal.throwIfAborted();
    } catch {
      if (alive.current && !signal.aborted)
        setError(
          'The action reply is unconfirmed. Refresh the original operation before doing anything else.',
        );
    } finally {
      if (alive.current && !signal.aborted) setBusy(false);
    }
  }
  async function prepare() {
    await act(async (signal) => {
      const source: CopySource =
        sourceKind === 'customer'
          ? { kind: 'customer', orderId }
          : { kind: 'store', storeId: sourceStore, orderId };
      const reviewId = crypto.randomUUID();
      save({ reviewId });
      const value = await prepareOrderCopy(scope, {
        reviewId,
        expectedVersion: checkoutVersion,
        source,
      });
      signal.throwIfAborted();
      setReview(value);
      setCommand(null);
      setMissing(false);
    });
  }
  async function copy() {
    if (!review) return;
    await act(async (signal) => {
      const body = {
        operationId: crypto.randomUUID(),
        reviewId: review.id,
        manifestHash: review.hash,
        expectedVersion: review.checkoutVersion,
      };
      save({ reviewId: review.id, copy: body });
      markOrderCopyOrigin(scope.operatorId, scope.storeId, scope.checkoutId, body.operationId);
      await adopted(await startOrderCopy(scope, body), signal);
    });
  }
  async function retry() {
    const body = intent.copy;
    if (!body) return;
    await act(async (signal) => {
      markOrderCopyOrigin(scope.operatorId, scope.storeId, scope.checkoutId, body.operationId);
      return adopted(await startOrderCopy(scope, body), signal);
    });
  }
  async function acknowledge() {
    if (!command?.resultHash) return;
    await act(async (signal) => {
      const body = intentRef.current.acknowledgement ?? {
        operationId: crypto.randomUUID(),
        expectedVersion: command.checkoutVersion,
        resultHash: command.resultHash!,
      };
      save({ ...intentRef.current, acknowledgement: body });
      await adopted(await acknowledgeOrderCopy(scope, command.id, body), signal);
    });
  }
  async function continueCopy() {
    if (!command?.canContinue) return;
    await act(async (signal) => {
      await adopted(
        await continueOrderCopy(scope, command.id, {
          operationId: crypto.randomUUID(),
          expectedVersion: command.checkoutVersion,
        }),
        signal,
      );
    });
  }
  const active =
    Boolean(command && command.status !== 'acknowledged') || Boolean(intent.copy && !command);
  const controls = disabled || busy || !online || !loaded;
  return (
    <section aria-label="Copy a previous order">
      <h3>Copy a previous order</h3>
      <p>Adds one unit per original order line. Current stock and prices apply.</p>
      {!online && <p role="status">Connect to review and copy an order.</p>}
      {error && <p role="alert">{error}</p>}
      {!active && (
        <div>
          <label>
            Source order ID
            <input
              value={orderId}
              onChange={(event) => setOrderId(event.target.value)}
              inputMode="numeric"
              disabled={controls}
            />
          </label>
          <label>
            Source scope
            <select
              value={sourceKind}
              onChange={(event) =>
                setSourceKind(event.target.value === 'customer' ? 'customer' : 'store')
              }
              disabled={controls}
            >
              <option value="store">An allowed store</option>
              <option value="customer">This connected customer</option>
            </select>
          </label>
          {sourceKind === 'store' && (
            <label>
              Source store ID
              <input
                inputMode="numeric"
                value={sourceStore}
                onChange={(event) => setSourceStore(event.target.value)}
                disabled={controls}
              />
            </label>
          )}
          <button
            type="button"
            disabled={
              controls ||
              !/^[1-9]\d{0,19}$/.test(orderId) ||
              (sourceKind === 'store' && !/^[1-9]\d{0,19}$/.test(sourceStore))
            }
            onClick={() => void prepare()}
          >
            Review order products
          </button>
        </div>
      )}
      {review && !active && (
        <div>
          <ul>
            {review.steps.map((step) => (
              <li key={step.id}>
                Product {step.productId}: {step.beforeQuantity} → {step.targetQuantity} (
                {step.sourceLineIds.length} original lines)
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={
              controls ||
              review.expiresAt <= Date.now() ||
              review.checkoutVersion !== checkoutVersion
            }
            onClick={() => void copy()}
          >
            Copy reviewed products
          </button>
        </div>
      )}
      {command && (
        <div>
          <p role="status">Copy status: {command.status}</p>
          <p>
            Reference: <code>{command.id}</code>
          </p>
          {command.partial && (
            <p role="alert">
              Some products were unavailable or the cart changed. Review the actual saved contents.
            </p>
          )}
          {command.partial && (
            <ul>
              {command.steps
                .filter((step) => step.status !== 'confirmed')
                .map((step) => (
                  <li key={step.id}>
                    Product {step.productId}:{' '}
                    {step.status === 'unavailable' ? 'unavailable' : 'not copied'}
                  </li>
                ))}
            </ul>
          )}
          {command.result && (
            <ul>
              {command.result.map((line, index) => (
                <li key={[line.kind, line.productId, line.identity, index].join(':')}>
                  {line.name || 'Product ' + line.productId}: {line.quantity}
                  {line.price !== null ? ' · ' + line.price : ' · see fresh quote'}
                </li>
              ))}
            </ul>
          )}
          {command.status === 'review-required' && (
            <button type="button" disabled={controls} onClick={() => void acknowledge()}>
              Accept copied cart for quoting
            </button>
          )}
          {command.canContinue && (
            <button type="button" disabled={controls} onClick={() => void continueCopy()}>
              Continue undispatched copy steps
            </button>
          )}
          {command.status === 'uncertain' && (
            <p>
              The dispatched addition needs reconciliation. Its quantities alone cannot confirm the
              operation.
            </p>
          )}
        </div>
      )}
      {(active || intent.reviewId || error) && (
        <button type="button" disabled={!online || busy} onClick={() => void refresh()}>
          Refresh original copy
        </button>
      )}
      {missing && intent.copy && (
        <button type="button" disabled={controls} onClick={() => void retry()}>
          Retry exact saved copy
        </button>
      )}
    </section>
  );
}
export { orderCopyRequiresOnlineReview, clearOrderCopyOrigin } from './marker';
