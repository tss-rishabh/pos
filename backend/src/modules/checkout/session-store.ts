import { z } from 'zod';
import { AppError } from '../../domain/errors.js';
import { checkoutStateSchema, type CheckoutState, type OperationReceipt } from './contracts.js';
import { readJson, withStateLock, type PosStateStore } from './state-store.js';

/**
 * Server-side POS sale (tab) state, re-homed from `pos_rewrite_checkout_sessions`,
 * `pos_rewrite_checkout_operations`, `pos_rewrite_customer_cart_leases` and
 * `pos_rewrite_gift_card_leases` to Redis. Legacy keeps the same tab state in Redis
 * (`{store}_{tab}` salesperson, `gift_card_{tab}_{gv}` serials, `{user}_{store}_{counter}_{tab}` OTP).
 *
 * Keys (all JSON unless noted):
 * - `pos:checkout:{checkoutId}`: the CheckoutState. TTL 2 days while open, 30 days once an
 *   order exists so an uncertain sale stays reviewable.
 * - `pos:checkout_draft:{operatorId}:{draftId}`: checkoutId (plain string), same TTL as the sale.
 * - `pos:checkout_op:{checkoutId}:{operationId}`: OperationReceipt, TTL 30 days.
 * - `pos:checkout_lock:{checkoutId}`: lock token, PX 120 s (replaces `FOR UPDATE`).
 * - `pos:customer_cart_lease:{customerId}`: `{checkoutId, expiresAt}`, TTL 12 h.
 * - `pos:gift_card_lease:{serial}`: `{checkoutId, expiresAt}`, TTL 12 h.
 */
export const OPEN_SESSION_TTL_SECONDS = 2 * 24 * 3600;
export const ORDER_SESSION_TTL_SECONDS = 30 * 24 * 3600;
export const OPERATION_TTL_SECONDS = 30 * 24 * 3600;
export const LEASE_TTL_SECONDS = 12 * 3600;

export const sessionKeys = {
  session: (checkoutId: string) => `pos:checkout:${checkoutId}`,
  draft: (operatorId: string, draftId: string) => `pos:checkout_draft:${operatorId}:${draftId}`,
  operation: (checkoutId: string, operationId: string) =>
    `pos:checkout_op:${checkoutId}:${operationId}`,
  lock: (checkoutId: string) => `pos:checkout_lock:${checkoutId}`,
  customerLease: (customerId: string) => `pos:customer_cart_lease:${customerId}`,
  giftCardLease: (serial: string) => `pos:gift_card_lease:${serial}`,
};

const leaseSchema = z.object({ checkoutId: z.uuid(), expiresAt: z.number() }).strict();
const receiptSchema: z.ZodType<OperationReceipt> = z
  .object({
    id: z.string().min(1).max(64),
    checkoutId: z.uuid(),
    status: z.enum(['inflight', 'succeeded', 'uncertain', 'rejected']),
    requestHash: z.string().min(1).max(128),
    result: z
      .object({ state: checkoutStateSchema, result: z.record(z.string(), z.unknown()) })
      .nullable(),
    errorCode: z.string().max(64).nullable(),
  })
  .strict() as z.ZodType<OperationReceipt>;

export function sessionTtl(state: CheckoutState): number {
  return state.orderId || state.phase === 'uncertain'
    ? ORDER_SESSION_TTL_SECONDS
    : OPEN_SESSION_TTL_SECONDS;
}

export interface CheckoutSessionStore {
  readonly store: PosStateStore;
  /** Unscoped read. Callers must check operator/store themselves. */
  read(checkoutId: string): Promise<CheckoutState | null>;
  /** Read bound to the operator and store that own the sale. */
  readScoped(operatorId: string, storeId: string, checkoutId: string): Promise<CheckoutState | null>;
  /** Unconditional write of the current state (call inside `exclusive`). */
  write(state: CheckoutState): Promise<void>;
  /**
   * Serialises every writer of one sale. `run` receives the current scoped state and may
   * return a replacement state to persist; returning `null` leaves the stored state unchanged.
   */
  exclusive<T>(
    operatorId: string,
    storeId: string,
    checkoutId: string,
    run: (state: CheckoutState) => Promise<{ state: CheckoutState | null; value: T }>,
  ): Promise<T>;
  /** Persists `next` only if the stored version still equals `expectedVersion`. */
  replaceIfVersion(next: CheckoutState, expectedVersion: number): Promise<boolean>;
  draftBinding(operatorId: string, draftId: string): Promise<string | null>;
  bindDraft(operatorId: string, draftId: string, checkoutId: string): Promise<string>;
  receipt(checkoutId: string, operationId: string): Promise<OperationReceipt | null>;
  saveReceipt(receipt: OperationReceipt): Promise<void>;
  acquireLease(kind: 'customer' | 'gift-card', subject: string, checkoutId: string): Promise<void>;
  releaseLease(kind: 'customer' | 'gift-card', subject: string, checkoutId: string): Promise<void>;
  leaseHolder(kind: 'customer' | 'gift-card', subject: string): Promise<string | null>;
}

export function checkoutSessionStore(
  store: PosStateStore,
  now: () => number = Date.now,
): CheckoutSessionStore {
  async function read(checkoutId: string) {
    return readJson(store, sessionKeys.session(checkoutId), checkoutStateSchema);
  }
  async function write(state: CheckoutState) {
    const parsed = checkoutStateSchema.parse(state);
    await store.set(sessionKeys.session(state.id), JSON.stringify(parsed), sessionTtl(parsed));
    if (parsed.draftId)
      await store.set(
        sessionKeys.draft(parsed.operatorId, parsed.draftId),
        parsed.id,
        sessionTtl(parsed),
      );
  }
  const leaseKey = (kind: 'customer' | 'gift-card', subject: string) =>
    kind === 'customer' ? sessionKeys.customerLease(subject) : sessionKeys.giftCardLease(subject);
  return {
    store,
    read,
    async readScoped(operatorId, storeId, checkoutId) {
      const state = await read(checkoutId);
      return state && state.operatorId === operatorId && state.storeId === storeId ? state : null;
    },
    write,
    async exclusive(operatorId, storeId, checkoutId, run) {
      return withStateLock(store, sessionKeys.lock(checkoutId), async () => {
        const state = await read(checkoutId);
        if (!state || state.operatorId !== operatorId || state.storeId !== storeId)
          throw new AppError(
            404,
            'CHECKOUT_NOT_FOUND',
            'Checkout was not found for this operator and store.',
          );
        const outcome = await run(state);
        if (outcome.state) await write(outcome.state);
        return outcome.value;
      });
    },
    async replaceIfVersion(next, expectedVersion) {
      return withStateLock(store, sessionKeys.lock(next.id), async () => {
        const current = await read(next.id);
        if (!current || current.version !== expectedVersion) return false;
        await write(next);
        return true;
      });
    },
    draftBinding(operatorId, draftId) {
      return store.get(sessionKeys.draft(operatorId, draftId));
    },
    async bindDraft(operatorId, draftId, checkoutId) {
      const key = sessionKeys.draft(operatorId, draftId);
      if (await store.set(key, checkoutId, OPEN_SESSION_TTL_SECONDS, true)) return checkoutId;
      const existing = await store.get(key);
      if (!existing)
        throw new AppError(
          409,
          'CHECKOUT_DRAFT_CONFLICT',
          'This saved sale is already bound to another checkout.',
        );
      return existing;
    },
    receipt(checkoutId, operationId) {
      return readJson(store, sessionKeys.operation(checkoutId, operationId), receiptSchema);
    },
    async saveReceipt(receipt) {
      await store.set(
        sessionKeys.operation(receipt.checkoutId, receipt.id),
        JSON.stringify(receipt),
        OPERATION_TTL_SECONDS,
      );
    },
    async acquireLease(kind, subject, checkoutId) {
      const key = leaseKey(kind, subject);
      await withStateLock(store, `${key}:lock`, async () => {
        const current = await readJson(store, key, leaseSchema);
        if (current && current.checkoutId !== checkoutId && current.expiresAt > now())
          throw kind === 'customer'
            ? new AppError(
                409,
                'CUSTOMER_CART_BUSY',
                'This customer already has an active checkout. Finish or review that sale first.',
              )
            : new AppError(
                409,
                'GIFT_CARD_RESERVED',
                'This card number is reserved by another checkout.',
              );
        await store.set(
          key,
          JSON.stringify({ checkoutId, expiresAt: now() + LEASE_TTL_SECONDS * 1000 }),
          LEASE_TTL_SECONDS,
        );
      });
    },
    async releaseLease(kind, subject, checkoutId) {
      const key = leaseKey(kind, subject);
      await withStateLock(store, `${key}:lock`, async () => {
        const current = await readJson(store, key, leaseSchema);
        if (current?.checkoutId === checkoutId) await store.del(key);
      });
    },
    async leaseHolder(kind, subject) {
      const current = await readJson(store, leaseKey(kind, subject), leaseSchema);
      return current && current.expiresAt > now() ? current.checkoutId : null;
    },
  };
}
