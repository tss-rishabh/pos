import { z } from 'zod';
import type { Principal } from '../../api/types';
import { ReportView } from './report-view';
const rowSchema = z.object({
  id: z.string(),
  order_id: z.string(),
  store_name: z.string().nullable(),
  staff_name: z.union([z.string(), z.literal(0)]),
  time_taken: z.string(),
  created_at: z.string(),
});
const columns = [
  { key: 'order_id', label: 'Order', sort: 'order_id' },
  { key: 'store_name', label: 'Store', sort: 'store_name' },
  { key: 'staff_name', label: 'Staff', sort: 'staff_id' },
  { key: 'time_taken', label: 'Time taken', sort: 'time_taken' },
  { key: 'created_at', label: 'Created', sort: 'created_at' },
] as const;
export function HyperlocalAcceptancePage({ user, storeId }: { user: Principal; storeId: string }) {
  return (
    <ReportView
      user={user}
      storeId={storeId}
      title="Hyperlocal acceptance"
      path="/api/v1/reports/hyperlocal-acceptance/search"
      resource="hyperlocal-acceptance-report"
      rowSchema={rowSchema}
      columns={columns}
      defaultSort="created_at"
      exportKind="hyperlocal-acceptance"
    />
  );
}
