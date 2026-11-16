import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, RefreshCw, RotateCcw } from 'lucide-react';
import { z } from 'zod';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { legacyId, legacyState, type LegacyAction, type LegacyReceipt } from './contracts';
import { checkSavedLegacyCommand, sendLegacyCommand } from './commands';
import { DeliveryLifecyclePanel } from './lifecycle';
import './style.css';
const fingerprint = (user: Principal) =>
  JSON.stringify([user.id, user.role, user.userType, [...new Set(user.storeIds)].sort()]);

export function LegacyFulfillmentPage({ user, storeId }: { user: Principal; storeId: string }) {
  const [input, setInput] = useState(''),
    [orderId, setOrderId] = useState(''),
    [error, setError] = useState<Error | null>(null);
  return (
    <>
      <PageTitle eyebrow="COURIER FULFILLMENT" title="Local deliveries">
        Check courier status, pack an accepted order or receive its returning parcel.
      </PageTitle>
      {!storeId ? (
        <Empty title="Select a store">Choose the store responsible for this order.</Empty>
      ) : (
        <>
          <form
            className="filters"
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = legacyId.safeParse(input.trim());
              if (!parsed.success) {
                setError(new Error('Enter a valid order ID.'));
                return;
              }
              setError(null);
              setOrderId(parsed.data);
            }}
          >
            <label>
              Order ID
              <input
                aria-label="Local delivery order ID"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                inputMode="numeric"
                maxLength={20}
              />
            </label>
            <button className="button primary" type="submit">
              View fulfillment
            </button>
          </form>
          {error && <ErrorState error={error} />}{' '}
          {orderId && (
            <div
              key={fingerprint(user) + ':' + storeId + ':' + orderId}
              className="local-delivery-layout"
            >
              <LegacyFulfillmentPanel user={user} storeId={storeId} orderId={orderId} />
              <DeliveryLifecyclePanel user={user} storeId={storeId} orderId={orderId} />
            </div>
          )}
        </>
      )}
    </>
  );
}
export function LegacyFulfillmentPanel({
  user,
  storeId,
  orderId,
}: {
  user: Principal;
  storeId: string;
  orderId: string;
}) {
  const online = useOnline(),
    client = useQueryClient(),
    controller = useRef<AbortController | null>(null),
    [note, setNote] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [receipt, setReceipt] = useState<LegacyReceipt | null>(null),
    [notice, setNotice] = useState('');
  const scope = fingerprint(user) + ':' + storeId + ':' + orderId;
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    return () => {
      current.abort();
      if (controller.current === current) controller.current = null;
    };
  }, [scope]);
  const queryKey = [user.id, 'legacy-fulfillment', scope],
    state = useQuery({
      queryKey,
      enabled: online,
      retry: false,
      gcTime: 0,
      queryFn: ({ signal }) => {
        legacyId.parse(storeId);
        legacyId.parse(orderId);
        return request(
          `/api/v1/stores/${storeId}/legacy-fulfillment/orders/${orderId}`,
          { operatorId: user.id, signal, cache: 'no-store' },
          z.object({ data: legacyState }),
        );
      },
      refetchInterval: (query) => (query.state.data?.data.action === 'NO_ACTION' ? 5000 : false),
    });
  const refresh = () => client.invalidateQueries({ queryKey }),
    action = useMutation({
      mutationFn: async (kind: LegacyAction) => {
        const signal = controller.current?.signal;
        if (!signal || signal.aborted)
          throw new DOMException('The fulfillment workspace changed.', 'AbortError');
        if (!online) throw new Error('Reconnect before recording fulfillment.');
        return sendLegacyCommand(user.id, storeId, orderId, kind, note, signal);
      },
      onSuccess: async (result) => {
        setReceipt(result);
        setConfirmed(false);
        setNotice(
          result.outcome === 'packed'
            ? 'Packing recorded.'
            : result.outcome === 'rto-received'
              ? result.restoredUnits === '0' && result.originalCommandId
                ? 'Return received. Inventory was already restored by the earlier cancellation.'
                : `Return received. ${result.restoredUnits} units restored to this store.`
              : result.recordedBy === 'legacy'
                ? 'An earlier record already marks this action complete. Stock was not changed.'
                : 'This return was already recorded. Stock was not changed.',
        );
        await refresh();
      },
    }),
    recover = useMutation({
      mutationFn: async () => {
        const signal = controller.current?.signal;
        if (!signal) throw new DOMException('The workspace changed.', 'AbortError');
        for (const kind of ['packing', 'rto-receipt'] as const) {
          const result = await checkSavedLegacyCommand(user.id, storeId, orderId, kind, signal);
          signal.throwIfAborted();
          if (result) setReceipt(result);
        }
        return true;
      },
      onSuccess: async () => {
        setNotice(
          'Saved command receipts checked. Unconfirmed requests retain their original command ID.',
        );
        await refresh();
      },
    });
  const value = state.data?.data,
    busy = action.isPending || recover.isPending,
    packed = value?.packed || receipt?.outcome === 'packed',
    received = value?.rtoReceived || receipt?.action === 'rto-receipt';
  return (
    <section
      className="surface local-delivery-workspace"
      style={{ padding: '1.25rem' }}
      aria-label="Local delivery workspace"
    >
      {!online && (
        <p role="status">Reconnect to check current courier status or record an action.</p>
      )}
      {notice && <p role="status">{notice}</p>}
      {state.isError ? (
        <ErrorState error={state.error} retry={() => void state.refetch()} />
      ) : state.isPending ? (
        online ? (
          <Loading />
        ) : (
          <Empty title="Current status unavailable">Connect to continue.</Empty>
        )
      ) : (
        value && (
          <>
            <div className="page-heading">
              <div>
                <h2>Order {orderId}</h2>
                <p>
                  {value.reference || 'No order reference'} · Courier{' '}
                  {value.borzoId || 'Not created'}
                </p>
              </div>
              <button
                className="button secondary"
                disabled={!online || busy || state.isFetching}
                onClick={() => void state.refetch()}
              >
                <RefreshCw size={16} />
                Refresh status
              </button>
            </div>
            <p>
              <strong>{value.action || 'No courier record'}</strong> ·{' '}
              {packed ? 'Packed' : 'Not packed'} ·{' '}
              {received ? 'Return already received' : 'Return not received'}
            </p>
            {value.sourceStatus.error && <p>{value.sourceStatus.error}</p>}
            <div style={{ display: 'flex', gap: '1rem' }}>
              {value.tracking.source && (
                <a
                  href={value.tracking.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Source tracking
                </a>
              )}
              {value.tracking.destination && (
                <a
                  href={value.tracking.destination}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Destination tracking
                </a>
              )}
            </div>
            {!value.checkedIn && (
              <p role="status">Check in to this store before recording fulfillment.</p>
            )}
            {value.workflowPending && (
              <p role="status">
                A delivery command is in progress. Check its outcome before recording another
                action.
              </p>
            )}
            {value.reconciliationRequired && (
              <p role="alert">
                The courier or inventory records need reconciliation before a return can be
                received. Ask an administrator to review them.
              </p>
            )}
            <h3>Returning items</h3>
            {value.returnLines.length ? (
              <div className="table-wrap">
                <table aria-label="Returning delivery line items">
                  <thead>
                    <tr>
                      <th>Line ID</th>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {value.returnLines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.id}</td>
                        <td>{line.productId}</td>
                        <td>{line.name || 'Unavailable product'}</td>
                        <td>{line.quantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No returning lines are available.</p>
            )}
            {value.split && (
              <p>
                {value.excludedLineCount} online line(s) in this split order are excluded from the
                courier return.
              </p>
            )}
            {value.linesTruncated && (
              <p role="alert">This order needs inventory reconciliation before receiving.</p>
            )}
            <label className="local-delivery-note">
              Fulfillment note
              <textarea
                aria-label="Local delivery note"
                value={note}
                maxLength={value.maxNoteCharacters}
                rows={3}
                disabled={busy}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <label className="local-delivery-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I checked the returning parcel and the line quantities shown above.
            </label>
            <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', marginBlock: '1rem' }}>
              <button
                className="button secondary"
                disabled={!online || busy || !value.canPack || !!packed}
                onClick={() => action.mutate('packing')}
              >
                <PackageCheck size={16} />
                Mark packed
              </button>
              <button
                className="button primary"
                disabled={!online || busy || !value.canReceiveRto || !!received || !confirmed}
                onClick={() => action.mutate('rto-receipt')}
              >
                <RotateCcw size={16} />
                {action.isPending ? 'Recording…' : 'Receive returning parcel'}
              </button>
              <button
                className="button secondary"
                disabled={!online || busy}
                onClick={() => recover.mutate()}
              >
                Check saved command
              </button>
            </div>
            {!value.rtoReady && value.rtoEligible && !received && (
              <p role="status">Receiving is unavailable. Contact the inventory administrator.</p>
            )}
          </>
        )
      )}
      {action.isError && <ErrorState error={action.error} />}{' '}
      {recover.isError && <ErrorState error={recover.error} />}{' '}
      {receipt && (
        <aside className="local-delivery-receipt" aria-label="Fulfillment command receipt">
          <h3>Command receipt</h3>
          <p>
            <code>{receipt.commandId}</code> · Operator {receipt.actorId}
          </p>
          <p>
            {receipt.integrationState === 'pending'
              ? 'Inventory was recorded. Product synchronization is pending.'
              : receipt.integrationState === 'delivered'
                ? 'Product synchronization confirmed.'
                : receipt.integrationState === 'unconfirmed'
                  ? 'Inventory was recorded. Synchronization evidence needs reconciliation.'
                  : 'No external synchronization was required.'}
          </p>
          {receipt.steps.length > 0 && (
            <p>
              {receipt.steps
                .map(
                  (step) =>
                    `Line ${step.hasProductId}: SKU ${step.productId} ${step.before} → ${step.after}`,
                )
                .join('; ')}
            </p>
          )}
        </aside>
      )}
    </section>
  );
}
