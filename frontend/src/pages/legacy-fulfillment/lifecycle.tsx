import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../api/types';
import { ErrorState } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import {
  awaitingAcceptance,
  cancelReasons,
  deliveryAction,
  deliveryQueryKey,
  passReasons,
  rtoOrder,
  useLocalDeliveryStatus,
} from './client';

type Step = 'accept' | 'pass' | 'cancel' | 'convert';
/**
 * Accept the order (create the courier order), transfer/convert it, cancel it, or convert an
 * RTO order to online: the legacy online order page actions (`show.html:459-1130`).
 */
export function DeliveryLifecyclePanel({
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
    state = useLocalDeliveryStatus(user, storeId, orderId, online),
    [reason, setReason] = useState(''),
    [dropdown, setDropdown] = useState(''),
    [cancelReason, setCancelReason] = useState(''),
    [notice, setNotice] = useState('');
  const run = useMutation({
    mutationFn: (step: Step) => {
      if (!online) throw new Error('Reconnect before changing this delivery.');
      if (step === 'accept') return deliveryAction(user, storeId, orderId, 'courier-requests', {});
      if (step === 'pass')
        return deliveryAction(user, storeId, orderId, 'transfers', {
          reason: reason.trim(),
          reasonDropdown: dropdown,
        });
      if (step === 'cancel')
        return deliveryAction(user, storeId, orderId, 'cancellations', { reason: reason.trim() });
      return deliveryAction(user, storeId, orderId, 'online-conversions', {});
    },
    onSuccess: async (result, step) => {
      setReason('');
      setNotice(
        step === 'accept'
          ? 'Order is created succesfully, Please prepare the package with happiness'
          : result.message,
      );
      await client.invalidateQueries({ queryKey: deliveryQueryKey(user, storeId, orderId) });
    },
    onError: async () => {
      // A failed courier creation may already have started the online conversion.
      await client.invalidateQueries({ queryKey: deliveryQueryKey(user, storeId, orderId) });
    },
  });
  const value = state.data?.data;
  if (!value) return null;
  const busy = run.isPending,
    pending = awaitingAcceptance(value),
    transfer = value.nextStoreIds.length > 0 && !value.transferred;
  return (
    <section className="surface local-delivery-workspace" aria-label="Delivery actions">
      <h3>Delivery actions</h3>
      {notice && <p role="status">{notice}</p>}
      {value.childOrderId && <p>Converted to online order {value.childOrderId}.</p>}
      {pending && (
        <>
          <div className="local-delivery-actions">
            <button
              className="button primary"
              disabled={!online || busy}
              onClick={() => run.mutate('accept')}
            >
              Accept the order
            </button>
          </div>
          {!transfer && value.nextStoreIds.length > 1 && (
            <p>
              This order is alligned to the multiple stores, either you can accept the order or wait
              for the other stores to accept the order or convert to online order
            </p>
          )}
          <fieldset className="local-delivery-note" disabled={!online || busy}>
            <legend>{transfer ? 'Transfer the order' : 'Convert to online order'}</legend>
            <select
              aria-label="Pass reason"
              value={dropdown}
              onChange={(event) => setDropdown(event.target.value)}
            >
              <option value="">Select an Issue</option>
              {passReasons.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <input
              aria-label="Pass message"
              placeholder="Tell us the reason for transferring/converting."
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
            />
            <button
              className="button secondary"
              disabled={!dropdown || !reason.trim()}
              onClick={() => run.mutate('pass')}
              type="button"
            >
              Proceed
            </button>
          </fieldset>
          <fieldset className="local-delivery-note" disabled={!online || busy}>
            <legend>Cancel the order</legend>
            <select
              aria-label="Cancellation reason"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            >
              <option value="">Select Reason</option>
              {cancelReasons.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <input
              aria-label="Cancellation note"
              placeholder="Please tell us the reason for cancellation."
              value={reason}
              maxLength={200}
              onChange={(event) => setReason(event.target.value)}
            />
            <button
              className="button secondary"
              disabled={!cancelReason || !reason.trim()}
              onClick={() => run.mutate('cancel')}
              type="button"
            >
              Cancel the order
            </button>
          </fieldset>
        </>
      )}
      {rtoOrder(value) && !value.childOrderId && value.courier?.action !== 'DECLINED' && (
        <div className="local-delivery-actions">
          <button
            className="button secondary"
            disabled={!online || busy}
            onClick={() => run.mutate('convert')}
          >
            Convert to online order
          </button>
        </div>
      )}
      {!pending && !rtoOrder(value) && <p>No delivery action is pending for this order.</p>}
      {run.isError && <ErrorState error={run.error} />}
    </section>
  );
}
