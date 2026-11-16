import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import { ReportsPage } from '../../src/pages/reports';
import type { Principal } from '../../src/api/types';
import '../../src/styles.css';
const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
setRequestOperator(user.id);
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      })
    }
  >
    <BrowserRouter>
      <main style={{ padding: '2rem', maxWidth: '1600px', margin: '0 auto' }}>
        <ReportsPage user={user} storeId="1" />
      </main>
    </BrowserRouter>
  </QueryClientProvider>,
);
