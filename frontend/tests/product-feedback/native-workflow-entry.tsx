import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ProductFeedbackPage } from '../../src/pages/product-feedback';
import { setRequestOperator } from '../../src/api/client';
import { db } from '../../src/offline/database';
import '../../src/styles.css';

const user = {
  id: '7',
  role: 4 as const,
  userType: 1 as const,
  name: 'Synthetic feedback operator',
  email: 'operator@example.test',
  storeIds: ['1'],
};
setRequestOperator(user.id);
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 300000 });
declare global {
  interface Window {
    nativeFeedbackStored: () => Promise<string>;
  }
}
window.nativeFeedbackStored = async () =>
  JSON.stringify({
    indexed: await Promise.all(db.tables.map((table) => table.toArray())),
    local: localStorage,
  });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BrowserRouter>
      <Routes>
        <Route
          path="/stores/:storeId/checkout-sessions/:checkoutId/customers/:customerId/orders/:orderId/feedback"
          element={<ProductFeedbackPage user={user} storeId="1" online />}
        />
      </Routes>
    </BrowserRouter>
  </QueryClientProvider>,
);
