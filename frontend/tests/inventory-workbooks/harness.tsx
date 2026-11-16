import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import { ReportExportsPage } from '../../src/pages/operational-reports/exports';
import type { Principal } from '../../src/api/types';
import '../../src/styles.css';
const user: Principal = {
  id: '1',
  name: 'Fixture administrator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
setRequestOperator(user.id);
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <button onClick={() => setRequestOperator('2')}>Fixture switch operator</button>
    <ReportExportsPage user={user} storeId="1" />
  </QueryClientProvider>,
);
