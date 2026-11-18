import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import {
  SalespersonPerformancePage,
  CashierPerformancePage,
} from '../../src/pages/operational-reports/performance';
import { HyperlocalAcceptancePage } from '../../src/pages/operational-reports/acceptance';
import { ReturnedOrdersPage } from '../../src/pages/operational-reports/returned-orders';
import { FlashSalesPage } from '../../src/pages/operational-reports/flash-sales';
import { OrderTransactionsPage } from '../../src/pages/operational-reports/order-transactions';
import '../../src/styles.css';

const root = createRoot(document.getElementById('root')!),
  user: Principal = {
    id: '10',
    name: 'Fixture manager',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: ['1'],
  };
setRequestOperator(user.id);
const Page = location.pathname.endsWith('/transactions')
  ? OrderTransactionsPage
  : location.pathname.endsWith('/cashier')
    ? CashierPerformancePage
    : location.pathname.endsWith('/acceptance')
      ? HyperlocalAcceptancePage
      : location.pathname.endsWith('/returns')
        ? ReturnedOrdersPage
        : location.pathname.endsWith('/flash')
          ? FlashSalesPage
          : SalespersonPerformancePage;
root.render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      })
    }
  >
    <main>
      <Page user={user} storeId="1" />
    </main>
  </QueryClientProvider>,
);
