import { z } from 'zod';
import type { Principal } from '../../api/types';
import { ReportView } from './report-view';
const rowSchema = z.object({
  id: z.string(),
  store_name: z.string().nullable(),
  order_id: z.string(),
  prod_id: z.string(),
  qty: z.number(),
  pay_amount_refunded: z.union([z.string(), z.number()]).nullable(),
  pay_amount_refunded_mode: z.string().nullable(),
  reason: z.string().nullable(),
  sub_reason: z.string().nullable(),
  comment: z.string().nullable(),
  order_date: z.string(),
  created_at: z.string(),
  original_order_id: z.string().nullable(),
});
const columns = [
  { key: 'store_name', label: 'Store', sort: 'store_name' },
  { key: 'order_id', label: 'Order', sort: 'order_id' },
  { key: 'prod_id', label: 'Product', sort: 'prod_id' },
  { key: 'qty', label: 'Quantity', sort: 'qty' },
  { key: 'pay_amount_refunded', label: 'Amount refunded', sort: 'pay_amount_refunded' },
  { key: 'pay_amount_refunded_mode', label: 'Refund mode', sort: 'pay_amount_refunded' },
  { key: 'reason', label: 'Reason', sort: 'reason' },
  { key: 'sub_reason', label: 'Sub reason', sort: 'sub_reason' },
  { key: 'comment', label: 'Comment', sort: 'comment' },
  { key: 'order_date', label: 'Order date', sort: 'order_date' },
  { key: 'created_at', label: 'Return date', sort: 'created_at' },
  { key: 'original_order_id', label: 'Original order', sort: 'order_id' },
] as const;
export function ReturnedOrdersPage({ user, storeId }: { user: Principal; storeId: string }) {
  return (
    <ReportView
      user={user}
      storeId={storeId}
      title="Returned orders"
      path="/api/v1/reports/returned-orders/search"
      resource="returned-orders-report"
      rowSchema={rowSchema}
      columns={columns}
      defaultSort="created_at"
      allowedRoles={[1, 2, 3, 4, 5]}
      searchable
      requiresSelectedStores
      exportKind="returned-orders"
      fullExport
    />
  );
}
