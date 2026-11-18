import { z } from 'zod';
import type { Principal } from '../../api/types';
import { ReportView } from './report-view';
const money = z.number(),
  row = z.object({
    StoreName: z.string().nullable(),
    date: z.string(),
    total_number_of_bills: z.number(),
    total_number_of_qty_sold: z.number(),
    tss_money: money,
    tss_points: money,
    coupon: money,
    gift_voucher: money,
    pg_disc: money,
    cash: money,
    online: money,
    online_others: money,
    total_paytm_card_amount: money,
    total_paytm_upi_amount: money,
    district_transation_amt: money,
    credit_pincode_amt: money,
    cash_return: money,
    tss_money_return: money,
    tss_point_return: money,
    other_online_return: money,
    net_cash: money,
    total_sales: money,
  });
const columns = [
  ['StoreName', 'Store'],
  ['date', 'Date'],
  ['total_number_of_bills', 'Bills'],
  ['total_number_of_qty_sold', 'Quantity sold'],
  ['tss_money', 'TSS money'],
  ['tss_points', 'TSS points'],
  ['coupon', 'Coupon'],
  ['gift_voucher', 'Gift voucher'],
  ['pg_disc', 'PG discount'],
  ['cash', 'Cash'],
  ['online', 'Online'],
  ['online_others', 'Other online'],
  ['total_paytm_card_amount', 'Paytm card'],
  ['total_paytm_upi_amount', 'Paytm UPI'],
  ['district_transation_amt', 'District'],
  ['credit_pincode_amt', 'Credit pincode'],
  ['cash_return', 'Cash return'],
  ['tss_money_return', 'TSS money return'],
  ['tss_point_return', 'TSS points return'],
  ['other_online_return', 'Other online return'],
  ['net_cash', 'Net cash'],
  ['total_sales', 'Total sales'],
] as const;
export function FlashSalesPage({ user, storeId }: { user: Principal; storeId: string }) {
  return (
    <ReportView
      user={user}
      storeId={storeId}
      title="Flash sales"
      path="/api/v1/reports/flash-sales/search"
      resource="flash-sales-report"
      rowSchema={row}
      columns={columns.map(([key, label]) => ({ key, label, sort: 'store_date' }))}
      defaultSort="store_date"
      defaultDirection="asc"
      sortOptions={[{ value: 'store_date', label: 'Store and date' }]}
      allowedRoles={[1, 2, 3, 4, 5]}
      dateOnly
      requiresSelectedStores
      exportKind="flash-sales"
      fullExport
    />
  );
}
