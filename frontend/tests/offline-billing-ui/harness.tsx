import { createRoot } from 'react-dom/client';
import type { DesktopOfflineBridge } from '../../src/offline/billing/bridge';
import type { IpcChannel, OfflineSale, OfflineStatus } from '../../src/offline/billing/contracts';
import '../../src/styles.css';

/**
 * The offline billing page against a fake desktop bridge (the Electron preload is absent in a
 * browser). The test drives the resolve outcome through `window.offlineHarness`.
 */
interface HarnessControl {
  resolve: 'fail' | 'hold' | 'ok';
  release: () => void;
  calls: IpcChannel[];
}
declare global {
  interface Window {
    offlineHarness: HarnessControl;
  }
}
const control: HarnessControl = { resolve: 'fail', release: () => undefined, calls: [] };
window.offlineHarness = control;

const saleId = '0b9f1a2c-3d4e-4f50-8a61-7b8c9d0e1f2a';
let sale: OfflineSale = {
  saleId,
  provisionalRef: 'OFF-12-3-ABCDEF01-1',
  storeId: '12',
  counterId: '3',
  operatorId: '5',
  operatorName: 'Manager',
  salespersonId: '4401',
  createdAt: Date.UTC(2026, 10, 20, 9),
  status: 'needs_manager',
  lines: [{ productId: '1001', name: 'Tee', unitPricePaise: 49900, quantity: 1 }],
  grossPaise: 49900,
  roundingPaise: 0,
  payablePaise: 49900,
  tender: { mode: 'cash', receivedPaise: 50000, changePaise: 100 },
  orderId: null,
  invoiceNumber: null,
  syncedAt: null,
  attempts: 1,
  conflict: {
    code: 'OUTCOME_UNKNOWN',
    message: 'A manager must check Orders.',
    createdAt: Date.UTC(2026, 10, 20, 9),
  },
  resolution: null,
};
const status = (): OfflineStatus => ({
  available: true,
  unavailableReason: null,
  online: true,
  reachabilityKnown: true,
  lastContactAt: Date.UTC(2026, 10, 20, 9),
  operator: {
    id: '5',
    name: 'Manager',
    manager: true,
    storeId: '12',
    counterId: null,
    eligible: true,
    message: 'Ready to bill offline.',
  },
  counters: [{ id: '3', name: 'Counter 3' }],
  limits: {
    allowed: true,
    reason: null,
    minutesUsed: 0,
    ordersUsed: sale.status === 'needs_manager' ? 1 : 0,
    maxMinutes: 120,
    maxOrders: 10,
    message: 'Offline billing available.',
  },
  catalog: { storeId: '12', products: 2, refreshedAt: Date.UTC(2026, 10, 20, 9), truncated: true },
  queue: {
    queued: 0,
    syncing: 0,
    needsManager: sale.status === 'needs_manager' ? 1 : 0,
    synced: sale.status === 'synced' ? 1 : 0,
    voided: 0,
  },
  syncing: false,
  lastSyncAt: null,
  lastSyncError: null,
});
const requestId = '6f1c1d3e-2f0a-4b8e-9c55-3a1d2b4c5e6f';
const ok = (data: unknown) => ({ ok: true, requestId, data });
const bridge: DesktopOfflineBridge = {
  version: 1,
  async invoke(channel) {
    control.calls.push(channel);
    if (channel === 'offline:status') return ok(status());
    if (channel === 'offline:sale:list') return ok({ sales: [sale] });
    if (channel === 'offline:conflict:resolve') {
      if (control.resolve === 'fail')
        return {
          ok: false,
          requestId,
          error: { code: 'MANAGER_REQUIRED', message: 'A store manager must be signed in.' },
        };
      if (control.resolve === 'hold')
        await new Promise<void>((release) => (control.release = release));
      sale = { ...sale, status: 'synced', conflict: null, orderId: '9001', syncedAt: Date.now() };
      return ok({ sale });
    }
    return { ok: false, requestId, error: { code: 'UNEXPECTED', message: 'Not in the harness.' } };
  },
  onStatusChanged: () => () => undefined,
};
window.souledOfflineBilling = bridge;

function Bomb(): never {
  throw new Error('Synthetic render failure');
}

// Imported after the bridge exists: the page reads it while rendering.
const { default: OfflineBillingPage, OfflineBillingBoundary } =
  await import('../../src/pages/offline-billing');
const crash = new URLSearchParams(location.search).get('crash') === '1';
createRoot(document.getElementById('root')!).render(
  crash ? (
    <OfflineBillingBoundary>
      <Bomb />
    </OfflineBillingBoundary>
  ) : (
    <OfflineBillingPage />
  ),
);
