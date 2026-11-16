import { ApiError, captureOperatorScope } from '../../api/client';
import type { Principal } from '../../api/types';
import {
  assertCheckoutDraft,
  authoritativeTotal,
  checkoutSchema,
  type Checkout,
} from '../../pages/checkout/client';
import { confirmedPaymentSchema, type ConfirmedPayment } from '../../pages/checkout/receipts';
import { db, type LocalDraft, type PosDatabase } from '../database';
import { currentCashScope } from '../cash/sync';
import { hasCashSalespeople } from '../../pages/checkout/salespeople';
import { fastCashApi, type FastCashApi } from './client';
import { bindPaidPerformance, freezePerformance } from '../performance/storage';
import {
  cashPaymentSchema,
  cashIntentAmounts,
  fastCashCommandSchema,
  fastCents,
  fastDecimal,
  fastSessionSchema,
  type FastCashCommand,
} from './contracts';

export interface FastCashOptions {
  database?: PosDatabase;
  signal?: AbortSignal;
  clock?: () => number;
  api?: FastCashApi;
}
interface Scope {
  database: PosDatabase;
  signal: AbortSignal;
  clock: () => number;
  api: FastCashApi;
}
const context = (user: Principal, options: FastCashOptions): Scope => ({
  database: options.database || db,
  signal: options.signal || captureOperatorScope(user.id),
  clock: options.clock || Date.now,
  api: options.api || fastCashApi,
});
const ownerKey = (
  command: Pick<FastCashCommand, 'ownerId' | 'storeId' | 'counterId'>,
): [string, string, string] => [command.ownerId, command.storeId, command.counterId];
const recent = (command: FastCashCommand, scope: Scope) =>
  command.claimedAt !== null && command.claimedAt + 30_000 > scope.clock();
async function active(user: Principal, storeId: string, scope: Scope) {
  scope.signal.throwIfAborted();
  const parsed = fastSessionSchema.safeParse(await scope.database.sessions.get('current')),
    session = parsed.success ? parsed.data : null;
  if (
    !session ||
    session.expiresAt <= scope.clock() ||
    !currentCashScope(session.user, user, storeId) ||
    localStorage.getItem('pos-pending-logout')
  )
    throw new Error(
      'Sign in with the original authorized operator before continuing this cash sale.',
    );
}
function checked(command: FastCashCommand, user: Principal) {
  const value = fastCashCommandSchema.parse(command);
  if (value.ownerId !== user.id) throw new Error('This cash intent belongs to another operator.');
  return value;
}
function boundState(command: FastCashCommand, supplied: Checkout) {
  const value = checkoutSchema.parse(supplied);
  if (
    value.id !== command.checkoutId ||
    value.storeId !== command.storeId ||
    value.counterId !== command.counterId ||
    value.draftId !== command.draftId ||
    value.draftVersion !== command.draftVersion ||
    (value.operatorId !== undefined && value.operatorId !== command.ownerId)
  )
    throw new Error('The server checkout does not match the original cash intent.');
  if (command.orderId && value.orderId !== command.orderId)
    throw new Error('The saved cash order identity changed.');
  if (
    command.noteHash &&
    (value.settlementNote?.hash !== command.noteHash ||
      value.settlementNote.payable !== command.payable ||
      value.settlementNote.cashReceived !== command.cashReceived)
  )
    throw new Error('The original cash payment note binding changed.');
  return { ...value, operatorId: command.ownerId };
}
function paid(command: FastCashCommand, supplied: ConfirmedPayment) {
  const receipt = confirmedPaymentSchema.parse(supplied);
  if (
    !command.orderId ||
    receipt.orderId !== command.orderId ||
    receipt.cashAmount !== command.payable ||
    receipt.onlineAmount !== '0.00' ||
    (command.payable === '0.00'
      ? receipt.source !== 'prepaid' ||
        receipt.checkoutId !== command.checkoutId ||
        receipt.receiptId !== command.submissionId
      : receipt.source !== 'counter' || receipt.paymentAttemptId !== command.paymentId)
  )
    throw new Error('The paid evidence does not match this cash sale.');
  if (command.receipt && JSON.stringify(command.receipt) !== JSON.stringify(receipt))
    throw new Error('The original cash receipt changed.');
  return receipt;
}
async function save(user: Principal, command: FastCashCommand, scope: Scope, claimId?: string) {
  return scope.database
    .transaction('rw', [scope.database.sessions, scope.database.fastCashCommands], async () => {
      await active(user, command.storeId, scope);
      const stored = await scope.database.fastCashCommands.get(command.id);
      if (!stored) throw new Error('The original cash intent is unavailable.');
      const previous = checked(stored, user);
      if (claimId && previous.claimId !== claimId) return previous;
      if (!claimId && previous.revision !== command.revision) return previous;
      if (previous.state === 'paid' && command.state !== 'paid') return previous;
      if (previous.state === 'paid' && command.state === 'paid') {
        if (JSON.stringify(previous.receipt) !== JSON.stringify(command.receipt))
          throw new Error('The original cash receipt changed.');
        return previous;
      }
      const value = fastCashCommandSchema.parse({
        ...command,
        revision: previous.revision + 1,
        updatedAt: scope.clock(),
      });
      await scope.database.fastCashCommands.put(value);
      scope.signal.throwIfAborted();
      return value;
    })
    .then((value) => {
      if (value.state === 'paid')
        void bindPaidPerformance(value, {
          database: scope.database,
          signal: scope.signal,
          clock: scope.clock,
        }).catch(() => {});
      return value;
    });
}
async function load(user: Principal, id: string, scope: Scope) {
  const command = await scope.database.fastCashCommands.get(id);
  if (!command) throw new Error('The original cash intent is unavailable.');
  const value = checked(command, user);
  await active(user, value.storeId, scope);
  return value;
}
export async function activeFastCash(
  user: Principal,
  storeId: string,
  counterId: string,
  options: FastCashOptions = {},
) {
  const scope = context(user, options);
  await active(user, storeId, scope);
  const pointer = await scope.database.fastCashOwners.get([user.id, storeId, counterId]);
  if (!pointer) return null;
  const command = await load(user, pointer.commandId, scope);
  if (
    pointer.ownerId !== user.id ||
    pointer.storeId !== storeId ||
    pointer.counterId !== counterId ||
    command.storeId !== storeId ||
    command.counterId !== counterId
  )
    throw new Error('The saved cash lane has a different store or counter.');
  return command;
}
async function quoteHash(checkout: Checkout) {
  const ordered = (value: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error('The quote is too deeply nested to verify.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => ordered(item, depth + 1));
    if (typeof value === 'object' && value) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, ordered(record[key], depth + 1)]),
      );
    }
    throw new Error('The quote contains an unsupported value.');
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(
        ordered({
          id: checkout.id,
          version: checkout.version,
          quote: checkout.quote,
          ...(checkout.settlementNote ? { noteHash: checkout.settlementNote.hash } : {}),
        }),
      ),
    ),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
/** Freeze amount/IDs under the persisted original review. No cart/contact payload is stored here. */
export async function prepareFastCash(
  user: Principal,
  suppliedDraft: LocalDraft,
  suppliedCheckout: Checkout,
  received: string,
  options: FastCashOptions = {},
) {
  const scope = context(user, options),
    draft = structuredClone(suppliedDraft),
    checkout = checkoutSchema.parse(structuredClone(suppliedCheckout));
  if (
    draft.ownerId !== user.id ||
    checkout.storeId !== draft.storeId ||
    checkout.counterId !== draft.counterId ||
    (checkout.operatorId !== undefined && checkout.operatorId !== user.id) ||
    checkout.phase !== 'quoted' ||
    !checkout.quote ||
    checkout.busyOperationId ||
    checkout.orderId ||
    checkout.draftImport?.status !== 'complete'
  )
    throw new Error('Review a current confirmed quote before completing cash.');
  assertCheckoutDraft(checkout, draft.id, draft.updatedAt, draft.lines);
  const raw = authoritativeTotal(checkout);
  if (raw === null) throw new Error('The authoritative quote amount is missing.');
  const { payable, cashReceived } = cashIntentAmounts(raw, received),
    hash = await quoteHash(checkout);
  if (payable !== '0.00' && !hasCashSalespeople(checkout))
    throw new Error('Choose the sale and product salespeople before completing cash.');
  if (
    payable !== '0.00' &&
    (!checkout.settlementNote ||
      checkout.settlementNote.payable !== payable ||
      checkout.settlementNote.cashReceived !== cashReceived)
  )
    throw new Error('Save the payment note for this exact payable and received cash first.');
  const prepared = await scope.database.transaction(
    'rw',
    [
      scope.database.sessions,
      scope.database.reviewSnapshots,
      scope.database.completedSales,
      scope.database.clearedDrafts,
      scope.database.fastCashCommands,
      scope.database.fastCashOwners,
    ],
    async () => {
      await active(user, draft.storeId, scope);
      const review = await scope.database.reviewSnapshots.get([user.id, draft.id]);
      if (
        !review ||
        review.checkoutId !== checkout.id ||
        review.snapshot.updatedAt !== draft.updatedAt ||
        review.snapshot.storeId !== draft.storeId ||
        review.snapshot.counterId !== draft.counterId ||
        (await scope.database.completedSales.get([user.id, draft.id])) ||
        (await scope.database.clearedDrafts.get([user.id, draft.id]))
      )
        throw new Error('The original reviewed sale is unavailable or already completed.');
      assertCheckoutDraft(
        checkout,
        review.draftId,
        review.snapshot.updatedAt,
        review.snapshot.lines,
      );
      const key: [string, string, string] = [user.id, draft.storeId, draft.counterId],
        pointer = await scope.database.fastCashOwners.get(key);
      if (pointer) {
        const original = await load(user, pointer.commandId, scope);
        if (
          original.draftId !== draft.id ||
          original.quoteHash !== hash ||
          original.cashReceived !== cashReceived
        )
          throw new Error('Finish the saved cash intent before preparing another sale or amount.');
        return original;
      }
      const command: FastCashCommand = {
        id: crypto.randomUUID(),
        revision: 0,
        ownerId: user.id,
        storeId: draft.storeId,
        counterId: draft.counterId,
        draftId: draft.id,
        draftVersion: draft.updatedAt,
        checkoutId: checkout.id,
        checkoutVersion: checkout.version,
        quoteHash: hash,
        noteHash: payable === '0.00' ? null : (checkout.settlementNote?.hash ?? null),
        payable,
        cashReceived,
        submissionId: crypto.randomUUID(),
        paymentId: crypto.randomUUID(),
        orderId: null,
        state: 'prepared',
        claimId: null,
        claimedAt: null,
        orderAttempts: 0,
        paymentAttempts: 0,
        receipt: null,
        errorCode: null,
        createdAt: scope.clock(),
        updatedAt: scope.clock(),
      };
      await scope.database.fastCashCommands.add(fastCashCommandSchema.parse(command));
      await scope.database.fastCashOwners.add({
        ownerId: user.id,
        storeId: draft.storeId,
        counterId: draft.counterId,
        commandId: command.id,
      });
      scope.signal.throwIfAborted();
      return command;
    },
  );
  try {
    await freezePerformance(prepared, {
      database: scope.database,
      signal: scope.signal,
      clock: scope.clock,
    });
  } catch {
    /* Cash intent durability is independent of optional timing metadata. */
  }
  scope.signal.throwIfAborted();
  return prepared;
}
async function adoptOrder(
  user: Principal,
  command: FastCashCommand,
  supplied: Checkout,
  scope: Scope,
  claimId?: string,
) {
  const state = boundState(command, supplied);
  if (
    state.phase !== 'submitted' ||
    !state.orderId ||
    state.orderSubmissionOperationId !== command.submissionId
  )
    return { command, state };
  const updated = {
    ...command,
    orderId: state.orderId,
    state: 'order-ready' as const,
    claimId: null,
    claimedAt: null,
    errorCode: null,
  };
  if (updated.payable === '0.00') {
    if (!state.settlement) return { command: await save(user, updated, scope, claimId), state };
    const receipt = paid(updated, state.settlement);
    return {
      command: await save(user, { ...updated, state: 'paid', receipt }, scope, claimId),
      state,
    };
  }
  return { command: await save(user, updated, scope, claimId), state };
}
async function adoptPayment(
  user: Principal,
  command: FastCashCommand,
  supplied: unknown,
  scope: Scope,
  claimId?: string,
) {
  const result = cashPaymentSchema.parse(supplied);
  if (
    result.id !== command.paymentId ||
    result.operatorId !== command.ownerId ||
    result.storeId !== command.storeId ||
    result.counterId !== command.counterId ||
    result.orderId !== command.orderId ||
    result.cashAmount !== command.payable ||
    result.cashReceived !== command.cashReceived ||
    (command.noteHash &&
      (result.checkoutNote?.checkoutId !== command.checkoutId ||
        result.checkoutNote.noteHash !== command.noteHash))
  )
    throw new Error('The payment response does not match the original cash intent.');
  if (result.status !== 'paid')
    return save(
      user,
      {
        ...command,
        state:
          result.status === 'failed' || result.status === 'cancelled'
            ? 'stopped'
            : 'payment-uncertain',
        claimId: null,
        claimedAt: null,
        errorCode: result.errorCode,
      },
      scope,
      claimId,
    );
  const receipt = paid(command, {
    status: 'paid',
    source: 'counter',
    receiptId: result.id,
    paymentAttemptId: result.id,
    orderId: result.orderId,
    transactionId: result.transactionId,
    cashAmount: result.cashAmount,
    onlineAmount: '0.00',
  });
  return save(
    user,
    { ...command, state: 'paid', receipt, claimId: null, claimedAt: null, errorCode: null },
    scope,
    claimId,
  );
}
/** Recovery never dispatches an order or a cash settlement. A404 is not failure proof. */
export async function refreshFastCash(user: Principal, id: string, options: FastCashOptions = {}) {
  const scope = context(user, options),
    command = await load(user, id, scope),
    state = boundState(command, await scope.api.readCheckout(command));
  let current = command;
  if (
    !command.orderId ||
    command.state === 'submitting' ||
    command.state === 'order-uncertain' ||
    command.payable === '0.00'
  ) {
    const adopted = await adoptOrder(user, command, state, scope);
    current = adopted.command;
  }
  if (current.orderId && current.payable !== '0.00' && current.paymentAttempts > 0) {
    try {
      current = await adoptPayment(user, current, await scope.api.readPayment(current), scope);
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === 'PAYMENT_ATTEMPT_NOT_FOUND'
      ))
        throw error;
    }
  }
  await active(user, current.storeId, scope);
  return { command: current, state };
}
async function claim(
  user: Principal,
  id: string,
  scope: Scope,
  stage: 'order' | 'payment',
  retry: boolean,
) {
  return scope.database.transaction(
    'rw',
    [scope.database.sessions, scope.database.fastCashCommands],
    async () => {
      const command = await load(user, id, scope);
      if (command.state === 'paid' || command.state === 'stopped') return null;
      const first = stage === 'order' ? command.orderAttempts === 0 : command.paymentAttempts === 0;
      if (
        (!first && !retry) ||
        ((command.state === 'submitting' || command.state === 'paying') && recent(command, scope))
      )
        return null;
      if (stage === 'order' ? !!command.orderId : !command.orderId || command.payable === '0.00')
        return null;
      const value: FastCashCommand = {
        ...command,
        revision: command.revision + 1,
        state: stage === 'order' ? 'submitting' : 'paying',
        claimId: crypto.randomUUID(),
        claimedAt: scope.clock(),
        orderAttempts: command.orderAttempts + (stage === 'order' ? 1 : 0),
        paymentAttempts: command.paymentAttempts + (stage === 'payment' ? 1 : 0),
        updatedAt: scope.clock(),
      };
      await scope.database.fastCashCommands.put(value);
      scope.signal.throwIfAborted();
      return value;
    },
  );
}
/** Called only by an explicit reviewed cash action. Unknown first outcomes are GET-only until explicit retry. */
export async function completeFastCash(
  user: Principal,
  id: string,
  options: FastCashOptions = {},
  retry = false,
) {
  const scope = context(user, options);
  let command = await load(user, id, scope),
    state: Checkout | null = null;
  if (command.state === 'paid' || retry) {
    const refreshed = await refreshFastCash(user, id, { ...options, ...scope });
    command = refreshed.command;
    state = refreshed.state;
    if (command.state === 'paid') return { command, state };
  }
  if (!command.orderId) {
    if (retry) {
      try {
        const outcome = await scope.api.readSubmission(command);
        if (outcome.state) {
          const adopted = await adoptOrder(user, command, outcome.state, scope);
          command = adopted.command;
          state = adopted.state;
        }
        if (!command.orderId) return { command, state };
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
    const claimed = await claim(user, id, scope, 'order', retry);
    if (!claimed) return { command: await load(user, id, scope), state };
    command = claimed;
    try {
      await active(user, command.storeId, scope);
      const response = await scope.api.submit(command);
      if (response.operationId && response.operationId !== command.submissionId)
        throw new Error('The order operation identity changed.');
      if (response.status !== 'succeeded' || !response.state)
        throw new Error('The order outcome is unconfirmed. Keep its original reference.');
      const adopted = await adoptOrder(user, command, response.state, scope, command.claimId!);
      command = adopted.command;
      state = adopted.state;
      if (command.state !== 'order-ready' && command.state !== 'paid')
        throw new Error('The saved order is not confirmed for cash completion.');
    } catch (error) {
      await save(
        user,
        {
          ...command,
          state: 'order-uncertain',
          errorCode: error instanceof ApiError ? error.code : 'FAST_CASH_ORDER_UNCONFIRMED',
        },
        scope,
        command.claimId || undefined,
      );
      throw error;
    }
  }
  if (command.state === 'paid' || command.payable === '0.00') return { command, state };
  state = boundState(command, state || (await scope.api.readCheckout(command)));
  if (state.phase !== 'submitted' || state.orderSubmissionOperationId !== command.submissionId)
    throw new Error(
      'The original order is not confirmed for cash completion. Reconcile it before taking another action.',
    );
  if (retry && command.paymentAttempts > 0) {
    try {
      const result = await scope.api.readPayment(command);
      command = await adoptPayment(user, command, result, scope);
      return { command, state };
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        error.status === 404 &&
        error.code === 'PAYMENT_ATTEMPT_NOT_FOUND'
      ))
        throw error;
    }
  }
  const ready = await scope.api.paymentOptions(command);
  await active(user, command.storeId, scope);
  if (
    fastDecimal(fastCents(ready.payable)) !== command.payable ||
    !ready.options.some((method) => method.channel === 'cash')
  )
    throw new Error(
      'The writer payment amount or cash option changed. Keep the original intent for review.',
    );
  const claimed = await claim(user, id, scope, 'payment', retry);
  if (!claimed) return { command: await load(user, id, scope), state };
  command = claimed;
  try {
    await active(user, command.storeId, scope);
    command = await adoptPayment(
      user,
      command,
      await scope.api.pay(command),
      scope,
      command.claimId!,
    );
    return { command, state };
  } catch (error) {
    await save(
      user,
      {
        ...command,
        state: 'payment-uncertain',
        errorCode: error instanceof ApiError ? error.code : 'FAST_CASH_PAYMENT_UNCONFIRMED',
      },
      scope,
      command.claimId || undefined,
    );
    throw error;
  }
}
/** Retain the money evidence; release this lane only after a fresh writer-proven paid result. */
export async function releaseFastCash(user: Principal, id: string, options: FastCashOptions = {}) {
  const scope = context(user, options),
    result = await refreshFastCash(user, id, { ...options, ...scope });
  if (result.command.state !== 'paid')
    throw new Error('Reconcile the original cash sale before starting another.');
  return scope.database.transaction(
    'rw',
    [scope.database.sessions, scope.database.fastCashOwners],
    async () => {
      await active(user, result.command.storeId, scope);
      const key = ownerKey(result.command),
        pointer = await scope.database.fastCashOwners.get(key);
      if (pointer?.commandId === id) await scope.database.fastCashOwners.delete(key);
      scope.signal.throwIfAborted();
      return result;
    },
  );
}
/** Retire only an already conserved completeSale receipt; never edit a cart here. */
export async function retireLocallyCompletedFastCash(
  user: Principal,
  id: string,
  options: FastCashOptions = {},
) {
  const scope = context(user, options);
  return scope.database.transaction(
    'rw',
    [
      scope.database.sessions,
      scope.database.fastCashCommands,
      scope.database.fastCashOwners,
      scope.database.completedSales,
    ],
    async () => {
      const command = await load(user, id, scope);
      if (command.state !== 'paid' || !command.receipt) return false;
      const completed = await scope.database.completedSales.get([user.id, command.draftId]);
      if (
        !completed ||
        completed.orderId !== command.orderId ||
        completed.receiptId !== command.receipt.receiptId ||
        completed.storeId !== command.storeId
      )
        return false;
      const key = ownerKey(command),
        pointer = await scope.database.fastCashOwners.get(key);
      if (pointer?.commandId === id) await scope.database.fastCashOwners.delete(key);
      scope.signal.throwIfAborted();
      return true;
    },
  );
}
