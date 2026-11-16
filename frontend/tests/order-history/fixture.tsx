import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { setRequestOperator } from '../../src/api/client';
import { OrdersPage } from '../../src/pages/operations';
import '../../src/styles.css';
setRequestOperator('1');
const entry = new URLSearchParams(location.search).get('entry') || '/orders';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[entry]}>
        <OrdersPage
          user={{
            id: '1',
            name: 'Synthetic operator',
            email: '',
            role: 2,
            userType: 1,
            storeIds: ['1'],
          }}
          storeId="1"
        />
      </MemoryRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
