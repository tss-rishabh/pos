import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import {
  offlineSaleUploadSchema,
  type OfflineSaleUpload,
} from '../../src/modules/offline-sync/contracts.js';
import type { OfflineSyncCoordinator, SaleRecord } from '../../src/modules/offline-sync/locks.js';
import { saleKeys } from '../../src/modules/offline-sync/locks.js';
import { readOfflineBillingOptions } from '../../src/modules/offline-sync/options.js';
import {
  offlineComment,
  offlineCommentPrefix,
  payableText,
  type OfflineOrder,
  type OfflineSyncRepository,
} from '../../src/modules/offline-sync/repository.js';
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
const billedAt = Date.UTC(2026, 10, 19, 9);
const upload = (overrides: Partial<OfflineSaleUpload> = {}): OfflineSaleUpload =>
  offlineSaleUploadSchema.parse({
    saleId: '0b9f1a2c-3d4e-4f50-8a61-7b8c9d0e1f2a',
    provisionalRef: reference,
    deviceId: 'abcdef0123456789abcdef0123456789',
    billedBy: '77',
    billedAt,
    lines: [{ productId: '1001', quantity: 2, unitPrice: '499.50' }],
    payable: '999.00',
    tender: { mode: 'cash', received: '1000.00' },
    resolution: null,
    ...overrides,
  });

/** In-memory stand-ins for the orders/comments tables and the Redis record/lock. */
function harness(
  options: {
    payable?: string;
    tenderFound?: boolean;
    stockCap?: number;
    submit?: () => Promise<CheckoutReply>;
  } = {},
) {
  const orders = new Map<string, OfflineOrder>();
  const comments: { orderId: string; comment: string; userId: string }[] = [];
  const created: string[] = [];
  let orderSeq = 5000;
  const repository: OfflineSyncRepository = {
    order: vi.fn(async (orderId: string) => {
      const order = orders.get(orderId);
      return order ? { ...order } : null;
    }),
    findByComment: vi.fn(async (ref: string, userIds: string[]) => {
      const row = comments.find(
        (item) =>
          item.comment.startsWith(offlineCommentPrefix(ref)) && userIds.includes(item.userId),
      );
      return row ? { ...orders.get(row.orderId)! } : null;
    }),
    commentExists: vi.fn(async (orderId: string, ref: string) =>
      comments.some(
        (item) => item.orderId === orderId && item.comment.startsWith(offlineCommentPrefix(ref)),
      ),
    ),
    recordReference: vi.fn(async (input) => {
      comments.push({
        orderId: input.orderId,
        comment: offlineComment(input.reference, input.billedAt),
        userId: input.userId,
      });
    }),
    tenderReferenceExists: vi.fn(async () => options.tenderFound ?? false),
  };
  const locks = new Map<string, string>(),
    records = new Map<string, SaleRecord>();
  const coordinator: OfflineSyncCoordinator = {
    lock: vi.fn(async (ref, owner) => {
      if (locks.has(ref)) return false;
      locks.set(ref, owner);
      return true;
    }),
    unlock: vi.fn(async (ref, owner) => {
      if (locks.get(ref) === owner) locks.delete(ref);
    }),
    record: vi.fn(async (ref) => records.get(ref) ?? null),
    saveRecord: vi.fn(async (ref, value) => void records.set(ref, value)),
    clearRecord: vi.fn(async (ref) => void records.delete(ref)),
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
      orders.set(orderId, {
        orderId,
        storeId: '12',
        counterId: '3',
        invoiceNumber: `TSS2627INV${orderId}`,
        paid: false,
        payable: options.payable ?? '999.00',
      });
      s.phase = 'submitted';
      s.orderId = orderId;
      s.version++;
      if (options.submit) return options.submit();
      return ok(id, { orderId, invoice: `TSS2627INV${orderId}` });
    }),
  };
  const payments = {
    start: vi.fn(async (_user: Principal, _store: string, orderId: string) => {
      orders.get(orderId)!.paid = true;
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
    limits: { maxMinutes: 120, maxOrders: 10 },
    now: () => billedAt + 3600_000,
  });
  return {
    service,
    repository,
    coordinator,
    checkout,
    payments,
    orders,
    comments,
    created,
    locks,
    records,
  };
}

describe('offline sale sync', () => {
  it('creates the order through the checkout path and records a legacy comment', async () => {
    const h = harness();
    const result = await h.service.sync(cashier, '12', '3', upload());
    expect(result).toEqual({
      status: 'created',
      orderId: '5001',
      invoiceNumber: 'TSS2627INV5001',
      provisionalRef: reference,
    });
    expect(h.comments).toEqual([
      {
        orderId: '5001',
        comment: 'Offline bill OFF-12-3-ABCDEF01-1 billed at 2026-11-19T09:00:00.000Z',
        userId: '77',
      },
    ]);
    expect(h.records.get(reference)).toEqual({
      state: 'done',
      orderId: '5001',
      invoiceNo: 'TSS2627INV5001',
    });
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
  });

  it('marks the sale in-flight before calling the checkout service', async () => {
    const h = harness();
    vi.mocked(h.checkout.create).mockImplementationOnce(async () => {
      expect(h.records.get(reference)).toMatchObject({ state: 'in-flight', submitting: false });
      throw new AppError(502, 'UPSTREAM', 'down');
    });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toBeInstanceOf(AppError);
    // Nothing was submitted, so the record is cleared and a retry is safe.
    expect(h.records.has(reference)).toBe(false);
  });

  it('is idempotent via the Redis record: a replay never creates another order', async () => {
    const h = harness();
    await h.service.sync(cashier, '12', '3', upload());
    const replay = await h.service.sync(cashier, '12', '3', upload());
    expect(replay).toMatchObject({ status: 'existing', orderId: '5001' });
    expect(h.created).toEqual(['5001']);
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    expect(h.payments.start).toHaveBeenCalledTimes(1);
    expect(h.comments).toHaveLength(1);
  });

  it('falls back to the durable comment when the Redis record is gone', async () => {
    const h = harness();
    await h.service.sync(cashier, '12', '3', upload());
    h.records.clear();
    const replay = await h.service.sync(manager, '12', '3', upload());
    expect(replay).toMatchObject({ status: 'existing', orderId: '5001' });
    expect(h.repository.findByComment).toHaveBeenCalledWith(
      reference,
      ['5', '77'],
      billedAt - 24 * 3600_000,
      billedAt + 2 * 3600_000,
    );
    expect(h.created).toHaveLength(1);
    expect(h.records.get(reference)).toMatchObject({ state: 'done', orderId: '5001' });
  });

  it('finishes the comment and payment for a done record left incomplete', async () => {
    const h = harness();
    h.orders.set('4000', {
      orderId: '4000',
      storeId: '12',
      counterId: '3',
      invoiceNumber: 'INV4000',
      paid: false,
      payable: '999.00',
    });
    h.records.set(reference, { state: 'done', orderId: '4000', invoiceNo: 'INV4000' });
    const result = await h.service.sync(cashier, '12', '3', upload());
    expect(result).toMatchObject({ status: 'existing', orderId: '4000' });
    expect(h.checkout.create).not.toHaveBeenCalled();
    expect(h.comments).toHaveLength(1);
    expect(h.payments.start).toHaveBeenCalledTimes(1);
  });

  it('returns an unknown outcome to the manager and never resubmits after an uncertain submit', async () => {
    const h = harness({
      submit: async () => {
        throw new AppError(502, 'CHECKOUT_OUTCOME_UNCERTAIN', 'network');
      },
    });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    expect(h.records.get(reference)).toMatchObject({ state: 'in-flight', submitting: true });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    expect(h.comments).toHaveLength(0);
  });

  it('lets a manager record an order that was in fact created (read only, no resubmit)', async () => {
    const h = harness({
      submit: async () => {
        throw new AppError(502, 'CHECKOUT_OUTCOME_UNCERTAIN', 'network');
      },
    });
    await expect(h.service.sync(manager, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    const accepted = upload({
      resolution: { action: 'accept', managerId: '5', reason: 'Order found in history' },
    });
    const result = await h.service.sync(manager, '12', '3', accepted);
    expect(result).toMatchObject({ status: 'created', orderId: '5001' });
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    expect(h.comments).toHaveLength(1);
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

  it('returns conflicts for price change, stock shortfall, unknown tender reference and revoked operator', async () => {
    const price = harness({ payable: '1099.00' });
    await expect(price.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      status: 409,
      code: 'OFFLINE_CONFLICT_PRICE_CHANGED',
    });
    expect(price.records.size).toBe(0);
    await expect(
      harness({ stockCap: 1 }).service.sync(cashier, '12', '3', upload()),
    ).rejects.toMatchObject({ code: 'OFFLINE_CONFLICT_STOCK_SHORTFALL' });
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

  it('accepts a manager price resolution and charges the authoritative payable', async () => {
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

  it('validates scope, totals and operator before touching any store', async () => {
    const h = harness();
    await expect(h.service.sync(cashier, '12', '4', upload())).rejects.toMatchObject({
      code: 'SCOPE_MISMATCH',
    });
    await expect(
      h.service.sync(cashier, '12', '3', upload({ payable: '998.00' })),
    ).rejects.toMatchObject({ code: 'INVALID_OFFLINE_TOTAL' });
    await expect(
      h.service.sync({ ...cashier, id: '88' }, '12', '3', upload()),
    ).rejects.toMatchObject({ code: 'OFFLINE_SALE_OPERATOR_MISMATCH' });
    await expect(
      h.service.sync({ ...cashier, storeIds: ['99'] }, '12', '3', upload()),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    expect(h.coordinator.lock).not.toHaveBeenCalled();
  });

  it('rejects coupons, wallet or other benefit fields in the upload', () => {
    expect(() => offlineSaleUploadSchema.parse({ ...upload(), coupon: 'SAVE10' })).toThrow();
    expect(() =>
      offlineSaleUploadSchema.parse({ ...upload(), tender: { mode: 'wallet', amount: '10.00' } }),
    ).toThrow();
  });

  it('uses the Redis key pos:offline_sale:<ref>', () => {
    expect(saleKeys.record(reference)).toBe('pos:offline_sale:OFF-12-3-ABCDEF01-1');
  });
});

describe('offline billing limits from the backend environment', () => {
  it('defaults to 120 minutes and 10 orders', () => {
    expect(readOfflineBillingOptions({})).toEqual({ maxMinutes: 120, maxOrders: 10 });
    expect(
      readOfflineBillingOptions({
        OFFLINE_BILLING_MAX_MINUTES: '',
        OFFLINE_BILLING_MAX_ORDERS: '',
      }),
    ).toEqual({ maxMinutes: 120, maxOrders: 10 });
  });
  it('reads configured positive integers', () => {
    expect(
      readOfflineBillingOptions({
        OFFLINE_BILLING_MAX_MINUTES: '5',
        OFFLINE_BILLING_MAX_ORDERS: '3',
      }),
    ).toEqual({ maxMinutes: 5, maxOrders: 3 });
  });
  it.each(['0', '-1', '1.5', 'ten'])('rejects %s', (value) => {
    expect(() => readOfflineBillingOptions({ OFFLINE_BILLING_MAX_ORDERS: value })).toThrow();
  });
  it('is returned by the settings endpoint service', () => {
    expect(harness().service.settings()).toEqual({ maxMinutes: 120, maxOrders: 10 });
  });
});

describe('legacy comment rows', () => {
  it('formats the comment with an exact, non-ambiguous prefix', () => {
    expect(offlineComment(reference, billedAt)).toBe(
      'Offline bill OFF-12-3-ABCDEF01-1 billed at 2026-11-19T09:00:00.000Z',
    );
    expect(
      offlineComment('OFF-12-3-ABCDEF01-10', billedAt).startsWith(offlineCommentPrefix(reference)),
    ).toBe(false);
  });
  it('renders double pay_amt to exact two-decimal text', () => {
    expect(payableText(999)).toBe('999.00');
    expect(payableText(0.1 + 0.2)).toBe('0.30');
  });
});
