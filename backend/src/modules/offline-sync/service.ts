import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { MutationInput } from '../checkout/contracts.js';
import type { PaymentInput } from '../checkout/payments/contracts.js';
import {
  PROVISIONAL_REFERENCE,
  decimal,
  minor,
  type OfflineConflictCode,
  type OfflineSaleResult,
  type OfflineSaleUpload,
} from './contracts.js';
import type { OfflineSyncCoordinator } from './locks.js';
import {
  OFFLINE_LIMIT_KEYS,
  type ExistingOfflineOrder,
  type OfflineSyncRepository,
} from './repository.js';

/** The ordinary checkout service (modules/checkout/service.ts) as used here. */
export type CheckoutReply =
  | { status: 'succeeded'; state: unknown; result: Record<string, unknown> }
  | {
      status: 'inflight' | 'uncertain' | 'rejected';
      state: unknown;
      operationId: string;
      errorCode: string | null;
    };
export interface OfflineCheckoutPort {
  create(user: Principal, storeId: string, counterId: string): Promise<unknown>;
  read(user: Principal, storeId: string, id: string): Promise<unknown>;
  setLine(
    user: Principal,
    storeId: string,
    id: string,
    input: MutationInput,
    productId: string,
    quantity: number,
  ): Promise<CheckoutReply>;
  quote(user: Principal, storeId: string, id: string, input: MutationInput): Promise<CheckoutReply>;
  submit(
    user: Principal,
    storeId: string,
    id: string,
    input: MutationInput,
  ): Promise<CheckoutReply>;
}
/** The ordinary payment service; cash and operator-recorded "other" channels
 * never dispatch to a terminal provider. */
export interface OfflinePaymentPort {
  start(user: Principal, storeId: string, orderId: string, input: PaymentInput): Promise<unknown>;
}
export interface OfflineSyncDeps {
  repository: OfflineSyncRepository;
  coordinator: OfflineSyncCoordinator | null;
  checkout: OfflineCheckoutPort;
  payments: OfflinePaymentPort;
  operators: { get(id: string): Promise<Principal | null> };
  /** Secret for deterministic per-reference operation identifiers. */
  operationSecret: string;
  quotePayable(quote: Record<string, unknown>): string;
}

const MANAGER_ROLES = new Set([1, 2, 3, 4]);
/** Checkout refusals that are about session/scope, not product availability. */
const NOT_STOCK = new Set([
  'CHECK_IN_REQUIRED',
  'STORE_ACCESS_DENIED',
  'STORE_UNAVAILABLE',
  'COUNTER_UNAVAILABLE',
  'CHECKOUT_NOT_FOUND',
  'CHECKOUT_EXPIRED',
  'CHECKOUT_VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
]);
const LOCK_TTL_MS = 120_000,
  PROGRESS_TTL_SECONDS = 24 * 3600;

const stateSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().min(0),
    phase: z.enum(['open', 'quoted', 'order-created', 'submitted', 'uncertain', 'cleared']),
    orderId: z.string().nullable(),
    customerId: z.string().nullable().optional(),
    cart: z
      .object({
        products: z
          .object({
            items: z.array(
              z
                .object({
                  prod_id: z.union([z.string(), z.number()]),
                  quantity: z.union([z.string(), z.number()]),
                })
                .passthrough(),
            ),
          })
          .passthrough(),
      })
      .passthrough()
      .nullable(),
    quote: z.record(z.string(), z.unknown()).nullable(),
  })
  .passthrough();
type CheckoutView = z.infer<typeof stateSchema>;

export function conflict(code: OfflineConflictCode, message: string): AppError {
  return new AppError(409, `OFFLINE_CONFLICT_${code}`, message);
}
const retry = () =>
  new AppError(
    503,
    'OFFLINE_SYNC_IN_PROGRESS',
    'This offline sale is still being synced. It will retry automatically.',
  );

export function isManager(user: Pick<Principal, 'role'>): boolean {
  return MANAGER_ROLES.has(user.role);
}

export function limitSetting(
  value: string | null | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== 'string' || !/^\s*\d{1,6}\s*$/.test(value)) return fallback;
  const parsed = Number(value.trim());
  return parsed >= 1 && parsed <= max ? parsed : fallback;
}

/** Offline payable: sum of lines, floored to whole rupees (legacy CalculationsWrapper). */
export function offlinePayable(lines: OfflineSaleUpload['lines']): bigint {
  const gross = lines.reduce(
    (total, line) => total + minor(line.unitPrice) * BigInt(line.quantity),
    0n,
  );
  return gross - (gross % 100n);
}

export function offlineSyncService(deps: OfflineSyncDeps) {
  const { repository, checkout } = deps;
  /** RFC 9562 version-8 UUID derived from the reference and step, so a retried
   * upload replays the same checkout/payment operations instead of repeating them. */
  function operationId(reference: string, step: string): string {
    const hex = createHmac('sha256', deps.operationSecret)
      .update(`offline-sync:${reference}:${step}`)
      .digest('hex');
    const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  function view(value: unknown): CheckoutView {
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) throw retry();
    return parsed.data;
  }
  function succeeded(reply: CheckoutReply) {
    if (reply.status === 'succeeded') return { state: view(reply.state), result: reply.result };
    if (reply.status === 'inflight') throw retry();
    throw conflict(
      'REJECTED',
      'The store service could not confirm this sale. A manager must review it.',
    );
  }
  async function pay(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    orderId: string,
    payable: string,
  ) {
    const amount = minor(payable);
    const input: PaymentInput =
      sale.tender.mode === 'cash'
        ? {
            operationId: operationId(sale.provisionalRef, 'payment'),
            channel: 'cash',
            onlineAmount: '0.00',
            cashAmount: payable,
            cashReceived: decimal(
              minor(sale.tender.received) > amount ? minor(sale.tender.received) : amount,
            ),
          }
        : {
            operationId: operationId(sale.provisionalRef, 'payment'),
            channel: 'other',
            onlineAmount: payable,
            cashAmount: '0.00',
            cashReceived: '0.00',
            externalReference: sale.tender.reference,
          };
    await deps.payments.start(user, storeId, orderId, input);
  }
  async function existing(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
    found: ExistingOfflineOrder[],
  ): Promise<OfflineSaleResult> {
    const [order] = found;
    if (found.length !== 1 || !order || order.storeId !== storeId || order.counterId !== counterId)
      throw conflict('REJECTED', 'Another order already uses this provisional reference.');
    if (!order.paid) await pay(user, sale, storeId, order.orderId, order.payable);
    return {
      status: 'existing',
      orderId: order.orderId,
      invoiceNumber: order.invoiceNumber,
      provisionalRef: sale.provisionalRef,
    };
  }

  /** Create the order through the ordinary checkout path, stamp
   * orders.order_ref_no with the provisional reference and record the tender. */
  async function create(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
  ) {
    const coordinator = deps.coordinator!;
    const reference = sale.provisionalRef;
    const progress = await coordinator.progress(reference);
    if (progress && progress.operatorId !== user.id) throw retry();
    let checkoutId = progress?.checkoutId;
    if (!checkoutId) {
      checkoutId = view(await checkout.create(user, storeId, counterId)).id;
      await coordinator.saveProgress(
        reference,
        { checkoutId, operatorId: user.id },
        PROGRESS_TTL_SECONDS,
      );
    }
    let state = view(await checkout.read(user, storeId, checkoutId));
    let orderId: string | null = state.phase === 'submitted' ? state.orderId : null;
    if (!orderId) {
      if (state.phase !== 'open' && state.phase !== 'quoted')
        throw conflict(
          'REJECTED',
          'The store service could not confirm this sale. A manager must review it.',
        );
      if (state.customerId)
        throw conflict('REJECTED', 'Offline sales cannot carry customer benefits.');
      const quantities = () =>
        new Map(
          (state.cart?.products.items ?? []).map((item) => [
            String(item.prod_id),
            Number(item.quantity),
          ]),
        );
      for (const line of sale.lines) {
        if (quantities().get(line.productId) === line.quantity) continue;
        try {
          state = succeeded(
            await checkout.setLine(
              user,
              storeId,
              checkoutId,
              {
                operationId: operationId(
                  reference,
                  `line:${line.productId}:${line.quantity}:${state.version}`,
                ),
                expectedVersion: state.version,
              },
              line.productId,
              line.quantity,
            ),
          ).state;
        } catch (error) {
          if (
            error instanceof AppError &&
            error.status >= 400 &&
            error.status < 500 &&
            !error.code.startsWith('OFFLINE_') &&
            !NOT_STOCK.has(error.code)
          )
            throw conflict(
              'STOCK_SHORTFALL',
              'A product in this sale is no longer available in store stock.',
            );
          if (error instanceof AppError && error.code === 'CHECKOUT_VERSION_CONFLICT')
            throw retry();
          throw error;
        }
        if (quantities().get(line.productId) !== line.quantity)
          throw conflict('STOCK_SHORTFALL', 'Store stock is lower than the quantity sold offline.');
      }
      const expected = new Set(sale.lines.map((line) => line.productId));
      if ([...quantities().keys()].some((productId) => !expected.has(productId)))
        throw conflict(
          'REJECTED',
          'The server cart differs from this offline sale. A manager must review it.',
        );
      const quoted = succeeded(
        await checkout.quote(user, storeId, checkoutId, {
          operationId: operationId(reference, `quote:${state.version}`),
          expectedVersion: state.version,
        }),
      );
      state = quoted.state;
      if (!state.quote) throw retry();
      const serverPayable = deps.quotePayable(state.quote);
      if (minor(serverPayable) !== minor(sale.payable) && sale.resolution?.action !== 'accept')
        throw conflict(
          'PRICE_CHANGED',
          `The store price is now Rs. ${serverPayable}; this sale collected Rs. ${sale.payable}.`,
        );
      let submitted: ReturnType<typeof succeeded>;
      try {
        submitted = succeeded(
          await checkout.submit(user, storeId, checkoutId, {
            operationId: operationId(reference, `submit:${state.version}`),
            expectedVersion: state.version,
          }),
        );
      } catch (error) {
        // A changed quote is re-read on the next attempt; never a second order.
        if (
          error instanceof AppError &&
          ['CHECKOUT_QUOTE_CHANGED', 'CHECKOUT_VERSION_CONFLICT'].includes(error.code)
        )
          throw retry();
        throw error;
      }
      orderId = z.union([z.string(), z.number()]).transform(String).parse(submitted.result.orderId);
    }
    await repository.stampReference(orderId, reference);
    await coordinator.clearProgress(reference);
    const [order] = await repository.findByReference(reference);
    if (!order || order.orderId !== orderId) throw retry();
    if (!order.paid) await pay(user, sale, storeId, orderId, order.payable);
    return {
      status: 'created' as const,
      orderId,
      invoiceNumber: order.invoiceNumber,
      provisionalRef: reference,
    };
  }

  return {
    async settings() {
      const rows = await repository.settings();
      return {
        maxMinutes: limitSetting(rows[OFFLINE_LIMIT_KEYS.maxMinutes], 120, 24 * 60),
        maxOrders: limitSetting(rows[OFFLINE_LIMIT_KEYS.maxOrders], 10, 500),
      };
    },
    async sync(
      user: Principal,
      storeId: string,
      counterId: string,
      sale: OfflineSaleUpload,
    ): Promise<OfflineSaleResult> {
      requireStore(user, storeId);
      const parts = PROVISIONAL_REFERENCE.exec(sale.provisionalRef);
      if (
        !parts ||
        parts[1] !== storeId ||
        parts[2] !== counterId ||
        parts[3] !== sale.deviceId.slice(0, 8).toUpperCase()
      )
        throw new AppError(
          400,
          'SCOPE_MISMATCH',
          'The offline sale does not belong to this store counter.',
        );
      if (offlinePayable(sale.lines) !== minor(sale.payable))
        throw new AppError(
          400,
          'INVALID_OFFLINE_TOTAL',
          'The offline sale total does not match its lines.',
        );
      if (sale.tender.mode === 'cash' && minor(sale.tender.received) < minor(sale.payable))
        throw new AppError(
          400,
          'INVALID_OFFLINE_TENDER',
          'Cash received must cover the payable amount.',
        );
      if (sale.resolution && (sale.resolution.managerId !== user.id || !isManager(user)))
        throw new AppError(
          403,
          'MANAGER_REQUIRED',
          'A store manager must sync a resolved offline sale.',
        );
      if (sale.billedBy !== user.id && !isManager(user))
        throw new AppError(
          403,
          'OFFLINE_SALE_OPERATOR_MISMATCH',
          'Only the billing operator or a manager can sync this sale.',
        );
      const found = await repository.findByReference(sale.provisionalRef);
      if (found.length) return existing(user, sale, storeId, counterId, found);
      if (!deps.coordinator)
        throw new AppError(503, 'OFFLINE_SYNC_UNAVAILABLE', 'Offline sale sync is not configured.');
      const owner = randomUUID();
      if (!(await deps.coordinator.lock(sale.provisionalRef, owner, LOCK_TTL_MS))) throw retry();
      try {
        const again = await repository.findByReference(sale.provisionalRef);
        if (again.length) return await existing(user, sale, storeId, counterId, again);
        if (sale.resolution?.action !== 'accept') {
          const billed = await deps.operators.get(sale.billedBy);
          const access =
            billed &&
            (billed.role === 1 && billed.userType === 1 ? true : billed.storeIds.includes(storeId));
          if (!access)
            throw conflict(
              'OPERATOR_REVOKED',
              'The operator who billed this sale no longer has access to this store.',
            );
          if (
            sale.tender.mode !== 'cash' &&
            !(await repository.tenderReferenceExists(storeId, sale.tender.reference))
          )
            throw conflict(
              'TENDER_REFERENCE_NOT_FOUND',
              'The card/UPI reference was not found in this store’s terminal transactions.',
            );
        }
        return await create(user, sale, storeId, counterId);
      } finally {
        await deps.coordinator.unlock(sale.provisionalRef, owner).catch(() => undefined);
      }
    },
  };
}
export type OfflineSyncService = ReturnType<typeof offlineSyncService>;
