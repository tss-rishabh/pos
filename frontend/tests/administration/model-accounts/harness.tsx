import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Principal } from '../../../src/api/types';
import { setRequestOperator } from '../../../src/api/client';
import OperatorModelAccountsPage from '../../../src/pages/administration/model-accounts';
import '../../../src/styles.css';
const params = new URLSearchParams(location.search),
  initial: Principal = {
    id: '900001',
    name: 'Synthetic operator',
    email: 'fixture@example.invalid',
    role: 1,
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
      <OperatorModelAccountsPage user={user} />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <Harness />
  </QueryClientProvider>,
);
