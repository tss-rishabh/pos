import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import {
  CatalogPage,
  CatalogProductPage,
  InventoryAuditPage,
  StoreCatalogPage,
  StockMatrixPage,
  InventoryPullPage,
} from '../../src/pages/catalog';
import { db } from '../../src/offline/database';
import type { Principal } from '../../src/api/types';
import { setRequestOperator } from '../../src/api/client';
import '../../src/styles.css';
const user: Principal = {
  id: '1',
  name: 'Fixture operator',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: ['1', '2'],
};
declare global {
  interface Window {
    remountCatalogFixture: () => void;
  }
}
function Product() {
  const { productId = '20' } = useParams();
  return <CatalogProductPage user={user} productId={productId} />;
}
function Audit() {
  const { productId = '20' } = useParams();
  return <InventoryAuditPage user={user} storeId="1" productId={productId} />;
}
function Snapshot() {
  const { storeId = '1' } = useParams();
  return <StoreCatalogPage user={user} storeId={storeId} />;
}
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 3600000 });
setRequestOperator(user.id);
const root = createRoot(document.getElementById('root')!);
let revision = 0;
window.remountCatalogFixture = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  root.render(
    <QueryClientProvider client={client} key={++revision}>
      <BrowserRouter>
        <main style={{ padding: '2rem', maxWidth: '1600px', margin: '0 auto' }}>
          <Routes>
            <Route path="/catalog" element={<CatalogPage user={user} storeId="1" />} />
            <Route
              path="/catalog/inventory"
              element={<StockMatrixPage user={user} storeId="1" />}
            />
            <Route path="/catalog/inventory-pulls" element={<InventoryPullPage user={user} />} />
            <Route path="/catalog/products/:productId" element={<Product />} />
            <Route path="/catalog/products/:productId/audit" element={<Audit />} />
            <Route path="/catalog/stores/:storeId/snapshot" element={<Snapshot />} />
          </Routes>
        </main>
      </BrowserRouter>
    </QueryClientProvider>,
  );
};
window.remountCatalogFixture();
