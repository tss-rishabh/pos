import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Principal } from '../../../src/api/types';
import { setRequestOperator } from '../../../src/api/client';
import BarcodeAssignmentsPage from '../../../src/pages/administration/barcodes';
import SecondaryCountrySearchPage from '../../../src/pages/administration/secondary-countries';
import '../../../src/styles.css';
const params = new URLSearchParams(location.search),
  initial: Principal = {
    id: '900001',
    name: 'Synthetic administrator',
    email: 'fixture@example.invalid',
    role: params.has('staff') ? 4 : 1,
    userType: params.has('franchise') ? 2 : 1,
    storeIds: ['1'],
  };
setRequestOperator(initial.id);
function Harness() {
  const [user, setUser] = useState(initial);
  return (
    <>
      <button
        onClick={() => {
          setRequestOperator('900002');
          setUser({ ...initial, id: '900002', role: 2, userType: 1 });
        }}
      >
        Fixture switch operator
      </button>
      {params.has('country') ? (
        <SecondaryCountrySearchPage user={user} />
      ) : (
        <BarcodeAssignmentsPage user={user} />
      )}
    </>
  );
}
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Harness />
  </QueryClientProvider>,
);
