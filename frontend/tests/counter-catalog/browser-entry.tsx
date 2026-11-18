import { db } from '../../src/offline/database';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CounterPage } from '../../src/pages/counter';
import { setRequestOperator } from '../../src/api/client';
import { useWorkspace } from '../../src/state/workspace';
setRequestOperator('1');
useWorkspace.setState({ storeId: '2', counterId: '3' });
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <CounterPage
      user={{
        id: '1',
        name: 'Fixture operator',
        email: '',
        role: new URLSearchParams(location.search).get('role') === '1' ? 1 : 4,
        userType: 1,
        storeIds: ['2'],
      }}
      operations={[]}
      online={true}
      sync={async () => {}}
    />
  </QueryClientProvider>,
);

declare global {
  interface Window {
    counterScanFixtureLines: () => Promise<
      Array<Array<{ productId: string; quantity: number; barcode: string | null }>>
    >;
  }
}
window.counterScanFixtureLines = async () =>
  (await db.drafts.toArray()).map((draft) =>
    draft.lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      barcode: line.barcode,
    })),
  );
