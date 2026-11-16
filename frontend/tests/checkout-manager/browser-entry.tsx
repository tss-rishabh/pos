import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setRequestOperator } from '../../src/api/client';
import type { Principal } from '../../src/api/types';
import { db } from '../../src/offline/database';
import {
  createCashDeviceKeys,
  signCashReceipt,
  verifyCashDeviceReceipt,
} from '../../src/offline/cash/crypto';
import type {
  CashReceipt,
  DevicePublicKey,
  SignedCashReceipt,
} from '../../src/offline/cash/contracts';
import { CashManagerDialog } from '../../src/pages/checkout/offline-cash/manager';
import '../../src/styles.css';

const user: Principal = {
  id: '1',
  name: 'Fixture manager',
  email: 'manager@example.test',
  role: 4,
  userType: 1,
  storeIds: ['1'],
};
const issuedAt = Date.parse('2026-11-16T09:30:00+05:30'),
  expiresAt = issuedAt + 600_000,
  authorizationId = '65b5c07c-b7a6-4a58-bcd3-991df3fca36a',
  deviceId = crypto.randomUUID();
interface Fixture {
  envelopes: SignedCashReceipt[];
  publicKey: DevicePublicKey;
  authorizationWindow: {
    issuedAt: number;
    expiresAt: number;
    businessDate: string;
    timeZone: string;
  };
  snapshot: () => Promise<{ receipts: unknown[]; jobs: unknown[] }>;
  verify: (envelope: SignedCashReceipt) => Promise<boolean>;
  expire: () => Promise<void>;
  changeCachedScope: () => Promise<void>;
  changeOperator: () => void;
}
declare global {
  interface Window {
    cashManagerFixture: Fixture;
  }
}
setRequestOperator(user.id);
await db.sessions.put({ id: 'current', user, expiresAt: Date.now() + 300_000 });
const device = await createCashDeviceKeys();
await db.offlineCashDevices.put({
  ownerId: '44',
  deviceId,
  storeId: '1',
  counterId: '2',
  createdAt: issuedAt,
  ...device,
});
const receipt: CashReceipt = {
  version: 1,
  id: crypto.randomUUID(),
  authorizationId,
  deviceId,
  operatorId: '44',
  storeId: '1',
  counterId: '2',
  businessDate: '2026-11-16',
  draftId: crypto.randomUUID(),
  draftVersion: issuedAt,
  sequence: 1,
  receiptNumber: 'OC-' + authorizationId.replaceAll('-', '').toUpperCase() + '-0001',
  completedAt: expiresAt + 600_000,
  currency: 'INR',
  snapshotId: crypto.randomUUID(),
  snapshotHash: 'a'.repeat(64),
  stockPolicy: 'cached-stock-manager',
  lines: [
    {
      productId: '9007199254740993',
      name: 'Source-priced product <script>unsafe()</script>',
      barcode: 'FIXTURE',
      hsn: '6109',
      quantity: 2,
      unitPrice: '199.99',
      mainSubtotalCents: 39998,
      taxableCents: 38093,
      taxCents: 1905,
      invoiceGst: '5',
    },
  ],
  taxableCents: 38093,
  taxCents: 1905,
  roundingCents: 98,
  payableCents: 39900,
  cashReceivedCents: 50000,
  changeCents: 10100,
};
const envelopes = await Promise.all(
  Array.from({ length: 29 }, (_, index) =>
    signCashReceipt(
      {
        ...receipt,
        id: crypto.randomUUID(),
        draftId: crypto.randomUUID(),
        sequence: index + 1,
        receiptNumber:
          'OC-' +
          authorizationId.replaceAll('-', '').toUpperCase() +
          '-' +
          String(index + 1).padStart(4, '0'),
      },
      device.privateKey,
    ),
  ),
);
const envelope = envelopes[0]!,
  original = envelope.receipt;
if (!(await db.offlineCashReceipts.get(['44', original.id]))) {
  await db.offlineCashReceipts.add({
    ownerId: '44',
    receiptId: original.id,
    draftId: original.draftId,
    storeId: '1',
    counterId: '2',
    authorizationId,
    sequence: 1,
    envelope,
    completedAt: original.completedAt,
    acceptance: null,
    syncState: 'pending',
    importedAt: null,
    preservedDraftId: null,
    replacementDraftId: crypto.randomUUID(),
  });
  await db.offlineCashSync.add({
    receiptId: original.id,
    ownerId: '44',
    storeId: '1',
    state: 'pending',
    attempts: 0,
    nextAttemptAt: 0,
    claimId: null,
    claimedAt: null,
    errorCode: null,
  });
}
window.cashManagerFixture = {
  envelopes,
  publicKey: device.publicKey,
  authorizationWindow: {
    issuedAt,
    expiresAt,
    businessDate: '2026-11-16',
    timeZone: 'Asia/Kolkata',
  },
  snapshot: async () => ({
    receipts: await db.offlineCashReceipts.toArray(),
    jobs: await db.offlineCashSync.toArray(),
  }),
  verify: (value) => verifyCashDeviceReceipt(value, device.publicKey),
  expire: async () => {
    await db.sessions.update('current', { expiresAt: Date.now() - 1 });
  },
  changeCachedScope: async () => {
    await db.sessions.update('current', { user: { ...user, role: 5 } });
  },
  changeOperator: () => setRequestOperator('9'),
};
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
        })
      }
    >
      <BrowserRouter>
        <CashManagerDialog
          user={user}
          storeId="1"
          online={new URL(location.href).searchParams.get('offline') !== '1'}
          onClose={() => {
            document.getElementById('root')!.textContent = 'Closed manager';
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
