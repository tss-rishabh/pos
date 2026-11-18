import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import { SourceOrderList } from '../../src/pages/order-history/SourceOrderList';
import '../../src/styles.css';
const rolling = new URLSearchParams(location.search).has('rolling');
setRequestOperator('1');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <SourceOrderList
          user={{
            id: '1',
            name: 'Synthetic',
            email: '',
            role: 2,
            userType: 1,
            storeIds: ['1', '2'],
          }}
          storeId="1"
          online={true}
          dates={
            rolling
              ? { from: '2026-12-26', to: '2027-01-01', explicit: false }
              : { from: '2026-11-17', to: '2026-11-17' }
          }
          defaults={
            rolling
              ? {
                  generatedAt: '2026-12-31T18:29:55Z',
                  timeZone: 'Asia/Kolkata',
                  store: { placedFrom: '2026-12-26 23:59:00', placedTo: '2027-01-01 00:00:00' },
                }
              : undefined
          }
          onOpen={(row) => {
            document.body.dataset.openedOrder = row.id;
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
