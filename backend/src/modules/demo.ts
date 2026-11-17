import type { CatalogService } from './catalog.js';
import type { OrdersService } from './orders.js';
import type { DraftService } from './drafts.js';
import type { Draft, ProductDto } from '../domain/contracts.js';
import { requireStore, type Principal } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { identifier } from '../domain/validation.js';

export const demoUser: Principal = {
  userType: 1,
  id: '900001',
  name: 'Demo operator',
  email: 'operator@example.test',
  role: 4,
  storeIds: ['1', '2'],
};
const names = [
  'Classic: Oversized T-shirt',
  'Urban: Utility Cargo',
  'Everyday: Crew Neck',
  'Signature: Denim Jacket',
  'Essential: Joggers',
  'Retro: Varsity Polo',
  'Explorer: Graphic Tee',
  'Sunday: Relaxed Shirt',
  'Street: Cargo Shorts',
  'Cloud: Cotton Hoodie',
  'Everyday: Sneakers',
  'Essential: Tote Bag',
];
const products: ProductDto[] = names.map((name, i) => ({
  id: String(1001 + i),
  name,
  erpName: `TSS-DEMO-${i + 1}`,
  barcode: String(8900000001001 + i),
  parentId: '0',
  type: '1',
  price: ['999.00', '1899.00', '799.00', '2499.00'][i % 4]!,
  specialPrice: '0.00',
  exclusivePrice: null,
  stock: [24, 12, 8, 3, 0, 19][i % 6]!,
  gst: 5,
  image: null,
}));
export function demoServices() {
  const saved = new Map<string, Draft>(),
    operations = new Map<string, { hash: string; result: Draft }>();
  const catalog: CatalogService = {
    async stores(user) {
      return [
        {
          id: '1',
          name: 'Bandra Flagship',
          locationCode: 'DEMO-BDR',
          city: 'Mumbai',
          active: true,
        },
        { id: '2', name: 'Indiranagar', locationCode: 'DEMO-IDR', city: 'Bengaluru', active: true },
      ].filter((s) => user.role === 1 || user.storeIds.includes(s.id));
    },
    async counters(user, storeId) {
      requireStore(user, storeId);
      return [{ id: storeId === '1' ? '1' : '2', storeId, name: 'Counter 01' }];
    },
    async products(user, storeId, search = '', after = '0', limit = 30, includeOutOfStock = false) {
      requireStore(user, storeId);
      const filtered = products.filter(
        (p) =>
          (includeOutOfStock || p.stock > 0) &&
          BigInt(p.id) > BigInt(after) &&
          `${p.name} ${p.barcode} ${p.id}`.toLowerCase().includes(search.toLowerCase()),
      );
      return {
        data: filtered.slice(0, limit),
        nextCursor: filtered.length > limit ? filtered[limit - 1]!.id : null,
      };
    },
  };
  const orders: OrdersService = {
    async list(user, storeId, before, limit = 30) {
      requireStore(user, storeId);
      // Synthetic pagination emits numeric IDs. Live readers independently
      // validate their signed, actor/date-bound cursor protocol.
      if (before !== undefined) identifier.parse(before);
      const rows = Array.from({ length: 8 }, (_, i) => ({
        id: String(6008 - i),
        reference: `DEMO-${6008 - i}`,
        storeId,
        customer: ['Walk-in customer', 'Alex Morgan', 'Sam Taylor'][i % 3]!,
        amount: ['1899.00', '2798.00', '999.00'][i % 3]!,
        status: i === 0 ? 'Processing' : 'Delivered',
        paymentStatus: 'Paid',
        createdAt: new Date(Date.now() - i * 1800000).toISOString(),
      })).filter((r) => !before || BigInt(r.id) < BigInt(before));
      return { data: rows.slice(0, limit), nextCursor: null };
    },
    async detail(user, storeId, orderId) {
      requireStore(user, storeId);
      return {
        id: BigInt(orderId),
        reference: `DEMO-${orderId}`,
        amount: 1899,
        createdAt: new Date().toISOString(),
        status: 'Delivered',
        isPaid: true,
        lines: [
          {
            id: 1n,
            productId: 1001n,
            name: products[0]!.name,
            quantity: 1n,
            amount: 1899,
            gst: 5,
            status: 'DELIVERED',
          },
        ],
      };
    },
  };
  const drafts: DraftService = {
    async save(user, input) {
      requireStore(user, input.draft.storeId);
      const opKey = `${user.id}:${input.mutationId}`,
        hash = JSON.stringify(input),
        existing = operations.get(opKey);
      if (existing) {
        if (existing.hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Operation changed.');
        return structuredClone(existing.result);
      }
      const key = `${user.id}:${input.draft.id}`,
        old = saved.get(key);
      if ((old?.version || 0) !== input.expectedVersion)
        throw new AppError(409, 'DRAFT_CONFLICT', 'Cart changed on another device.');
      if (old && (old.storeId !== input.draft.storeId || old.counterId !== input.draft.counterId))
        throw new AppError(409, 'DRAFT_SCOPE_CONFLICT', 'Cart scope changed.');
      const result = { ...structuredClone(input.draft), version: input.expectedVersion + 1 };
      saved.set(key, result);
      operations.set(opKey, { hash, result });
      return structuredClone(result);
    },
    async list(user, storeId) {
      requireStore(user, storeId);
      return [...saved.entries()]
        .filter(([key, value]) => key.startsWith(user.id + ':') && value.storeId === storeId)
        .map(([, v]) => structuredClone(v));
    },
  };
  return { catalog, orders, drafts };
}
