import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Principal } from '../../../src/api/types';
import { setRequestOperator } from '../../../src/api/client';
import ParentStoreImportsPage from '../../../src/pages/administration/parent-store-imports';
import { InventoryImportAdministration } from '../../../src/pages/administration/imports';
import '../../../src/styles.css';
const params = new URLSearchParams(location.search),
  initial: Principal = {
    id: '900001',
    name: 'Synthetic operator',
    email: 'fixture@example.invalid',
    role: params.has('franchise') ? 5 : 1,
    userType: params.has('franchise') ? 2 : 1,
    storeIds: ['1'],
  };
setRequestOperator(initial.id);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Harness() {
  const [user, setUser] = useState(initial);
  return (
    <>
      <button
        onClick={() => {
          setRequestOperator('900002');
          setUser({ ...initial, id: '900002' });
        }}
      >
        Fixture switch operator
      </button>
      {params.has('stock') ? (
        <InventoryImportAdministration user={user} />
      ) : (
        <ParentStoreImportsPage user={user} online />
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Harness />
  </QueryClientProvider>,
);
