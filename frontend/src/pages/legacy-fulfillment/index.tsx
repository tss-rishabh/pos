import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PackageCheck, RefreshCw, RotateCcw } from 'lucide-react';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import {
  deliveryAction,
  deliveryQueryKey,
  legacyId,
  rtoOrder,
  useLocalDeliveryStatus,
} from './client';
import { DeliveryLifecyclePanel } from './lifecycle';
import './style.css';

export function LegacyFulfillmentPage({ user, storeId }: { user: Principal; storeId: string }) {
  const [input, setInput] = useState(''),
    [orderId, setOrderId] = useState(''),
    [error, setError] = useState<Error | null>(null);
  return (
    <>
      <PageTitle title="Local deliveries">
        Accept, pass or cancel a hyperlocal order, pack it, or receive its returning parcel.
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
          {error && <ErrorState error={error} />}
          {orderId && (
            <div key={user.id + ':' + storeId + ':' + orderId} className="local-delivery-layout">
              <LegacyFulfillmentPanel user={user} storeId={storeId} orderId={orderId} />
              <DeliveryLifecyclePanel user={user} storeId={storeId} orderId={orderId} />
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Courier status, Mark packed and RTO received (legacy online order page, `show.html:78-176`). */
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
    [note, setNote] = useState(''),
    [notice, setNotice] = useState(''),
    state = useLocalDeliveryStatus(user, storeId, orderId, online);
  const action = useMutation({
    mutationFn: (kind: 'packing' | 'rto-receipts') => {
      if (!online) throw new Error('Reconnect before recording fulfillment.');
      return deliveryAction(user, storeId, orderId, kind, { note: note.trim() });
    },
    onSuccess: async (result, kind) => {
      setNote('');
      setNotice(
        kind === 'packing'
          ? 'Packing recorded.'
          : result.alreadyRecorded === true
            ? 'This return was already received. Stock was not changed again.'
            : 'Return received and stock restored to the store.',
      );
      await client.invalidateQueries({ queryKey: deliveryQueryKey(user, storeId, orderId) });
    },
  });
  const value = state.data?.data,
    courier = value?.courier,
    busy = action.isPending;
  const canPack = courier?.action === 'ACCEPTED' && !courier.packed,
    canReceive = !!value && rtoOrder(value) && !courier?.rtoReceived;
  return (
    <section className="surface local-delivery-workspace" aria-label="Local delivery workspace">
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
                <p>Courier {courier?.courierOrderId || 'not created'}</p>
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
              <strong>{courier?.action || 'No courier record'}</strong>
              {courier?.action === 'ACCEPTED' && <> · {courier.packed ? 'Packed' : 'Not packed'}</>}
              {rtoOrder(value) && (
                <> · {courier?.rtoReceived ? 'RTO received' : 'RTO not received'}</>
              )}
            </p>
            <p>{value.check.status === '200' ? value.check.message : value.check.error}</p>
            <div className="local-delivery-links">
              {courier?.sourceTrackingUrl && (
                <a
                  href={courier.sourceTrackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Source tracking
                </a>
              )}
              {courier?.destinationTrackingUrl && (
                <a
                  href={courier.destinationTrackingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  Destination tracking
                </a>
              )}
            </div>
            {(canPack || canReceive) && (
              <>
                <label className="local-delivery-note">
                  {canPack ? 'Packing note' : 'RTO note'}
                  <textarea
                    aria-label="Local delivery note"
                    value={note}
                    maxLength={200}
                    rows={3}
                    disabled={busy}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <div className="local-delivery-actions">
                  {canPack && (
                    <button
                      className="button primary"
                      disabled={!online || busy || !note.trim()}
                      onClick={() => action.mutate('packing')}
                    >
                      <PackageCheck size={16} />
                      Mark packed
                    </button>
                  )}
                  {canReceive && (
                    <button
                      className="button primary"
                      disabled={!online || busy || !note.trim()}
                      onClick={() => action.mutate('rto-receipts')}
                    >
                      <RotateCcw size={16} />
                      {busy ? 'Recording…' : 'RTO received'}
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )
      )}
      {action.isError && <ErrorState error={action.error} />}
    </section>
  );
}
