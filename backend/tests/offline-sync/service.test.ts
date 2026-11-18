import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import {
  offlineSaleUploadSchema,
  type OfflineSaleUpload,
} from '../../src/modules/offline-sync/contracts.js';
import type { OfflineSyncCoordinator } from '../../src/modules/offline-sync/locks.js';
import type {
  ExistingOfflineOrder,
  OfflineSyncRepository,
} from '../../src/modules/offline-sync/repository.js';
import { payableText } from '../../src/modules/offline-sync/repository.js';
import {
  offlineSyncService,
  type CheckoutReply,
  type OfflineCheckoutPort,
} from '../../src/modules/offline-sync/service.js';

const cashier: Principal = {
  id: '77',
  name: 'Cashier',
  email: 'c@example.invalid',
  role: 5,
  userType: 2,
  storeIds: ['12'],
};
const manager: Principal = { ...cashier, id: '5', role: 4 };
const reference = 'OFF-12-3-ABCDEF01-1';
const upload = (overrides: Partial<OfflineSaleUpload> = {}): OfflineSaleUpload =>
  offlineSaleUploadSchema.parse({
    saleId: '0b9f1a2c-3d4e-4f50-8a61-7b8c9d0e1f2a',
    provisionalRef: reference,
    deviceId: 'abcdef0123456789abcdef0123456789',
    billedBy: '77',
    billedAt: Date.UTC(2026, 10, 19, 9),
    lines: [{ productId: '1001', quantity: 2, unitPrice: '499.50' }],
    payable: '999.00',
    tender: { mode: 'cash', received: '1000.00' },
    resolution: null,
    ...overrides,
  });

/** In-memory stand-ins: orders table keyed by order_ref_no, Redis lock and progress. */
function harness(options: { payable?: string; tenderFound?: boolean; stockCap?: number } = {}) {
  const orders = new Map<string, ExistingOfflineOrder>();
  const created: string[] = [];
  let orderSeq = 5000;
  const repository: OfflineSyncRepository = {
    findByReference: vi.fn(async (ref: string) => {
      const order = orders.get(ref);
      return order ? [{ ...order }] : [];
    }),
    stampReference: vi.fn(async (orderId: string, ref: string) => {
      orders.set(ref, {
        orderId,
        storeId: '12',
        counterId: '3',
        invoiceNumber: `TSS2627INV${orderId}`,
        paid: false,
        payable: options.payable ?? '999.00',
      });
    }),
    tenderReferenceExists: vi.fn(async () => options.tenderFound ?? false),
    settings: vi.fn(async () => ({})),
  };
  const locks = new Map<string, string>(),
    progress = new Map<string, { checkoutId: string; operatorId: string }>();
  const coordinator: OfflineSyncCoordinator = {
    lock: vi.fn(async (ref, owner) => {
      if (locks.has(ref)) return false;
      locks.set(ref, owner);
      return true;
    }),
    unlock: vi.fn(async (ref, owner) => {
      if (locks.get(ref) === owner) locks.delete(ref);
    }),
    progress: vi.fn(async (ref) => progress.get(ref) ?? null),
    saveProgress: vi.fn(async (ref, value) => void progress.set(ref, value)),
    clearProgress: vi.fn(async (ref) => void progress.delete(ref)),
    close: vi.fn(async () => undefined),
  };
  const sessions = new Map<
    string,
    {
      id: string;
      version: number;
      phase: string;
      orderId: string | null;
      items: Map<string, number>;
      quote: Record<string, unknown> | null;
    }
  >();
  const state = (id: string) => {
    const s = sessions.get(id)!;
    return {
      id: s.id,
      version: s.version,
      phase: s.phase,
      orderId: s.orderId,
      customerId: null,
      cart: {
        products: { items: [...s.items].map(([prod_id, quantity]) => ({ prod_id, quantity })) },
      },
      quote: s.quote,
    };
  };
  const ok = (id: string, result: Record<string, unknown> = {}): CheckoutReply => ({
    status: 'succeeded',
    state: state(id),
    result,
  });
  const checkout: OfflineCheckoutPort = {
    create: vi.fn(async () => {
      const id = crypto.randomUUID();
      sessions.set(id, {
        id,
        version: 0,
        phase: 'open',
        orderId: null,
        items: new Map(),
        quote: null,
      });
      return state(id);
    }),
    read: vi.fn(async (_user, _store, id: string) => state(id)),
    setLine: vi.fn(
      async (_user, _store, id: string, _input, productId: string, quantity: number) => {
        const s = sessions.get(id)!;
        s.items.set(productId, Math.min(quantity, options.stockCap ?? quantity));
        s.version++;
        return ok(id);
      },
    ),
    quote: vi.fn(async (_user, _store, id: string) => {
      const s = sessions.get(id)!;
      s.quote = { payable: options.payable ?? '999.00' };
      s.phase = 'quoted';
      s.version++;
      return ok(id);
    }),
    submit: vi.fn(async (_user, _store, id: string) => {
      const s = sessions.get(id)!;
      const orderId = String(++orderSeq);
      created.push(orderId);
      s.phase = 'submitted';
      s.orderId = orderId;
      s.version++;
      return ok(id, { orderId });
    }),
  };
  const payments = {
    start: vi.fn(async (_user: Principal, _store: string, orderId: string) => {
      for (const order of orders.values()) if (order.orderId === orderId) order.paid = true;
      return {};
    }),
  };
  const service = offlineSyncService({
    repository,
    coordinator,
    checkout,
    payments,
    operators: {
      get: vi.fn(async (id: string) => (id === '77' ? cashier : id === '5' ? manager : null)),
    },
    operationSecret: 'test-secret',
    quotePayable: (quote) => String(quote.payable),
  });
  return { service, repository, coordinator, checkout, payments, orders, created, locks, progress };
}

describe('offline sale sync', () => {
  it('creates the order through the checkout path and stamps the provisional reference', async () => {
    const h = harness();
    const result = await h.service.sync(cashier, '12', '3', upload());
    expect(result).toEqual({
      status: 'created',
      orderId: '5001',
      invoiceNumber: 'TSS2627INV5001',
      provisionalRef: reference,
    });
    expect(h.checkout.setLine).toHaveBeenCalledWith(
      cashier,
      '12',
      expect.any(String),
      expect.objectContaining({ expectedVersion: 0 }),
      '1001',
      2,
    );
    expect(h.repository.stampReference).toHaveBeenCalledWith('5001', reference);
    expect(h.payments.start).toHaveBeenCalledWith(cashier, '12', '5001', {
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      channel: 'cash',
      onlineAmount: '0.00',
      cashAmount: '999.00',
      cashReceived: '1000.00',
    });
    expect(h.locks.size).toBe(0);
    expect(h.progress.size).toBe(0);
  });

  it('is idempotent: a replayed upload returns the existing order and never creates another', async () => {
    const h = harness();
    await h.service.sync(cashier, '12', '3', upload());
    const replay = await h.service.sync(cashier, '12', '3', upload());
    expect(replay).toMatchObject({ status: 'existing', orderId: '5001' });
    expect(h.created).toEqual(['5001']);
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    expect(h.payments.start).toHaveBeenCalledTimes(1);
  });

  it('finishes payment for an existing unpaid order on retry', async () => {
    const h = harness();
    h.orders.set(reference, {
      orderId: '4000',
      storeId: '12',
      counterId: '3',
      invoiceNumber: 'INV4000',
      paid: false,
      payable: '999.00',
    });
    const result = await h.service.sync(cashier, '12', '3', upload());
    expect(result).toMatchObject({ status: 'existing', orderId: '4000' });
    expect(h.checkout.create).not.toHaveBeenCalled();
    expect(h.payments.start).toHaveBeenCalledTimes(1);
  });

  it('refuses concurrent uploads of the same reference with a retryable lock error', async () => {
    const h = harness();
    h.locks.set(reference, 'someone-else');
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      status: 503,
      code: 'OFFLINE_SYNC_IN_PROGRESS',
    });
    expect(h.checkout.create).not.toHaveBeenCalled();
  });

  it('resumes the same checkout after an interrupted attempt (no duplicate order)', async () => {
    const h = harness();
    const original = h.checkout.submit;
    h.checkout.submit = vi.fn(async () => {
      throw new AppError(502, 'CHECKOUT_OUTCOME_UNCERTAIN', 'network');
    });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toBeInstanceOf(AppError);
    expect(h.progress.get(reference)).toMatchObject({ operatorId: '77' });
    h.checkout.submit = original;
    await h.service.sync(cashier, '12', '3', upload());
    expect(h.checkout.create).toHaveBeenCalledTimes(1);
    expect(h.created).toHaveLength(1);
  });

  it('returns conflicts for price change, stock shortfall, unknown tender reference and revoked operator', async () => {
    await expect(
      harness({ payable: '1099.00' }).service.sync(cashier, '12', '3', upload()),
    ).rejects.toMatchObject({
      status: 409,
      code: 'OFFLINE_CONFLICT_PRICE_CHANGED',
    });
    await expect(
      harness({ stockCap: 1 }).service.sync(cashier, '12', '3', upload()),
    ).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_STOCK_SHORTFALL',
    });
    const card = upload({ tender: { mode: 'card', reference: 'RRN12345' } });
    await expect(harness().service.sync(cashier, '12', '3', card)).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_TENDER_REFERENCE_NOT_FOUND',
    });
    await expect(
      harness().service.sync(manager, '12', '3', upload({ billedBy: '404' })),
    ).rejects.toMatchObject({ code: 'OFFLINE_CONFLICT_OPERATOR_REVOKED' });
  });

  it('records a matched card/UPI reference as an operator-recorded online tender', async () => {
    const h = harness({ tenderFound: true });
    await h.service.sync(
      cashier,
      '12',
      '3',
      upload({ tender: { mode: 'upi', reference: 'UPI-REF-1' } }),
    );
    expect(h.payments.start).toHaveBeenCalledWith(
      cashier,
      '12',
      '5001',
      expect.objectContaining({
        channel: 'other',
        onlineAmount: '999.00',
        cashAmount: '0.00',
        externalReference: 'UPI-REF-1',
      }),
    );
  });

  it('accepts a manager resolution and charges the authoritative payable', async () => {
    const h = harness({ payable: '1099.00' });
    const resolved = upload({
      tender: { mode: 'card', reference: 'RRN12345' },
      resolution: { action: 'accept', managerId: '5', reason: 'Price list changed during outage' },
    });
    await expect(h.service.sync(cashier, '12', '3', resolved)).rejects.toMatchObject({
      code: 'MANAGER_REQUIRED',
    });
    const result = await h.service.sync(manager, '12', '3', resolved);
    expect(result.status).toBe('created');
    expect(h.payments.start).toHaveBeenCalledWith(
      manager,
      '12',
      '5001',
      expect.objectContaining({ onlineAmount: '1099.00' }),
    );
  });

  it('validates scope, totals and operator before any lookup', async () => {
    const h = harness();
    await expect(h.service.sync(cashier, '12', '4', upload())).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
    });
    await expect(
      h.service.sync(cashier, '12', '3', upload({ payable: '998.00' })),
    ).rejects.toMatchObject({
      code: 'INVALID_OFFLINE_TOTAL',
    });
    await expect(
      h.service.sync({ ...cashier, id: '88' }, '12', '3', upload()),
    ).rejects.toMatchObject({ code: 'OFFLINE_SALE_OPERATOR_MISMATCH' });
    await expect(
      h.service.sync({ ...cashier, storeIds: ['99'] }, '12', '3', upload()),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    expect(h.repository.findByReference).not.toHaveBeenCalled();
  });

  it('rejects coupons, wallet or other benefit fields in the upload', () => {
    expect(() => offlineSaleUploadSchema.parse({ ...upload(), coupon: 'SAVE10' })).toThrow();
    expect(() =>
      offlineSaleUploadSchema.parse({ ...upload(), tender: { mode: 'wallet', amount: '10.00' } }),
    ).toThrow();
  });

  it('reads tss_settings limits with 120/10 defaults', async () => {
    const h = harness();
    expect(await h.service.settings()).toEqual({ maxMinutes: 120, maxOrders: 10 });
    vi.mocked(h.repository.settings).mockResolvedValueOnce({
      POS_OFFLINE_BILLING_MAX_MINUTES: '5',
      POS_OFFLINE_BILLING_MAX_ORDERS: '3',
    });
    expect(await h.service.settings()).toEqual({ maxMinutes: 5, maxOrders: 3 });
  });

  it('renders double pay_amt to exact two-decimal text', () => {
    expect(payableText(999)).toBe('999.00');
    expect(payableText(0.1 + 0.2)).toBe('0.30');
  });
});
