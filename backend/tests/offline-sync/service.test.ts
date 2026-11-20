import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import { AppError } from '../../src/domain/errors.js';
import {
  offlineSaleUploadSchema,
  type OfflineSaleUpload,
} from '../../src/modules/offline-sync/contracts.js';
import type {
  DeviceSale,
  OfflineSyncCoordinator,
  SaleRecord,
} from '../../src/modules/offline-sync/locks.js';
import { saleKeys } from '../../src/modules/offline-sync/locks.js';
import { readOfflineBillingOptions } from '../../src/modules/offline-sync/options.js';
import {
  offlineComment,
  offlineCommentPrefix,
  payableText,
  reconciliationComment,
  reconciliationPrefix,
  unconfirmedMatch,
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
    salespersonId: '4401',
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
    now?: () => number;
  } = {},
) {
  const orders = new Map<string, OfflineOrder>();
  const orderLines = new Map<string, { productId: string; quantity: number }[]>();
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
    tenderMatch: vi.fn(async () =>
      options.tenderFound === undefined
        ? ('missing' as const)
        : options.tenderFound
          ? ('matched' as const)
          : ('mismatch' as const),
    ),
    reconciliationFlagged: vi.fn(async (orderId: string, ref: string) =>
      comments.some(
        (item) => item.orderId === orderId && item.comment.startsWith(reconciliationPrefix(ref)),
      ),
    ),
    flagReconciliation: vi.fn(async (flag) => {
      comments.push({
        orderId: flag.orderId,
        comment: reconciliationComment(flag),
        userId: flag.userId,
      });
    }),
    unconfirmedOrder: vi.fn(async (query) => {
      for (const [orderId, order] of [...orders].reverse()) {
        if (order.storeId !== query.storeId || order.counterId !== query.counterId) continue;
        const match = unconfirmedMatch(query, {
          paymentStatus: order.paid ? 4 : 1,
          lines: orderLines.get(orderId) ?? [],
          offlineComments: comments
            .filter((item) => item.orderId === orderId && item.comment.startsWith('Offline bill '))
            .map((item) => item.comment),
        });
        if (match) return orderId;
      }
      return null;
    }),
    linkCandidate: vi.fn(async (orderId: string) => {
      const order = orders.get(orderId);
      if (!order) return null;
      return {
        order: { ...order },
        createdAt: '2026-11-19 15:00:00',
        lines: [{ productId: '1001', quantity: 2 }],
        offlineComments: comments
          .filter((item) => item.orderId === orderId)
          .map((item) => item.comment),
      };
    }),
  };
  const locks = new Map<string, string>(),
    records = new Map<string, SaleRecord>(),
    devices = new Map<string, Map<string, DeviceSale>>();
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
    deviceSales: vi.fn(async (deviceId) => new Map(devices.get(deviceId) ?? [])),
    saveDeviceSale: vi.fn(async (deviceId, ref, value, stale) => {
      const sales = devices.get(deviceId) ?? new Map<string, DeviceSale>();
      for (const item of stale) sales.delete(item);
      sales.set(ref, value);
      devices.set(deviceId, sales);
    }),
    close: vi.fn(async () => undefined),
  };
  const sessions = new Map<
    string,
    {
      id: string;
      version: number;
      phase: string;
      orderId: string | null;
      salespersonId: string | null;
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
      salespersonId: s.salespersonId,
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
        salespersonId: null,
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
    salesperson: vi.fn(async (_user, _store, id: string, _input, salespersonId: string) => {
      const s = sessions.get(id)!;
      s.salespersonId = salespersonId;
      s.version++;
      return ok(id);
    }),
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
      orderLines.set(
        orderId,
        [...s.items].map(([productId, quantity]) => ({ productId, quantity })),
      );
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
    now: options.now ?? (() => billedAt + 3600_000),
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
    devices,
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

  it('lets a manager link the order found in Orders, verifying it matches the sale', async () => {
    const h = harness({
      submit: async () => {
        throw new AppError(502, 'CHECKOUT_OUTCOME_UNCERTAIN', 'network');
      },
    });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    const linked = (orderId: string) =>
      upload({
        resolution: { action: 'link-order', managerId: '5', reason: 'Found in Orders', orderId },
      });
    await expect(h.service.sync(manager, '12', '3', linked('9999'))).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    const result = await h.service.sync(manager, '12', '3', linked('5001'));
    expect(result).toMatchObject({ status: 'existing', orderId: '5001' });
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    expect(h.comments).toHaveLength(1);
  });

  it('creates the order once more only when a manager confirms that none exists', async () => {
    let failures = 1;
    const h = harness({
      submit: async () => {
        if (failures-- > 0) throw new AppError(502, 'CHECKOUT_OUTCOME_UNCERTAIN', 'network');
        return { status: 'succeeded', state: {}, result: { orderId: '5002', invoice: null } };
      },
    });
    await expect(h.service.sync(manager, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    // The submitting checkout knows no order; plain accept still never resubmits.
    const record = h.records.get(reference),
      read = h.checkout.read;
    const submitted = record?.state === 'in-flight' ? record.checkoutId : null;
    h.checkout.read = vi.fn(async (user: Principal, store: string, id: string) =>
      id === submitted
        ? {
            id,
            version: 3,
            phase: 'uncertain',
            orderId: null,
            customerId: null,
            cart: null,
            quote: null,
          }
        : read(user, store, id),
    );
    await expect(
      h.service.sync(
        manager,
        '12',
        '3',
        upload({ resolution: { action: 'accept', managerId: '5', reason: 'Retry please' } }),
      ),
    ).rejects.toMatchObject({ code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN' });
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    const result = await h.service.sync(
      manager,
      '12',
      '3',
      upload({ resolution: { action: 'recreate', managerId: '5', reason: 'No order in Orders' } }),
    );
    expect(result).toMatchObject({ status: 'created', orderId: '5002' });
    expect(h.checkout.submit).toHaveBeenCalledTimes(2);
  });

  it('assigns the chosen salesperson and reports pre-dispatch refusals as definite conflicts', async () => {
    const h = harness({
      submit: async () => {
        throw new AppError(422, 'SALESPERSON_REQUIRED', 'Please Select The Salesperson.');
      },
    });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_REJECTED',
      message: 'Please Select The Salesperson.',
    });
    expect(h.checkout.salesperson).toHaveBeenCalledWith(
      cashier,
      '12',
      expect.any(String),
      expect.objectContaining({ expectedVersion: 1 }),
      '4401',
    );
    expect(h.records.has(reference)).toBe(false);
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

  it('returns conflicts for price change, stock shortfall and revoked operator', async () => {
    const price = harness({ payable: '1099.00' });
    await expect(price.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      status: 409,
      code: 'OFFLINE_CONFLICT_PRICE_CHANGED',
    });
    expect(price.records.size).toBe(0);
    await expect(
      harness({ stockCap: 1 }).service.sync(cashier, '12', '3', upload()),
    ).rejects.toMatchObject({ code: 'OFFLINE_CONFLICT_STOCK_SHORTFALL' });
    await expect(
      harness().service.sync(manager, '12', '3', upload({ billedBy: '404' })),
    ).rejects.toMatchObject({ code: 'OFFLINE_CONFLICT_OPERATOR_REVOKED' });
  });

  it('records a matched card/UPI reference as a legacy Others payment message, unflagged', async () => {
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
        message: 'UPI-REF-1',
      }),
    );
    expect(h.comments.map((item) => item.comment)).toEqual([
      expect.stringMatching(/^Offline bill OFF-12-3-ABCDEF01-1 billed at /),
    ]);
  });

  it('accepts an unmatched standalone-terminal reference and flags it once for finance', async () => {
    const h = harness();
    const card = upload({ tender: { mode: 'card', reference: 'RRN12345' } });
    const result = await h.service.sync(cashier, '12', '3', card);
    expect(result).toMatchObject({ status: 'created', orderId: '5001' });
    await h.service.sync(cashier, '12', '3', card);
    expect(h.comments.map((item) => item.comment)).toEqual([
      expect.stringMatching(/^Offline bill OFF-12-3-ABCDEF01-1 billed at /),
      'Offline bill OFF-12-3-ABCDEF01-1 reconciliation: CARD reference RRN12345 has no matching terminal transaction. Finance to reconcile.',
    ]);
    const mismatch = harness({ tenderFound: false });
    await mismatch.service.sync(cashier, '12', '3', card);
    expect(mismatch.comments[1]!.comment).toContain('does not match the terminal transaction');
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

  it('never recreates an order whose Redis record was lost before its comment was written', async () => {
    let failures = 1;
    const h = harness({
      submit: async () => {
        if (failures-- > 0) throw new AppError(502, 'CHECKOUT_OUTCOME_UNCERTAIN', 'network');
        return { status: 'succeeded', state: {}, result: { orderId: '5002', invoice: null } };
      },
    });
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    // Redis restarted without persistence: the submitting record is gone, no comment exists.
    h.records.clear();
    await expect(h.service.sync(cashier, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_CONFLICT_OUTCOME_UNKNOWN',
    });
    expect(h.repository.unconfirmedOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: '12',
        counterId: '3',
        reference,
        lines: [{ productId: '1001', quantity: 2 }],
        from: billedAt - 10 * 60_000,
      }),
    );
    expect(h.checkout.submit).toHaveBeenCalledTimes(1);
    // The manager links the order found in Orders, or confirms that none exists.
    const result = await h.service.sync(
      manager,
      '12',
      '3',
      upload({ resolution: { action: 'recreate', managerId: '5', reason: 'No order in Orders' } }),
    );
    expect(result).toMatchObject({ status: 'created', orderId: '5002' });
    expect(h.checkout.submit).toHaveBeenCalledTimes(2);
  });

  it('keeps a created order when the Redis done record cannot be written', async () => {
    const h = harness();
    vi.mocked(h.coordinator.saveRecord).mockImplementation(async (ref, value) => {
      if (value.state === 'done') throw new AppError(503, 'OFFLINE_SYNC_IN_PROGRESS', 'down');
      h.records.set(ref, value);
    });
    const result = await h.service.sync(cashier, '12', '3', upload());
    expect(result).toMatchObject({ status: 'created', orderId: '5001' });
    expect(h.comments).toHaveLength(1);
    expect(h.payments.start).toHaveBeenCalledTimes(1);
  });

  it('lets a manager decision take over a sale another operator never submitted', async () => {
    const h = harness();
    h.records.set(reference, {
      state: 'in-flight',
      operatorId: '77',
      checkoutId: null,
      submitting: false,
    });
    const other = { ...manager, id: '6' };
    await expect(h.service.sync(other, '12', '3', upload())).rejects.toMatchObject({
      code: 'OFFLINE_SYNC_IN_PROGRESS',
    });
    const result = await h.service.sync(
      other,
      '12',
      '3',
      upload({ resolution: { action: 'recreate', managerId: '6', reason: 'No order in Orders' } }),
    );
    expect(result).toMatchObject({ status: 'created', orderId: '5001' });
  });

  it('refuses a sale billed in the future, beyond the clock-skew allowance', async () => {
    const h = harness();
    const at = billedAt + 3600_000;
    await expect(
      h.service.sync(cashier, '12', '3', upload({ billedAt: at + 5 * 60_000 + 1 })),
    ).rejects.toMatchObject({ status: 409, code: 'OFFLINE_CONFLICT_REJECTED' });
    expect(h.coordinator.lock).not.toHaveBeenCalled();
    await expect(
      h.service.sync(cashier, '12', '3', upload({ billedAt: at + 4 * 60_000 })),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('caps the unsynced sales of one device per offline episode (OFFLINE_BILLING_MAX_ORDERS)', async () => {
    const clock = { now: billedAt + 3600_000 };
    const h = harness({ now: () => clock.now });
    const sale = (sequence: number, at: number, overrides: Partial<OfflineSaleUpload> = {}) =>
      upload({
        saleId: crypto.randomUUID(),
        provisionalRef: `OFF-12-3-ABCDEF01-${sequence}`,
        billedAt: at,
        ...overrides,
      });
    // Eleven sales billed offline over eleven minutes, uploaded together an hour later.
    for (let sequence = 1; sequence <= 10; sequence++)
      await expect(
        h.service.sync(cashier, '12', '3', sale(sequence, billedAt + sequence * 60_000)),
      ).resolves.toMatchObject({ status: 'created' });
    await expect(
      h.service.sync(cashier, '12', '3', sale(11, billedAt + 11 * 60_000)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'OFFLINE_CONFLICT_REJECTED',
      message: expect.stringContaining('more than 10 offline sales without syncing'),
    });
    expect(h.created).toHaveLength(10);
    // A replay of an admitted sale is never refused.
    await expect(
      h.service.sync(cashier, '12', '3', sale(10, billedAt + 10 * 60_000)),
    ).resolves.toMatchObject({ status: 'existing' });
    // The manager's decision is recorded and not refused.
    await expect(
      h.service.sync(
        manager,
        '12',
        '3',
        sale(11, billedAt + 11 * 60_000, {
          resolution: { action: 'accept', managerId: '5', reason: 'Reviewed the sale' },
        }),
      ),
    ).resolves.toMatchObject({ status: 'created' });
    // A new offline episode after that sync starts a fresh count.
    clock.now += 20 * 60_000;
    for (let sequence = 12; sequence <= 21; sequence++)
      await expect(
        h.service.sync(cashier, '12', '3', sale(sequence, clock.now - 15 * 60_000 + sequence)),
      ).resolves.toMatchObject({ status: 'created' });
    expect(h.devices.get('abcdef0123456789abcdef0123456789')?.get('OFF-12-3-ABCDEF01-12')).toEqual({
      billedAt: clock.now - 15 * 60_000 + 12,
      sequence: 12,
      syncedAt: clock.now,
    });
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

describe('candidate match for an unconfirmed order', () => {
  const query = { reference, lines: [{ productId: '1001', quantity: 2 }] };
  const lines = [{ productId: '1001', quantity: 2 }];
  const comment = (ref: string) => offlineComment(ref, billedAt);
  it('matches an initiated or pending order with exactly the sale lines and no comment', () => {
    for (const paymentStatus of [0, 1])
      expect(unconfirmedMatch(query, { paymentStatus, lines, offlineComments: [] })).toBe(true);
    // The same quantity split over two rows is the same multiset.
    expect(
      unconfirmedMatch(query, {
        paymentStatus: 0,
        lines: [
          { productId: '1001', quantity: 1 },
          { productId: '1001', quantity: 1 },
        ],
        offlineComments: [],
      }),
    ).toBe(true);
  });
  it('matches an order already carrying this sale’s comment, paid or not', () => {
    expect(
      unconfirmedMatch(query, {
        paymentStatus: 4,
        lines,
        offlineComments: [
          comment(reference),
          reconciliationComment({
            reference,
            mode: 'card',
            tenderReference: 'RRN12345',
            match: 'missing',
          }),
        ],
      }),
    ).toBe(true);
  });
  it('ignores paid or cancelled orders, other offline sales, extra lines and other quantities', () => {
    for (const paymentStatus of [2, 3, 4, 5])
      expect(unconfirmedMatch(query, { paymentStatus, lines, offlineComments: [] })).toBe(false);
    expect(
      unconfirmedMatch(query, {
        paymentStatus: 1,
        lines,
        offlineComments: [comment('OFF-12-3-ABCDEF01-10')],
      }),
    ).toBe(false);
    expect(
      unconfirmedMatch(query, {
        paymentStatus: 1,
        lines: [...lines, { productId: '2002', quantity: 1 }],
        offlineComments: [],
      }),
    ).toBe(false);
    expect(
      unconfirmedMatch(query, {
        paymentStatus: 1,
        lines: [{ productId: '1001', quantity: 3 }],
        offlineComments: [],
      }),
    ).toBe(false);
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
