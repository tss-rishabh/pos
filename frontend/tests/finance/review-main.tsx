import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DayClosePage } from '../../src/pages/finance';
import { ReportsPage } from '../../src/pages/reports';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import '../../src/styles.css';
const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.invalid',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
setRequestOperator(user.id);
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <BrowserRouter>
        {new URLSearchParams(location.search).has('reports') ? (
          <ReportsPage user={user} storeId="1" />
        ) : (
          <DayClosePage user={user} storeId="1" />
        )}
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
