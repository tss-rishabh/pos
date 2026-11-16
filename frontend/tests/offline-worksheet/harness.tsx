import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import { OfflineWorksheetPage } from '../../src/pages/offline-worksheet';
import '../../src/styles.css';

const principal = (id: string): Principal => ({
  id,
  role: 5,
  userType: 1,
  name: 'Synthetic operator',
  email: 'operator@example.test',
  storeIds: ['1'],
});
const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
setRequestOperator('1');
function Harness() {
  const [user, setUser] = useState(principal('1'));
  return (
    <QueryClientProvider client={queries}>
      <button
        onClick={() => {
          setRequestOperator('2');
          setUser(principal('2'));
        }}
      >
        Switch fixture operator
      </button>
      <OfflineWorksheetPage user={user} storeId="1" />
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
