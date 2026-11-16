import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { AlertCircle, Box, Check, Clock3, PackageCheck, RefreshCw, Truck, X } from 'lucide-react';
import { params, request } from '../../api/client';
import type { Principal } from '../../api/types';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { currency } from '../../lib/format';
import { useOnline } from '../../hooks/use-pos';
import './style.css';
import { sendFulfillmentCommand } from './commands';
import { ShippingLabelAction } from './shipping-label';

const tabs = [
  ['in_queue', 'In queue'],
  ['not_packed', 'To pack'],
  ['packed', 'Packed'],
  ['shipped', 'Shipped'],
] as const;
const lineSchema = z.object({
  id: z.string(),
  hasProductId: z.string(),
  productName: z.string().nullable(),
  quantity: z.string().nullable(),
  status: z.string().nullable(),
  productStatus: z.string().nullable(),
  awb: z.string().nullable(),
});
const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      reference: z.string(),
      expiresAt: z.string().nullable(),
      customer: z.object({
        name: z.string(),
        phone: z.string(),
        address1: z.string(),
        address2: z.string(),
        city: z.string(),
        postalCode: z.string(),
      }),
      lines: z.array(lineSchema),
      storeOrderAmount: z.number(),
      isVincAllocated: z.boolean(),
      hasShipmentId: z.boolean(),
      hasAwb: z.boolean(),
      isRto: z.boolean(),
      canMarkRto: z.boolean(),
    }),
  ),
  hasMore: z.boolean(),
  nextOffset: z.number(),
});
const summarySchema = z.object({
  tabCounts: z.record(z.string(), z.number()),
  orderIds: z.record(z.string(), z.array(z.string())),
});
type Tab = (typeof tabs)[number][0];
export function FulfillmentPage({ user, storeId }: { user: Principal; storeId: string }) {
  const client = useQueryClient();
  const online = useOnline();
  const [tab, setTab] = useState<Tab>('in_queue'),
    [offset, setOffset] = useState(0),
    [notice, setNotice] = useState(''),
    [reject, setReject] = useState(''),
    [reason, setReason] = useState('');
  useEffect(() => {
    setOffset(0);
    setNotice('');
  }, [storeId, tab]);
  const summary = useQuery({
    queryKey: [user.id, 'fulfillment-summary', storeId],
    enabled: !!storeId,
    queryFn: () => request(`/api/v1/stores/${storeId}/fulfillment/summary`, {}, summarySchema),
    refetchInterval: 15000,
  });
  const page = useQuery({
    queryKey: [user.id, 'fulfillment-orders', storeId, tab, offset],
    enabled: !!storeId,
    queryFn: () =>
      request(
        `/api/v1/stores/${storeId}/fulfillment/orders?${params({ tab, offset: String(offset) })}`,
        {},
        pageSchema,
      ),
    refetchInterval: 15000,
  });
  const reasons = useQuery({
    queryKey: [user.id, 'fulfillment-rejection-reasons'],
    enabled: !!reject,
    queryFn: () =>
      request(
        '/api/v1/fulfillment/rejection-reasons',
        {},
        z.object({ data: z.array(z.object({ id: z.string(), reason: z.string() })) }),
      ),
  });
  const alerts = useQuery({
    queryKey: [user.id, 'fulfillment-expiry-alerts', storeId],
    enabled: !!storeId,
    queryFn: () =>
      request(
        `/api/v1/stores/${storeId}/fulfillment/expiry-alerts`,
        {},
        z.object({
          expiringSoon: z.array(
            z.object({
              orderId: z.string(),
              type: z.enum(['pending', 'accepted']),
              expiresAt: z.string(),
            }),
          ),
          bannerCounts: z.object({
            unaccepted: z.number(),
            unpacked: z.number(),
            packed: z.number(),
          }),
        }),
      ),
    refetchInterval: 15000,
  });
  const action = useMutation({
    mutationFn: async ({
      orderId,
      path,
      rejectionReasonId,
    }: {
      orderId: string;
      path: string;
      rejectionReasonId?: string;
    }) =>
      sendFulfillmentCommand(user.id, storeId, {
        orderId,
        path,
        ...(rejectionReasonId ? { rejectionReasonId } : {}),
      }),
    onSuccess: async (result) => {
      setReject('');
      setReason('');
      setNotice(
        result.integrationState === 'pending'
          ? `Updated ${result.updatedCount} line(s). External synchronization is pending.`
          : `Updated ${result.updatedCount} line(s).`,
      );
      await client.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === user.id &&
          typeof query.queryKey[1] === 'string' &&
          query.queryKey[1].startsWith('fulfillment-'),
      });
    },
  });
  return (
    <>
      <PageTitle eyebrow="EVERY ORDER, MOVING FORWARD" title="Express fulfillment">
        <NavLink className="button secondary" to="/local-deliveries">
          Local deliveries
        </NavLink>
        <button
          className="button secondary"
          onClick={() => {
            void page.refetch();
            void summary.refetch();
          }}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </PageTitle>
      <div className="fulfillment-tabs" role="tablist" aria-label="Fulfillment status">
        {tabs.map(([value, label]) => (
          <button
            role="tab"
            aria-selected={value === tab}
            className={value === tab ? 'selected' : ''}
            key={value}
            onClick={() => setTab(value)}
          >
            {label}
            <span>{summary.data?.tabCounts[value] || 0}</span>
          </button>
        ))}
      </div>
      {!!alerts.data?.expiringSoon.length && (
        <div className="fulfillment-status" role="status">
          <AlertCircle size={16} />
          {alerts.data.expiringSoon.length} order deadline(s) within 35 minutes.
          <button
            className="button secondary"
            onClick={() =>
              setTab(alerts.data!.expiringSoon[0]!.type === 'pending' ? 'in_queue' : 'not_packed')
            }
          >
            Review queue
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="fulfillment-status">
          <Check size={15} />
          {notice}
        </p>
      )}
      {action.isError && <ErrorState error={action.error} />}{' '}
      {page.isPending ? (
        <Loading />
      ) : page.isError ? (
        <ErrorState error={page.error} retry={() => void page.refetch()} />
      ) : (
        <div className="fulfillment-grid">
          {page.data.data.map((order) => (
            <article className="surface fulfillment-card" key={order.id}>
              <header>
                <div>
                  <small>ORDER</small>
                  <h2>{order.reference || order.id}</h2>
                </div>
                <span className="badge neutral">{order.lines.length} line(s)</span>
              </header>
              {order.expiresAt && (
                <div className="fulfillment-deadline">
                  <Clock3 size={14} />
                  {tab === 'in_queue' ? 'Acceptance' : 'Packing'} deadline · {order.expiresAt}
                </div>
              )}
              <div className="fulfillment-customer">
                <strong>{order.customer.name || 'Customer'}</strong>
                <span>
                  {order.customer.city} {order.customer.postalCode}
                </span>
              </div>
              <div>
                {order.lines.map((line) => (
                  <div className="fulfillment-line" key={line.id}>
                    <Box size={18} />
                    <div>
                      <strong>{line.productName || `Item ${line.hasProductId}`}</strong>
                      <small>
                        {line.quantity || '0'} unit(s) · {line.status}
                      </small>
                      {line.awb && <small>AWB {line.awb}</small>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="fulfillment-amount">
                <span>Store amount</span>
                <strong>{currency(order.storeOrderAmount)}</strong>
              </div>
              <div className="fulfillment-flags">
                <span className={`badge ${order.isVincAllocated ? 'green' : 'amber'}`}>
                  {order.isVincAllocated ? 'Allocated' : 'Awaiting allocation'}
                </span>
                {order.isRto && <span className="badge amber">RTO received</span>}
              </div>
              <footer>
                {tab === 'in_queue' && (
                  <>
                    <button
                      className="button primary"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ orderId: order.id, path: 'acceptance' })}
                    >
                      <Check size={15} />
                      Accept all
                    </button>
                    <button
                      className="button secondary"
                      disabled={action.isPending}
                      onClick={() => setReject(order.id)}
                    >
                      Reject
                    </button>
                  </>
                )}
                {tab === 'not_packed' && (
                  <>
                    <button
                      className="button primary"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ orderId: order.id, path: 'packing' })}
                    >
                      <PackageCheck size={15} />
                      Mark packed
                    </button>
                    <button
                      className="button secondary"
                      disabled={action.isPending}
                      onClick={() => setReject(order.id)}
                    >
                      Reject
                    </button>
                  </>
                )}
                {tab === 'packed' && (
                  <button
                    className="button primary"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ orderId: order.id, path: 'shipment' })}
                  >
                    <Truck size={15} />
                    Mark shipped
                  </button>
                )}
                {tab === 'shipped' && order.canMarkRto && (
                  <button
                    className="button secondary"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ orderId: order.id, path: 'rto-receipt' })}
                  >
                    Confirm RTO receipt
                  </button>
                )}
                {(tab === 'packed' || tab === 'shipped') && order.hasAwb && (
                  <ShippingLabelAction
                    user={user}
                    storeId={storeId}
                    orderId={order.id}
                    online={online}
                  />
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
      {page.data?.data.length === 0 && (
        <Empty title="This queue is clear">Orders appear here when they reach this stage.</Empty>
      )}
      <div className="fulfillment-pagination">
        <button
          className="button secondary"
          disabled={offset === 0 || page.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous
        </button>
        <span>Page {Math.floor(offset / 20) + 1}</span>
        <button
          className="button secondary"
          disabled={!page.data?.hasMore || page.isFetching}
          onClick={() => setOffset(page.data!.nextOffset)}
        >
          Next
        </button>
      </div>
      {reject && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="reject-title">
            <button
              className="icon-button modal-close"
              aria-label="Cancel rejection"
              onClick={() => setReject('')}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">REVIEW BEFORE REJECTING</div>
            <h2 id="reject-title">Reject order {reject}?</h2>
            <p>
              The actionable lines will be rejected and queued for warehouse conversion. Choose the
              reason staff should see.
            </p>
            <label>
              Reason
              <select
                aria-label="Rejection reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              >
                <option value="">Choose a reason</option>
                {reasons.data?.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.reason}
                  </option>
                ))}
              </select>
            </label>
            {reasons.isError && <ErrorState error={reasons.error} />}
            <button
              className="button primary full"
              disabled={!reason || action.isPending}
              onClick={() =>
                action.mutate({ orderId: reject, path: 'rejection', rejectionReasonId: reason })
              }
            >
              <AlertCircle size={16} />
              Reject order
            </button>
          </section>
        </div>
      )}
    </>
  );
}
