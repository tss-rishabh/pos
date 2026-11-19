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
import type { OfflineSyncCoordinator, SaleRecord } from './locks.js';
import type { OfflineBillingLimits } from './options.js';
import type { OfflineOrder, OfflineSyncRepository } from './repository.js';

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
  /** Master salesperson (AjaxAddSalesPersonView); legacy requires one on every order. */
  salesperson(
    user: Principal,
    storeId: string,
    id: string,
    input: MutationInput,
    salespersonId: string,
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
  limits: OfflineBillingLimits;
  /** Assigns the invoice number (and line salespersons) of an order created outside this
   * sync's own submit, such as a manager-linked order; returns the invoice number. */
  finalizeOrder?: (input: {
    orderId: string;
    storeId: string;
    counterId: string;
    salespersonId: string;
  }) => Promise<string | null>;
  now?: () => number;
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
/** Submit refusals raised before pos/order is dispatched (validation, identity and
 * configuration): no order can exist, so they are definite, not unknown outcomes. */
const BEFORE_DISPATCH = new Set([
  'SALESPERSON_REQUIRED',
  'CART_EMPTY',
  'GIFT_CARD_NUMBER_REQUIRED',
  'ORDER_FINALIZER_UNAVAILABLE',
  'CHECKOUT_CUSTOMER_UNAVAILABLE',
  'CHECKOUT_IDENTITY_UNAVAILABLE',
  'CUSTOMER_DISABLED',
  'CHECKOUT_DEPENDENCY_UNAVAILABLE',
  'INVALID_CHECKOUT_CONFIGURATION',
]);
const LOCK_TTL_MS = 120_000;
const DAY_MS = 24 * 3600_000,
  FALLBACK_WINDOW_MS = 31 * DAY_MS;

const stateSchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().min(0),
    phase: z.enum(['open', 'quoted', 'order-created', 'submitted', 'uncertain', 'cleared']),
    orderId: z.string().nullable(),
    customerId: z.string().nullable().optional(),
    salespersonId: z.string().nullable().optional(),
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

/** Offline payable: sum of lines, floored to whole rupees (legacy CalculationsWrapper). */
export function offlinePayable(lines: OfflineSaleUpload['lines']): bigint {
  const gross = lines.reduce(
    (total, line) => total + minor(line.unitPrice) * BigInt(line.quantity),
    0n,
  );
  return gross - (gross % 100n);
}

const unknownOutcome = () =>
  conflict(
    'OUTCOME_UNKNOWN',
    'The store service may already have created this order. A manager must check Orders for this provisional reference before resolving.',
  );

export function offlineSyncService(deps: OfflineSyncDeps) {
  const { repository, checkout } = deps;
  const now = deps.now ?? Date.now;
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
            // Legacy "Others" (1001) settlement: the cashier's typed text is the payment
            // Message, stored in order_stores.message; transaction_id stays the generated one
            // (create_order.html:5825-5870 and 5913-5920 -> AjaxTransactionUploadView,
            // order/views.py:3020-3063 -> Helpers.complete_order(others=True),
            // helpers/helpers.py:635-641).
            message: sale.tender.reference,
          };
    await deps.payments.start(user, storeId, orderId, input);
  }
  /** Finish a known order: the legacy comment row carrying the provisional
   * reference (written once), then the tender if it is not yet paid. */
  async function finish(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
    orderId: string,
    status: OfflineSaleResult['status'],
  ): Promise<OfflineSaleResult> {
    const order: OfflineOrder | null = await repository.order(orderId);
    if (!order || order.storeId !== storeId || order.counterId !== counterId)
      throw conflict('REJECTED', 'The synced order does not belong to this store counter.');
    if (!(await repository.commentExists(orderId, sale.provisionalRef)))
      await repository.recordReference({
        orderId,
        reference: sale.provisionalRef,
        billedAt: sale.billedAt,
        userId: user.id,
      });
    if (!order.paid) await pay(user, sale, storeId, orderId, order.payable);
    if (
      sale.tender.mode !== 'cash' &&
      !(await repository.reconciliationFlagged(orderId, sale.provisionalRef))
    ) {
      // A manually entered reference never blocks the sale (AGENTS.md, 19 Nov): a terminal row
      // is checked when one exists; anything short of a match is flagged for finance.
      const match = await repository.tenderMatch({
        storeId,
        orderId,
        reference: sale.tender.reference,
        amount: order.payable,
      });
      if (match !== 'matched')
        await repository.flagReconciliation({
          orderId,
          reference: sale.provisionalRef,
          mode: sale.tender.mode,
          tenderReference: sale.tender.reference,
          match,
          userId: user.id,
        });
    }
    // A manager-linked order whose pos/order reply was lost never reached the finalizer: assign
    // its invoice number the way the order flow does (generated whether or not confirmed).
    let invoiceNumber = order.invoiceNumber;
    if (!invoiceNumber && deps.finalizeOrder)
      invoiceNumber = await deps.finalizeOrder({
        orderId,
        storeId,
        counterId,
        salespersonId: sale.salespersonId,
      });
    return {
      status,
      orderId,
      invoiceNumber,
      provisionalRef: sale.provisionalRef,
    };
  }
  async function markDone(reference: string, orderId: string, invoiceNo: string | null) {
    await deps.coordinator!.saveRecord(reference, { state: 'done', orderId, invoiceNo });
  }

  /** Lines and quote through the ordinary checkout service. Nothing here can
   * create an order, so a failure clears the in-flight record. */
  async function prepare(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
    record: Extract<SaleRecord, { state: 'in-flight' }>,
  ) {
    const reference = sale.provisionalRef;
    let checkoutId = record.checkoutId;
    if (!checkoutId) {
      checkoutId = view(await checkout.create(user, storeId, counterId)).id;
      await deps.coordinator!.saveRecord(reference, { ...record, checkoutId });
    }
    let state = view(await checkout.read(user, storeId, checkoutId));
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
        if (error instanceof AppError && error.code === 'CHECKOUT_VERSION_CONFLICT') throw retry();
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
    // The salesperson chosen on the device (legacy requires a master salesperson per order,
    // order/views.py:2969-3019); validated against the store's active salespeople.
    if (state.salespersonId !== sale.salespersonId) {
      try {
        state = succeeded(
          await checkout.salesperson(
            user,
            storeId,
            checkoutId,
            {
              operationId: operationId(
                reference,
                `salesperson:${sale.salespersonId}:${state.version}`,
              ),
              expectedVersion: state.version,
            },
            sale.salespersonId,
          ),
        ).state;
      } catch (error) {
        if (error instanceof AppError && error.code === 'CHECKOUT_VERSION_CONFLICT') throw retry();
        if (
          error instanceof AppError &&
          error.status >= 400 &&
          error.status < 500 &&
          !error.code.startsWith('OFFLINE_') &&
          !NOT_STOCK.has(error.code)
        )
          throw conflict(
            'REJECTED',
            'The salesperson on this sale is no longer active in this store. A manager must review it.',
          );
        throw error;
      }
    }
    state = succeeded(
      await checkout.quote(user, storeId, checkoutId, {
        operationId: operationId(reference, `quote:${state.version}`),
        expectedVersion: state.version,
      }),
    ).state;
    if (!state.quote) throw retry();
    const serverPayable = deps.quotePayable(state.quote);
    if (minor(serverPayable) !== minor(sale.payable) && sale.resolution?.action !== 'accept')
      throw conflict(
        'PRICE_CHANGED',
        `The store price is now Rs. ${serverPayable}; this sale collected Rs. ${sale.payable}.`,
      );
    return { checkoutId, version: state.version };
  }

  /** Create the order through the ordinary checkout path. order reference
   * number stays API-v2's; the provisional reference goes into a comments row. */
  async function create(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
    record: Extract<SaleRecord, { state: 'in-flight' }>,
  ): Promise<OfflineSaleResult> {
    const coordinator = deps.coordinator!;
    const reference = sale.provisionalRef;
    let prepared: { checkoutId: string; version: number };
    try {
      prepared = await prepare(user, sale, storeId, counterId, record);
      await coordinator.saveRecord(reference, {
        state: 'in-flight',
        operatorId: user.id,
        checkoutId: prepared.checkoutId,
        submitting: true,
      });
    } catch (error) {
      // No order can exist before submission: allow a clean retry.
      await coordinator.clearRecord(reference).catch(() => undefined);
      throw error;
    }
    let reply: CheckoutReply;
    try {
      reply = await checkout.submit(user, storeId, prepared.checkoutId, {
        operationId: operationId(reference, `submit:${prepared.version}`),
        expectedVersion: prepared.version,
      });
    } catch (error) {
      // Refused before dispatching pos/order: no order exists.
      if (
        error instanceof AppError &&
        [
          'CHECKOUT_QUOTE_CHANGED',
          'CHECKOUT_VERSION_CONFLICT',
          'CHECKOUT_QUOTE_REQUIRED',
          'CHECK_IN_REQUIRED',
        ].includes(error.code)
      ) {
        await coordinator.clearRecord(reference).catch(() => undefined);
        throw retry();
      }
      // Definite refusals raised before pos/order (for example a missing salesperson): no
      // order exists, so the manager sees the real reason instead of an unknown outcome.
      if (error instanceof AppError && error.status < 500 && BEFORE_DISPATCH.has(error.code)) {
        await coordinator.clearRecord(reference).catch(() => undefined);
        throw conflict('REJECTED', error.message);
      }
      // Anything else may have created the order: never resubmit automatically.
      throw unknownOutcome();
    }
    if (reply.status !== 'succeeded') throw unknownOutcome();
    const result = reply.result;
    const orderId = z.union([z.string(), z.number()]).transform(String).parse(result.orderId);
    const invoice = z
      .string()
      .nullable()
      .catch(null)
      .parse(result.invoice ?? null);
    await markDone(reference, orderId, invoice);
    return finish(user, sale, storeId, counterId, orderId, 'created');
  }

  /** A manager links the order they found in Orders for an unknown outcome. The order must be
   * this sale: same store counter, the same products and quantities, created no earlier than a
   * day before billing, and not already linked to another offline reference. */
  async function link(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
    orderId: string,
  ): Promise<OfflineSaleResult> {
    const candidate = await repository.linkCandidate(orderId);
    const refuse = (message: string) => conflict('OUTCOME_UNKNOWN', message);
    if (
      !candidate ||
      candidate.order.storeId !== storeId ||
      candidate.order.counterId !== counterId
    )
      throw refuse('That order was not found at this store counter. Check the order ID in Orders.');
    const expected = new Map(sale.lines.map((line) => [line.productId, line.quantity])),
      actual = new Map<string, number>();
    for (const line of candidate.lines)
      actual.set(line.productId, (actual.get(line.productId) ?? 0) + line.quantity);
    if (
      actual.size !== expected.size ||
      [...expected].some(([productId, quantity]) => actual.get(productId) !== quantity)
    )
      throw refuse('That order has different products or quantities from this offline sale.');
    if (
      candidate.offlineComments.some(
        (comment) => !comment.startsWith(`Offline bill ${sale.provisionalRef} `),
      )
    )
      throw refuse('That order is already linked to another offline sale.');
    const created = Date.parse(candidate.createdAt.replace(' ', 'T') + 'Z');
    // Naive business-local timestamps: allow a day for the zone offset and device clock.
    if (!Number.isFinite(created) || created < sale.billedAt - DAY_MS)
      throw refuse('That order was created before this offline sale was billed.');
    await markDone(sale.provisionalRef, orderId, candidate.order.invoiceNumber);
    return finish(user, sale, storeId, counterId, orderId, 'existing');
  }

  /** Unknown outcome: never resubmitted without a manager decision. The submitting
   * checkout is read first (same operator only); then the manager either links the order
   * found in Orders or confirms that no order exists, which allows one fresh creation. */
  async function reconcile(
    user: Principal,
    sale: OfflineSaleUpload,
    storeId: string,
    counterId: string,
    record: Extract<SaleRecord, { state: 'in-flight' }>,
  ) {
    const action = sale.resolution?.action;
    if (action !== 'accept' && action !== 'link-order' && action !== 'recreate')
      throw unknownOutcome();
    if (record.checkoutId && record.operatorId === user.id) {
      const state = view(await checkout.read(user, storeId, record.checkoutId));
      if (state.orderId) {
        await markDone(sale.provisionalRef, state.orderId, null);
        return finish(user, sale, storeId, counterId, state.orderId, 'created');
      }
    }
    if (action === 'link-order' && sale.resolution?.orderId)
      return link(user, sale, storeId, counterId, sale.resolution.orderId);
    if (action !== 'recreate') throw unknownOutcome();
    const fresh = {
      state: 'in-flight' as const,
      operatorId: user.id,
      checkoutId: null,
      submitting: false,
    };
    await deps.coordinator!.saveRecord(sale.provisionalRef, fresh);
    return create(user, sale, storeId, counterId, fresh);
  }

  return {
    settings(): OfflineBillingLimits {
      return { ...deps.limits };
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
      const coordinator = deps.coordinator;
      if (!coordinator)
        throw new AppError(503, 'OFFLINE_SYNC_UNAVAILABLE', 'Offline sale sync is not configured.');
      const reference = sale.provisionalRef,
        owner = randomUUID();
      if (!(await coordinator.lock(reference, owner, LOCK_TTL_MS))) throw retry();
      try {
        const record = await coordinator.record(reference);
        if (record?.state === 'done')
          return await finish(user, sale, storeId, counterId, record.orderId, 'existing');
        if (record?.state === 'in-flight') {
          if (record.submitting) return await reconcile(user, sale, storeId, counterId, record);
          if (record.operatorId !== user.id) throw retry();
          return await create(user, sale, storeId, counterId, record);
        }
        // Durable fallback when the Redis record expired or was lost.
        const at = now(),
          from = Math.max(Math.min(sale.billedAt, at) - DAY_MS, at - FALLBACK_WINDOW_MS);
        const found = await repository.findByComment(
          reference,
          [
            ...new Set([
              user.id,
              sale.billedBy,
              ...(sale.resolution ? [sale.resolution.managerId] : []),
            ]),
          ],
          from,
          at + 3600_000,
        );
        if (found) {
          await markDone(reference, found.orderId, found.invoiceNumber);
          return await finish(user, sale, storeId, counterId, found.orderId, 'existing');
        }
        if (sale.resolution?.action === 'link-order' && sale.resolution.orderId)
          return await link(user, sale, storeId, counterId, sale.resolution.orderId);
        if (sale.resolution?.action !== 'accept' && sale.resolution?.action !== 'recreate') {
          const billed = await deps.operators.get(sale.billedBy);
          const access =
            billed &&
            (billed.role === 1 && billed.userType === 1 ? true : billed.storeIds.includes(storeId));
          if (!access)
            throw conflict(
              'OPERATOR_REVOKED',
              'The operator who billed this sale no longer has access to this store.',
            );
        }
        const inFlight = {
          state: 'in-flight' as const,
          operatorId: user.id,
          checkoutId: null,
          submitting: false,
        };
        await coordinator.saveRecord(reference, inFlight);
        return await create(user, sale, storeId, counterId, inFlight);
      } finally {
        await coordinator.unlock(reference, owner).catch(() => undefined);
      }
    },
  };
}
export type OfflineSyncService = ReturnType<typeof offlineSyncService>;
