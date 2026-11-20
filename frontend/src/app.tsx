import { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Building2,
  ChevronDown,
  CloudOff,
  LayoutGrid,
  LogOut,
  Package,
  ReceiptText,
  RefreshCw,
  ChartNoAxesCombined,
  Truck,
  Settings,
  BookOpen,
  ClipboardCheck,
  Monitor,
  Wallet,
  Undo2,
  UserRound,
  QrCode,
} from 'lucide-react';
import { useCounters, useOperator, useStores, useSync } from './hooks/use-pos';
import { useCheckoutPerformance } from './hooks/use-checkout-performance';
import { useWorkspace } from './state/workspace';
import { request, setRequestOperator } from './api/client';
import { clearLocalIdentity } from './offline/clear-identity';
import { useOfflineBillingAutoSwitch } from './offline/billing/auto-switch';
import { desktopOfflineBridge } from './offline/billing/bridge';
import { Login } from './pages/login';
import { Empty, ErrorState, Loading } from './components/common';
import { RealtimeClock } from './components/realtime-clock';
import { ReleaseNotes } from './components/release-notes';
import { CheckInControl, CheckInPrompt, useCheckIn } from './components/check-in';
import { ConnectionStatus } from './components/connection-status';
import type { Principal } from './api/types';
import { NotificationsPanel } from './pages/fulfillment/notifications';
import { GlobalFulfillmentExpiryAlerts } from './pages/fulfillment/global-expiry-alerts';
import { DayCloseReminder } from './pages/finance/day-close-reminder';
import { pendingSlackConnection } from './pages/administration/slack-return';
import { BrandMark } from './components/brand-mark';

const CounterPage = lazy(() => import('./pages/counter').then((m) => ({ default: m.CounterPage })));
const OfflineWorksheetPage = lazy(() => import('./pages/offline-worksheet'));
const OfflineBillingPage = lazy(() => import('./pages/offline-billing'));
const DashboardPage = lazy(() => import('./pages/dashboard'));
const BarcodeAssignmentsPage = lazy(() => import('./pages/administration/barcodes'));
const OperatorModelAccountsPage = lazy(() => import('./pages/administration/model-accounts'));
const SecondaryCountrySearchPage = lazy(() => import('./pages/administration/secondary-countries'));
const InventoryPage = lazy(() =>
  import('./pages/operations').then((m) => ({ default: m.InventoryPage })),
);
const CatalogPage = lazy(() => import('./pages/catalog').then((m) => ({ default: m.CatalogPage })));
const CatalogProductPage = lazy(() =>
  import('./pages/catalog').then((m) => ({ default: m.CatalogProductPage })),
);
const InventoryAuditPage = lazy(() =>
  import('./pages/catalog').then((m) => ({ default: m.InventoryAuditPage })),
);
const StoreCatalogPage = lazy(() =>
  import('./pages/catalog').then((m) => ({ default: m.StoreCatalogPage })),
);
const StockMatrixPage = lazy(() =>
  import('./pages/catalog').then((m) => ({ default: m.StockMatrixPage })),
);
const InventoryPullPage = lazy(() =>
  import('./pages/catalog').then((m) => ({ default: m.InventoryPullPage })),
);
const SpecialPermissionHistoryPage = lazy(() =>
  import('./pages/administration/permission-history').then((m) => ({
    default: m.SpecialPermissionHistoryPage,
  })),
);
const AdministrationHistoryPage = lazy(() =>
  import('./pages/administration/history').then((m) => ({
    default: m.AdministrationHistoryPage,
  })),
);
const GiftCardBatchesPage = lazy(() =>
  import('./pages/administration/gift-card-batches').then((m) => ({
    default: m.GiftCardBatchesPage,
  })),
);
const ApplicationLinksPage = lazy(() =>
  import('./pages/administration/application-links').then((m) => ({
    default: m.ApplicationLinksPage,
  })),
);
const ApplicationLinkLandingPage = lazy(() =>
  import('./pages/administration/application-links').then((m) => ({
    default: m.ApplicationLinkLandingPage,
  })),
);
const OnlineOrderDetailPage = lazy(() =>
  import('./pages/order-history/OnlineOrderDetail').then((module) => ({
    default: module.OnlineOrderDetailPage,
  })),
);
const OrdersPage = lazy(() =>
  import('./pages/operations').then((m) => ({ default: m.OrdersPage })),
);
const ProductFeedbackPage = lazy(() =>
  import('./pages/product-feedback').then((m) => ({ default: m.ProductFeedbackPage })),
);
const StoresPage = lazy(() =>
  import('./pages/operations').then((m) => ({ default: m.StoresPage })),
);
const SyncPage = lazy(() => import('./pages/sync').then((m) => ({ default: m.SyncPage })));
const ReportsPage = lazy(() => import('./pages/reports').then((m) => ({ default: m.ReportsPage })));
const AdministrationPage = lazy(() =>
  import('./pages/administration').then((m) => ({ default: m.AdministrationPage })),
);
const DocumentationPage = lazy(() =>
  import('./pages/administration').then((m) => ({ default: m.DocumentationPage })),
);
const FulfillmentPage = lazy(() =>
  import('./pages/fulfillment').then((m) => ({ default: m.FulfillmentPage })),
);
const LocalDeliveriesPage = lazy(() =>
  import('./pages/legacy-fulfillment').then((m) => ({ default: m.LegacyFulfillmentPage })),
);
const FulfillmentMonitoringPage = lazy(() =>
  import('./pages/fulfillment/monitoring').then((m) => ({ default: m.FulfillmentMonitoringPage })),
);
const DayClosePage = lazy(() =>
  import('./pages/finance').then((m) => ({ default: m.DayClosePage })),
);
const CashLedgerPage = lazy(() =>
  import('./pages/finance/ledger').then((m) => ({ default: m.CashLedgerPage })),
);
const DayCloseHistoryPage = lazy(() =>
  import('./pages/finance/history').then((m) => ({ default: m.DayCloseHistoryPage })),
);
const CustomerFeedbackPage = lazy(() =>
  import('./pages/operational-reports/feedback').then((m) => ({ default: m.CustomerFeedbackPage })),
);
const InventoryAssociationsPage = lazy(() =>
  import('./pages/operational-reports/inventory').then((m) => ({
    default: m.InventoryAssociationsPage,
  })),
);
const ReportExportsPage = lazy(() =>
  import('./pages/operational-reports/exports').then((m) => ({ default: m.ReportExportsPage })),
);
const HyperlocalAcceptancePage = lazy(() =>
  import('./pages/operational-reports/acceptance').then((m) => ({
    default: m.HyperlocalAcceptancePage,
  })),
);
const SalespersonPerformancePage = lazy(() =>
  import('./pages/operational-reports/performance').then((m) => ({
    default: m.SalespersonPerformancePage,
  })),
);
const CashierPerformancePage = lazy(() =>
  import('./pages/operational-reports/performance').then((m) => ({
    default: m.CashierPerformancePage,
  })),
);
const ReturnsPage = lazy(() => import('./pages/returns/entry-page'));
const ProfilePage = lazy(() => import('./pages/profile').then((m) => ({ default: m.ProfilePage })));
const WalletAdjustmentsPage = lazy(() =>
  import('./pages/checkout/benefit-adjustments').then((m) => ({
    default: m.GlobalBenefitAdjustmentsPage,
  })),
);
const GlobalVouchersPage = lazy(() => import('./pages/global-vouchers'));
const ReturnedOrdersPage = lazy(() =>
  import('./pages/operational-reports/returned-orders').then((m) => ({
    default: m.ReturnedOrdersPage,
  })),
);
const OrderTransactionsPage = lazy(() =>
  import('./pages/operational-reports/order-transactions').then((m) => ({
    default: m.OrderTransactionsPage,
  })),
);
const HyperlocalDailyPage = lazy(() =>
  import('./pages/operational-reports/hyperlocal-daily').then((m) => ({
    default: m.HyperlocalDailyPage,
  })),
);
const FlashSalesPage = lazy(() =>
  import('./pages/operational-reports/flash-sales').then((m) => ({ default: m.FlashSalesPage })),
);

const links = [
  { to: '/', name: 'The counter', icon: LayoutGrid },
  { to: '/dashboard', name: 'Dashboard', icon: ChartNoAxesCombined, internalOnly: true },
  { to: '/orders', name: 'Orders', icon: ReceiptText },
  { to: '/offline-worksheet', name: 'Invoice worksheet', icon: ReceiptText },
  // Desktop only: web browsers need internet to bill, so the web app has no offline billing link.
  { to: '/offline-billing', name: 'Offline billing', icon: CloudOff, desktopOnly: true },
  { to: '/returns', name: 'Returns', icon: Undo2 },
  { to: '/inventory', name: 'Inventory', icon: Package },
  { to: '/catalog', name: 'Product catalog', icon: Package },
  { to: '/stores', name: 'Stores', icon: Building2 },
  { to: '/reports', name: 'Reports', icon: ChartNoAxesCombined },
  { to: '/fulfillment', name: 'Fulfillment', icon: Truck },
  { to: '/day-close', name: 'Day close', icon: ClipboardCheck },
  { to: '/cash-ledger', name: 'Cash ledger', icon: Wallet },
  {
    to: '/wallet-adjustments',
    name: 'Wallet adjustments',
    icon: Wallet,
    roles: [1, 2, 3],
    internalOnly: true,
  },
  {
    to: '/gift-vouchers',
    name: 'Gift vouchers',
    icon: Wallet,
    roles: [1, 2, 3],
    internalOnly: true,
  },
  { to: '/profile', name: 'Your profile', icon: UserRound },
  { to: '/monitoring', name: 'Fulfillment monitor', icon: Monitor, roles: [1, 2, 3] },
  { to: '/administration', name: 'Administration', icon: Settings, roles: [1, 2, 3] },
  {
    to: '/administration/barcodes',
    name: 'Barcode assignment',
    icon: QrCode,
    roles: [1, 2, 3],
    internalOnly: true,
  },
  { to: '/countries', name: 'Country lookup', icon: Building2, roles: [1, 2, 3] },
  {
    to: '/administration/model-accounts',
    name: 'Advanced account setup',
    icon: UserRound,
    roles: [1],
    internalOnly: true,
  },
  { to: '/documentation', name: 'Help & documents', icon: BookOpen },
  { to: '/application-links', name: 'Application links', icon: QrCode },
  { to: '/sync', name: 'Sync center', icon: RefreshCw },
];
const roleNames = { 1: 'Super admin', 2: 'Admin', 3: 'OPM', 4: 'SM', 5: 'Staff' };
export function App() {
  const { pathname } = useLocation();
  const kind =
    pathname === '/application-links/staff'
      ? 'staff'
      : pathname === '/application-links/customer'
        ? 'customer'
        : null;
  useLayoutEffect(() => {
    if (kind) setRequestOperator(null);
  }, [kind]);
  return kind ? (
    <Suspense fallback={<Loading />}>
      <ApplicationLinkLandingPage key={kind} kind={kind} />
    </Suspense>
  ) : (
    <OperatorWorkspace />
  );
}
function OperatorWorkspace() {
  const operator = useOperator();
  useLayoutEffect(() => {
    setRequestOperator(operator.data?.id ?? null);
  }, [operator.data?.id]);
  return operator.isPending ? (
    <Loading />
  ) : operator.data ? (
    <Workspace key={operator.data.id} user={operator.data} />
  ) : (
    <Login />
  );
}
function Workspace({ user }: { user: Principal }) {
  const client = useQueryClient(),
    navigate = useNavigate();
  useEffect(() => {
    const receipt = pendingSlackConnection();
    if (receipt)
      navigate(
        {
          pathname: '/administration',
          search: '?' + new URLSearchParams({ slackConnection: receipt }).toString(),
        },
        { replace: true },
      );
  }, [navigate]);
  const stores = useStores(user.id),
    state = useWorkspace(),
    counters = useCounters(user.id, state.storeId),
    sync = useSync(user.id);
  useCheckoutPerformance(user.id, state.storeId, state.counterId, sync.online);
  useOfflineBillingAutoSwitch(sync.online);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const checkIn = useCheckIn(user, sync.online);
  useEffect(() => {
    if (stores.data && !stores.data.some((s) => s.id === state.storeId))
      state.setStore(stores.data[0]?.id || '');
  }, [stores.data, state.storeId]);
  useEffect(() => {
    if (counters.data && !counters.data.some((c) => c.id === state.counterId))
      state.setCounter(counters.data[0]?.id || '');
  }, [counters.data, state.counterId]);
  const currentStore = stores.data?.find((s) => s.id === state.storeId);
  async function logout() {
    setLoggingOut(true);
    try {
      localStorage.setItem('pos-pending-logout', '1');
      try {
        await request('/api/v1/auth/sessions/current', { method: 'DELETE' });
        localStorage.removeItem('pos-pending-logout');
      } catch {
        /* Keep a logout tombstone until the server confirms cookie deletion. */
      }
      await clearLocalIdentity(client, user.id);
      navigate('/');
    } catch (error) {
      setLogoutError(error);
      setLoggingOut(false);
    }
  }
  return (
    <div className="app-shell">
      <a href="#workspace-main" className="skip-link">
        Skip to workspace
      </a>
      <aside className="sidebar">
        <NavLink to="/" className="brand" aria-label="The Souled Store: the counter">
          <BrandMark />
          <span>The Souled Store</span>
        </NavLink>
        <nav aria-label="Main navigation">
          {links
            .filter(
              (link) =>
                (!link.roles || link.roles.includes(user.role)) &&
                (!link.internalOnly || user.userType === 1) &&
                (!link.desktopOnly || desktopOfflineBridge() !== null),
            )
            .map((link) => (
              <NavLink
                end={link.to === '/'}
                key={link.to}
                to={link.to}
                className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              >
                <link.icon size={18} aria-hidden="true" />
                <span>{link.name}</span>
                {link.to === '/sync' && sync.operations.length > 0 && (
                  <b>{sync.operations.length}</b>
                )}
              </NavLink>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <RealtimeClock />
          <span className="sidebar-version">v0.1</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-context">
            <div className="location-picker">
              <Building2 size={16} aria-hidden="true" />
              <label className="sr-only" htmlFor="store-select">
                Current store
              </label>
              <select
                id="store-select"
                value={state.storeId}
                title={currentStore?.name}
                onChange={(e) => state.setStore(e.target.value)}
              >
                {!stores.data?.length && <option value="">Select a store</option>}
                {stores.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
            <span className="topbar-divider" />
            <label className="counter-picker">
              <span>Counter</span>
              <select
                aria-label="Current counter"
                value={state.counterId}
                onChange={(e) => state.setCounter(e.target.value)}
              >
                {!counters.data?.length && <option value="">Select</option>}
                {counters.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="topbar-divider" />
            <CheckInControl
              state={checkIn}
              stores={stores.isError ? [] : stores.data || []}
              storeId={state.storeId}
              counterId={state.counterId}
            />
          </div>
          <div className="topbar-right">
            <ConnectionStatus online={sync.online} pendingOperations={sync.operations.length} />
            <NotificationsPanel
              key={`${user.id}:${state.storeId}`}
              user={user}
              storeId={state.storeId}
            />
            <ReleaseNotes role={user.role} />
            <span className="topbar-divider" />
            <div className="account">
              <div className="operator-avatar" aria-hidden="true">
                {user.name.slice(0, 1)}
              </div>
              <div className="operator-info">
                <strong>{user.name}</strong>
                <span>
                  {roleNames[user.role]} · {user.userType === 2 ? 'Franchise' : 'In-House'}
                </span>
              </div>
              <button
                type="button"
                className="button secondary small account-toggle"
                disabled={loggingOut}
                aria-busy={loggingOut}
                onClick={() => void logout()}
              >
                {!loggingOut && <LogOut size={14} aria-hidden="true" />}
                Log out
              </button>
            </div>
          </div>
        </header>
        <GlobalFulfillmentExpiryAlerts
          operatorId={user.id}
          storeId={state.storeId}
          enabled={sync.online && !stores.isError && Boolean(currentStore?.active)}
        />
        <DayCloseReminder
          user={user}
          storeId={state.storeId}
          enabled={sync.online && !stores.isError && Boolean(currentStore?.active)}
        />
        {stores.data && <CheckInPrompt user={user} state={checkIn} stores={stores.data} />}
        <main className="main-content" id="workspace-main">
          {logoutError !== null && <ErrorState error={logoutError} />}
          {stores.isError ? (
            <ErrorState error={stores.error} retry={() => void stores.refetch()} />
          ) : stores.isPending ? (
            <Loading />
          ) : (
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route
                  path="/administration/barcodes"
                  element={<BarcodeAssignmentsPage user={user} />}
                />
                <Route path="/countries" element={<SecondaryCountrySearchPage user={user} />} />
                <Route
                  path="/administration/model-accounts"
                  element={<OperatorModelAccountsPage user={user} />}
                />
                <Route path="/dashboard" element={<DashboardPage key={user.id} user={user} />} />
                <Route
                  path="/offline-worksheet"
                  element={<OfflineWorksheetPage user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/"
                  element={
                    state.storeId && state.counterId ? (
                      <CounterPage
                        key={`${user.id}:${state.storeId}:${state.counterId}`}
                        user={user}
                        {...sync}
                      />
                    ) : (
                      <div className="empty">
                        <Building2 size={30} aria-hidden="true" />
                        <h2>{currentStore ? 'Select a counter' : 'Select your store'}</h2>
                        {counters.isError && <ErrorState error={counters.error} />}
                      </div>
                    )
                  }
                />
                <Route
                  path="/orders"
                  element={<OrdersPage user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/orders/details/:type/:orderId"
                  element={<OnlineOrderDetailPage user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/stores/:storeId/checkout-sessions/:checkoutId/customers/:customerId/orders/:orderId/feedback"
                  element={
                    <ProductFeedbackPage user={user} storeId={state.storeId} online={sync.online} />
                  }
                />
                <Route
                  path="/returns"
                  element={
                    <ReturnsPage
                      key={`${user.id}:${state.storeId}:${state.counterId}`}
                      user={user}
                      storeId={state.storeId}
                      counterId={state.counterId}
                    />
                  }
                />
                <Route
                  path="/inventory"
                  element={<InventoryPage user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/catalog"
                  element={
                    <CatalogPage
                      key={`${user.id}:${state.storeId}`}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/catalog/products/:productId"
                  element={<CatalogProductRoute user={user} />}
                />
                <Route
                  path="/catalog/inventory"
                  element={
                    <StockMatrixPage
                      key={`${user.id}:${state.storeId}`}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/catalog/inventory-pulls"
                  element={<InventoryPullPage key={user.id} user={user} />}
                />
                <Route
                  path="/catalog/products/:productId/audit"
                  element={<CatalogAuditRoute user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/catalog/stores/:storeId/snapshot"
                  element={<CatalogSnapshotRoute user={user} />}
                />
                <Route
                  path="/inventory/associations"
                  element={
                    <InventoryAssociationsPage
                      key={state.storeId}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/stores"
                  element={
                    <StoresPage
                      stores={stores.data || []}
                      onSelect={(id) => {
                        state.setStore(id);
                        navigate('/');
                      }}
                    />
                  }
                />
                <Route path="/sync" element={<SyncPage {...sync} />} />
                <Route path="/offline-billing" element={<OfflineBillingPage />} />
                <Route
                  path="/profile"
                  element={<ProfilePage key={user.id} user={user} online={sync.online} />}
                />
                <Route
                  path="/reports"
                  element={
                    <ReportsPage
                      key={`${user.id}:${state.storeId}`}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/reports/customer-feedback"
                  element={
                    <CustomerFeedbackPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/reports/order-transactions"
                  element={
                    <OrderTransactionsPage
                      key={state.storeId}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/reports/hyperlocal-daily"
                  element={
                    <HyperlocalDailyPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/reports/flash-sales"
                  element={
                    <FlashSalesPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/reports/exports"
                  element={
                    <ReportExportsPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/reports/hyperlocal-acceptance"
                  element={
                    <HyperlocalAcceptancePage
                      key={state.storeId}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/reports/returned-orders"
                  element={
                    <ReturnedOrdersPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/reports/salesperson-performance"
                  element={
                    <SalespersonPerformancePage
                      key={state.storeId}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/reports/cashier-performance"
                  element={
                    <CashierPerformancePage
                      key={state.storeId}
                      user={user}
                      storeId={state.storeId}
                    />
                  }
                />
                <Route
                  path="/fulfillment"
                  element={
                    <FulfillmentPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/local-deliveries"
                  element={
                    <LocalDeliveriesPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/day-close"
                  element={<DayClosePage key={state.storeId} user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/cash-ledger"
                  element={
                    <CashLedgerPage key={state.storeId} user={user} storeId={state.storeId} />
                  }
                />
                <Route
                  path="/reports/day-close-history"
                  element={<DayCloseHistoryPage user={user} storeId={state.storeId} />}
                />
                <Route
                  path="/administration"
                  element={
                    <AdministrationPage
                      user={user}
                      storeId={state.storeId}
                      onAuthenticationRevoked={() => clearLocalIdentity(client, user.id)}
                    />
                  }
                />
                <Route
                  path="/administration/permission-history"
                  element={<SpecialPermissionHistoryPage key={user.id} user={user} />}
                />
                <Route
                  path="/administration/model-history"
                  element={<AdministrationHistoryPage key={user.id} user={user} />}
                />
                <Route
                  path="/administration/gift-card-batches"
                  element={<GiftCardBatchesPage key={user.id} user={user} />}
                />
                <Route
                  path="/wallet-adjustments"
                  element={<WalletAdjustmentsPage key={user.id} user={user} online={sync.online} />}
                />
                <Route
                  path="/gift-vouchers"
                  element={<GlobalVouchersPage key={user.id} user={user} online={sync.online} />}
                />
                <Route
                  path="/monitoring"
                  element={<FulfillmentMonitoringPage user={user} storeId={state.storeId} />}
                />
                <Route path="/documentation" element={<DocumentationPage user={user} />} />
                <Route
                  path="/application-links"
                  element={<ApplicationLinksPage user={user} storeId={state.storeId} />}
                />
                <Route
                  path="*"
                  element={
                    <div className="empty">
                      <h2>Page not found.</h2>
                      <NavLink to="/">Back to the counter</NavLink>
                    </div>
                  }
                />
              </Routes>
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}
function CatalogProductRoute({ user }: { user: Principal }) {
  const { productId } = useParams();
  return productId && /^[1-9]\d{0,19}$/.test(productId) ? (
    <CatalogProductPage key={`${user.id}:${productId}`} user={user} productId={productId} />
  ) : (
    <Empty title="Product not found" />
  );
}
function CatalogAuditRoute({ user, storeId }: { user: Principal; storeId: string }) {
  const { productId } = useParams();
  return productId && /^[1-9]\d{0,19}$/.test(productId) ? (
    <InventoryAuditPage
      key={`${user.id}:${storeId}:${productId}`}
      user={user}
      storeId={storeId}
      productId={productId}
    />
  ) : (
    <Empty title="Product not found" />
  );
}
function CatalogSnapshotRoute({ user }: { user: Principal }) {
  const { storeId } = useParams();
  return storeId && /^[1-9]\d{0,19}$/.test(storeId) ? (
    <StoreCatalogPage key={`${user.id}:${storeId}`} user={user} storeId={storeId} />
  ) : (
    <Empty title="Store not found" />
  );
}
