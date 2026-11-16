import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import DashboardPage from '../../src/pages/dashboard';
import '../../src/styles.css';

const user: Principal = {
  id: '900001',
  name: 'Fixture operator',
  email: 'fixture@example.invalid',
  role: 4,
  userType: new URLSearchParams(location.search).has('franchise') ? 2 : 1,
  storeIds: ['1', '9007199254740993'],
};
setRequestOperator(user.id);
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <button onClick={() => setRequestOperator('900002')}>Fixture switch operator</button>
    <DashboardPage user={user} />
  </QueryClientProvider>,
);
