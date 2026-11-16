import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Principal } from '../../api/types';
import { captureOperatorScope, request } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { useOnline } from '../../hooks/use-pos';
import { maintenanceReceipt } from './maintenance-contracts';
import { completeMaintenanceMarker } from './maintenance-commands';
function timestamp(value: string) {
  return new Date(value.replace(' ', 'T') + 'Z').toLocaleString();
}
export function MaintenanceReceiptView({ user, id }: { user: Principal; id: string }) {
  const online = useOnline(),
    client = useQueryClient(),
    [verified, setVerified] = useState(false),
    decisions = useRef(new Map<string, string>());
  const receipt = useQuery({
    queryKey: [user.id, 'catalog-maintenance-command', id],
    queryFn: ({ signal }) =>
      request(
        `/api/v1/catalog/maintenance-commands/${id}`,
        { operatorId: user.id, signal },
        maintenanceReceipt,
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data && ['PENDING', 'RUNNING'].includes(query.state.data.state) ? 3000 : false,
  });
  const reconcile = useMutation({
    mutationFn: ({
      deliveryId,
      outcome,
    }: {
      deliveryId: string;
      outcome: 'delivered' | 'not-delivered';
    }) => {
      const signal = captureOperatorScope(user.id),
        delivery = receipt.data?.deliveries.find((value) => value.id === deliveryId);
      if (!delivery || delivery.state !== 'UNCERTAIN')
        throw new Error('Refresh the maintenance outcome before confirming it.');
      const key = deliveryId + ':' + delivery.updatedAt + ':' + outcome,
        reconciliationId = decisions.current.get(key) || crypto.randomUUID();
      decisions.current.set(key, reconciliationId);
      return request(
        `/api/v1/catalog/maintenance-commands/${id}/deliveries/${deliveryId}/reconciliation`,
        {
          method: 'POST',
          operatorId: user.id,
          signal,
          body: JSON.stringify({ reconciliationId, outcome }),
        },
        maintenanceReceipt,
      );
    },
    onSuccess: async () => {
      setVerified(false);
      await client.invalidateQueries({ queryKey: [user.id, 'catalog-maintenance-command', id] });
      await client.invalidateQueries({ queryKey: [user.id, 'catalog-maintenance-active'] });
    },
  });
  useEffect(() => {
    if (receipt.data) {
      completeMaintenanceMarker(user.id, receipt.data);
      if (receipt.data.state === 'SUCCEEDED') {
        void client.invalidateQueries({ queryKey: [user.id, 'catalog-product-detail'] });
        void client.invalidateQueries({ queryKey: [user.id, 'catalog-stock-matrix'] });
      }
    }
  }, [receipt.data, user.id, client]);
  if (receipt.isPending) return <Loading />;
  if (receipt.isError)
    return <ErrorState error={receipt.error} retry={() => void receipt.refetch()} />;
  const value = receipt.data;
  return (
    <section className="surface catalog-detail-block">
      <div className="catalog-table-toolbar">
        <h2>Maintenance request</h2>
        <strong role="status">
          {value.state === 'SUCCEEDED'
            ? 'Acknowledged by service'
            : value.state === 'UNCERTAIN'
              ? 'Outcome needs confirmation'
              : value.state === 'FAILED'
                ? 'Could not complete'
                : value.state === 'RUNNING'
                  ? 'Delivery in progress'
                  : 'Queued'}
        </strong>
        <button
          className="button secondary"
          disabled={!online || receipt.isFetching}
          onClick={() => void receipt.refetch()}
        >
          Refresh status
        </button>
      </div>
      <p className="muted">
        Request {value.id} · {timestamp(value.createdAt)}
      </p>
      <p>
        {value.metadata.matchedCount} SKU(s) selected from {value.metadata.requestedCount} submitted
        row(s).
      </p>
      {value.localApplied && (
        <p>
          Local repair committed: {value.metadata.parentRowsChanged} parent stock visibility row(s),{' '}
          {value.metadata.barcodeRowsChanged} barcode row(s)
          {value.metadata.imageReset ? ', empty image metadata initialized' : ''}. Product
          synchronization is tracked below.
        </p>
      )}
      {value.errorCode && (
        <p role="alert">
          {value.errorCode.replaceAll('_', ' ').toLowerCase()}. Check the request before submitting
          another operation.
        </p>
      )}
      {reconcile.isError && <ErrorState error={reconcile.error} />}
      <div className="catalog-maintenance-deliveries">
        {value.deliveries.map((delivery) => (
          <article key={delivery.id}>
            <strong>
              Delivery {delivery.ordinal + 1} · {delivery.state.toLowerCase()}
            </strong>
            <details>
              <summary>{delivery.productIds.length} SKU(s)</summary>
              <p className="catalog-maintenance-ids">{delivery.productIds.join(', ')}</p>
            </details>
            {delivery.state === 'UNCERTAIN' && (
              <>
                <p>
                  The service may have accepted this delivery. Check its result before choosing an
                  outcome.
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={verified}
                    disabled={!online || reconcile.isPending}
                    onChange={(event) => setVerified(event.target.checked)}
                  />
                  I checked the outcome with the service.
                </label>
                <div className="catalog-table-toolbar">
                  <button
                    className="button secondary"
                    disabled={!verified || !online || reconcile.isPending}
                    onClick={() =>
                      reconcile.mutate({ deliveryId: delivery.id, outcome: 'delivered' })
                    }
                  >
                    Confirm accepted
                  </button>
                  <button
                    className="button secondary"
                    disabled={!verified || !online || reconcile.isPending}
                    onClick={() =>
                      reconcile.mutate({ deliveryId: delivery.id, outcome: 'not-delivered' })
                    }
                  >
                    Confirm not accepted and allow retry
                  </button>
                </div>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
