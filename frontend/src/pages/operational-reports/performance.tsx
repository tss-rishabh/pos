import { z } from 'zod';
import type { Principal } from '../../api/types';
import { ReportView } from './report-view';
const salespersonSchema = z.object({
    id: z.string(),
    store_name: z.string().nullable(),
    salesperson_name: z.string().nullable(),
    total_sales: z.union([z.string(), z.number()]),
    rating: z.number(),
  }),
  salespersonColumns = [
    { key: 'store_name', label: 'Store', sort: 'store_name' },
    { key: 'salesperson_name', label: 'Salesperson', sort: 'salesperson_name' },
    { key: 'total_sales', label: 'Total sales', sort: 'total_sales' },
    { key: 'rating', label: 'Rating / 10', sort: 'rating' },
  ] as const;
const cashierSchema = z.object({
    id: z.string().nullable(),
    cashier_name: z.string().nullable(),
    product_sold: z.number(),
    time_taken: z.string(),
    score: z.number(),
  }),
  cashierColumns = [
    { key: 'cashier_name', label: 'Cashier', sort: 'cashier_name' },
    { key: 'product_sold', label: 'Products sold', sort: 'product_sold' },
    { key: 'time_taken', label: 'Time taken', sort: 'time_taken' },
    { key: 'score', label: 'Score', sort: 'rating' },
  ] as const;
export function SalespersonPerformancePage({
  user,
  storeId,
}: {
  user: Principal;
  storeId: string;
}) {
  return (
    <ReportView
      user={user}
      storeId={storeId}
      title="Salesperson performance"
      path="/api/v1/reports/salesperson-performance/search"
      resource="salesperson-performance-report"
      rowSchema={salespersonSchema}
      columns={salespersonColumns}
      defaultSort="total_sales"
    />
  );
}
export function CashierPerformancePage({ user, storeId }: { user: Principal; storeId: string }) {
  return (
    <ReportView
      user={user}
      storeId={storeId}
      title="Staff performance"
      path="/api/v1/reports/cashier-performance/search"
      resource="cashier-performance-report"
      rowSchema={cashierSchema}
      columns={cashierColumns}
      defaultSort="rating"
    />
  );
}
