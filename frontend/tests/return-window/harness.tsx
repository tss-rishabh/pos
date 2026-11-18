import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import { ReturnsPage } from '../../src/pages/returns';
import { saveRecovery } from '../../src/pages/returns/client';
import type { Principal } from '../../src/api/types';
import '../../src/styles.css';
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const proofId = '11111111-1111-4111-8111-111111111111';
for (const id of ['1', '2'])
  if (!localStorage.getItem(`souled-return:${id}:1:2`))
    saveRecovery(id, '1', '2', {
      orderId: '100',
      verificationId: proofId,
      returnId: null,
      kind: 'return',
    });
function Harness() {
  const [id, setId] = useState('1');
  const role = new URLSearchParams(location.search).get('cashier') === 'true' ? 5 : 3;
  const user: Principal = {
    id,
    role,
    userType: 1,
    name: 'Synthetic manager',
    email: 'manager@example.test',
    storeIds: ['1'],
  };
  setRequestOperator(id);
  return (
    <>
      <button
        onClick={() => {
          setRequestOperator('2');
          queries.clear();
          setId('2');
        }}
      >
        Switch operator
      </button>
      <ReturnsPage key={id} user={user} storeId="1" counterId="2" />
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queries}>
    <Harness />
  </QueryClientProvider>,
);
