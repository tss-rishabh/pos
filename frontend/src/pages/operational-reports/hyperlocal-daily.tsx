import { z } from 'zod';
import type { Principal } from '../../api/types';
import { ReportView } from './report-view';
const row = z.object({
  order_id: z.string(),
  user_id: z.string(),
  line_item_id: z.string(),
  sku_id: z.string(),
  customer_name: z.string().nullable(),
  qty: z.number(),
  amount: z.number(),
  order_status: z.string().nullable(),
  line_item_status: z.string(),
  express_line_item_status: z.string().nullable(),
  order_date: z.string().nullable(),
  location_code: z.string(),
  store_name: z.string(),
  allocation_date: z.string().nullable(),
  pack_date: z.string().nullable(),
  pickup_date: z.string().nullable(),
  delivery_date: z.string().nullable(),
});
const columns = [
  { key: 'order_id', label: 'Order ID', sort: 'order_date' },
  { key: 'user_id', label: 'User ID', sort: 'order_date' },
  { key: 'line_item_id', label: 'Line Item Id', sort: 'order_date' },
  { key: 'sku_id', label: 'SKU ID', sort: 'order_date' },
  { key: 'customer_name', label: 'Name', sort: 'order_date' },
  { key: 'qty', label: 'Qty', sort: 'order_date' },
  { key: 'amount', label: 'Amount', sort: 'order_date' },
  { key: 'order_status', label: 'Order Status', sort: 'order_date' },
  { key: 'line_item_status', label: 'Line Item Status', sort: 'order_date' },
  { key: 'express_line_item_status', label: 'Express Line Item Status', sort: 'order_date' },
  { key: 'order_date', label: 'Order Date', sort: 'order_date' },
  { key: 'location_code', label: 'Store Code', sort: 'order_date' },
  { key: 'store_name', label: 'Store Name', sort: 'order_date' },
  { key: 'allocation_date', label: 'Order Allocation Date to POS', sort: 'order_date' },
  { key: 'pack_date', label: 'Order Pack Date', sort: 'order_date' },
  { key: 'pickup_date', label: 'Order Pickup Date', sort: 'order_date' },
  { key: 'delivery_date', label: 'Order Delivery Date', sort: 'order_date' },
] as const;
export function HyperlocalDailyPage({ user, storeId }: { user: Principal; storeId: string }) {
  return (
    <ReportView
      user={user}
      storeId={storeId}
      title="Hyperlocal daily report"
      path="/api/v1/reports/hyperlocal-daily/search"
      resource="hyperlocal-daily-report"
      rowSchema={row}
      columns={columns}
      defaultSort="order_date"
      sortOptions={[{ value: 'order_date', label: 'Order date' }]}
      allowedRoles={[1, 2, 3, 4, 5]}
      exportKind="hyperlocal-daily"
    />
  );
}
