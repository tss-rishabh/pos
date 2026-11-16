import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { db, type LocalDraft } from '../../offline/database';
import {
  activeFastCash,
  completeFastCash,
  prepareFastCash,
  refreshFastCash,
  releaseFastCash,
  retireLocallyCompletedFastCash,
} from '../../offline/fast-cash/commands';
import {
  fastSessionSchema,
  cashIntentAmounts,
  fastCents,
  fastDecimal,
  type FastCashCommand,
} from '../../offline/fast-cash/contracts';
import { authoritativeTotal, type Checkout } from './client';
import type { ConfirmedPayment } from './receipts';
import { currency } from '../../lib/format';
import { InvoiceActions } from './InvoiceActions';
import { hasCashSalespeople } from './salespeople';

export interface FastCashCheckoutProps {
  draft: LocalDraft;
  checkout: Checkout;
  online: boolean;
  disabled: boolean;
  canStart: boolean;
  onCheckout: (state: Checkout, pendingOperationId: string | null) => void | Promise<void>;
  onSaveNote: (message: string, cashReceived: string) => Promise<Checkout>;
  onConfirmed?: (receipt: ConfirmedPayment) => void | Promise<void>;
  onOrderCreated?: (orderId: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}
export function FastCashCheckout(props: FastCashCheckoutProps) {
  const [command, setCommand] = useState<FastCashCommand | null>(null),
    [loaded, setLoaded] = useState(false),
    [localReceiptId, setLocalReceiptId] = useState<string | null>(null),
    [received, setReceived] = useState(''),
    [message, setMessage] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState('');
  const lock = useRef(false),
    callbacks = useRef(props),
    notified = useRef<string | null>(null),
    reported = useRef(false);
  callbacks.current = props;
  const { draft, checkout, online, disabled, canStart } = props;
  const payable = authoritativeTotal(checkout);
  const salespersonReady =
    payable !== null && (/^0+(?:\.0+)?$/.test(payable) || hasCashSalespeople(checkout));
  const matching = (value: FastCashCommand) =>
    value.draftId === callbacks.current.draft.id &&
    value.draftVersion === callbacks.current.draft.updatedAt &&
    value.checkoutId === callbacks.current.checkout.id;
  async function user(): Promise<Principal> {
    const session = fastSessionSchema.parse(await db.sessions.get('current'));
    if (
      session.user.id !== draft.ownerId ||
      session.expiresAt <= Date.now() ||
      localStorage.getItem('pos-pending-logout')
    )
      throw new Error('Sign in as the original cashier to continue this cash sale.');
    captureOperatorScope(session.user.id).throwIfAborted();
    return session.user;
  }
  useEffect(() => {
    const subscription = liveQuery(async () => {
      const cached = fastSessionSchema.safeParse(await db.sessions.get('current'));
      if (
        !cached.success ||
        cached.data.user.id !== draft.ownerId ||
        cached.data.expiresAt <= Date.now()
      )
        return { active: null, completed: null };
      const active = await activeFastCash(cached.data.user, draft.storeId, draft.counterId);
      const completed = active
        ? await db.completedSales.get([draft.ownerId, active.draftId])
        : undefined;
      return { active, completed: completed?.receiptId ?? null };
    }).subscribe({
      next: (value) => {
        setCommand(value.active);
        setLocalReceiptId(value.completed);
        setLoaded(true);
      },
      error: () =>
        setProblem(
          'The saved cash references could not be read. Keep the original sale for reconciliation.',
        ),
    });
    return () => subscription.unsubscribe();
  }, [draft.ownerId, draft.storeId, draft.counterId]);
  useEffect(() => {
    if (
      command?.state !== 'paid' ||
      !command.receipt ||
      localReceiptId !== command.receipt.receiptId
    )
      return;
    void user()
      .then((actor) => retireLocallyCompletedFastCash(actor, command.id))
      .catch(() => {
        setProblem(
          'The confirmed cash reference is retained until its local completion can be checked.',
        );
      });
  }, [command?.id, command?.state, localReceiptId]);
  const pending = !loaded || (command !== null && command.state !== 'paid');
  useEffect(() => {
    if (reported.current !== pending) {
      reported.current = pending;
      callbacks.current.onPendingChange?.(pending);
    }
  }, [pending]);
  useEffect(
    () => () => {
      callbacks.current.onPendingChange?.(false);
      callbacks.current.onBusyChange?.(false);
    },
    [],
  );
  async function publish(result: { command: FastCashCommand; state: Checkout | null }) {
    const latest = await db.fastCashCommands.get(result.command.id);
    captureOperatorScope(result.command.ownerId).throwIfAborted();
    if (!latest || latest.revision !== result.command.revision) return;
    setCommand(result.command);
    if (!matching(result.command)) return;
    if (result.state)
      await callbacks.current.onCheckout(
        result.state,
        result.state.busyOperationId ||
          (result.command.state === 'order-uncertain' ? result.command.submissionId : null),
      );
    if (result.command.orderId) callbacks.current.onOrderCreated?.(result.command.orderId);
    const receipt = result.command.receipt;
    if (result.command.state === 'paid' && receipt && notified.current !== receipt.receiptId) {
      if (result.state?.settlement?.receiptId !== receipt.receiptId)
        await callbacks.current.onConfirmed?.(receipt);
      notified.current = receipt.receiptId;
    }
  }
  async function act(task: (actor: Principal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setProblem('');
    callbacks.current.onBusyChange?.(true);
    try {
      await task(await user());
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'The cash outcome is unconfirmed. Keep the saved reference.',
      );
    } finally {
      lock.current = false;
      setBusy(false);
      callbacks.current.onBusyChange?.(false);
    }
  }
  useEffect(() => {
    if (!online || !command) return;
    const controller = new AbortController();
    let active = true;
    const refresh = async () => {
      if (lock.current) return;
      try {
        const actor = await user();
        const result = await refreshFastCash(actor, command.id, {
          signal: AbortSignal.any([controller.signal, captureOperatorScope(actor.id)]),
        });
        if (active) await publish(result);
      } catch (error) {
        if (active)
          setProblem(
            error instanceof Error ? error.message : 'The saved cash outcome is unavailable.',
          );
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [command?.id, online]);
  let change: string | null = null;
  let defaultMessage = '';
  try {
    const payable = authoritativeTotal(checkout);
    if (payable !== null) {
      const amounts = cashIntentAmounts(payable, received),
        difference = fastCents(amounts.cashReceived) - fastCents(amounts.payable);
      if (difference >= 0n) change = fastDecimal(difference);
      defaultMessage = `#Cash Received:${amounts.cashReceived}\n#Cash To Be Accepted:${amounts.payable}\n#Cash To Be Return:${fastDecimal(difference)}`;
    }
  } catch {
    /* Show validation on explicit completion. */
  }
  return (
    <section className="gift-card-item" aria-labelledby="fast-cash-title">
      <h3 id="fast-cash-title">Fast cash checkout</h3>
      {problem && (
        <p className="inline-error" role="alert">
          {problem}
        </p>
      )}
      {!online && (
        <p>
          Reconnect to complete this online cash sale. Offline cash uses its signed receipt flow.
        </p>
      )}
      {!loaded ? (
        <p>Checking saved cash references…</p>
      ) : !command ? (
        <>
          <label>
            Cash received for fast checkout
            <input
              data-cashier-action="fast-cash"
              aria-keyshortcuts="F"
              value={received}
              onChange={(event) => setReceived(event.target.value)}
              inputMode="decimal"
              maxLength={12}
              placeholder={authoritativeTotal(checkout) || 'Exact amount'}
              disabled={disabled || busy || !canStart || !online}
            />
          </label>
          <p className="caption">
            Blank or zero uses the confirmed payable. A zero-total order uses its prepaid evidence.
          </p>
          {payable !== null && !/^0+(?:\.0+)?$/.test(payable) && (
            <label>
              Cash order message
              <textarea
                value={message ?? defaultMessage}
                onChange={(event) => setMessage(event.target.value)}
                rows={3}
                maxLength={255}
                required
                disabled={disabled || busy || !canStart || !online}
              />
            </label>
          )}
          {!salespersonReady && (
            <p>Choose the sale and product salespeople before completing this cash sale.</p>
          )}
          {change !== null && <p>Change: {currency(change)}</p>}
          <button
            className="button primary full"
            disabled={disabled || busy || !canStart || !online || !salespersonReady}
            onClick={() =>
              void act(async (actor) => {
                const amounts = cashIntentAmounts(authoritativeTotal(checkout) ?? '', received);
                const reviewed =
                  amounts.payable === '0.00'
                    ? checkout
                    : await callbacks.current.onSaveNote(
                        message ?? defaultMessage,
                        amounts.cashReceived,
                      );
                captureOperatorScope(actor.id).throwIfAborted();
                const saved = await prepareFastCash(actor, draft, reviewed, received);
                setCommand(saved);
                callbacks.current.onPendingChange?.(true);
                await publish(await completeFastCash(actor, saved.id));
              })
            }
          >
            Complete cash sale
          </button>
        </>
      ) : (
        <>
          <p role="status">
            {command.state === 'paid'
              ? 'Cash sale confirmed.'
              : command.state === 'order-ready'
                ? 'Order confirmed; cash completion is pending.'
                : 'This cash outcome needs confirmation. Preserve the received cash and original reference.'}
          </p>
          <p>
            Payable {currency(command.payable)} · Cash received {currency(command.cashReceived)}
          </p>
          <small>
            Cash reference: {command.id}
            {command.orderId ? ` · Order ${command.orderId}` : ''}
          </small>
          {!matching(command) && (
            <p>This reference belongs to an earlier reviewed sale. The current cart is kept.</p>
          )}
          <button
            className="button secondary full"
            disabled={disabled || busy || !online}
            onClick={() =>
              void act(async (actor) => {
                notified.current = null;
                await publish(await refreshFastCash(actor, command.id));
              })
            }
          >
            Check saved cash sale
          </button>
          {command.state !== 'paid' && command.state !== 'stopped' && (
            <button
              className="button primary full"
              disabled={disabled || busy || !online}
              onClick={() =>
                void act(async (actor) => {
                  await publish(await completeFastCash(actor, command.id, {}, true));
                })
              }
            >
              Continue exact saved cash sale
            </button>
          )}
          {['order-uncertain', 'submitting'].includes(command.state) && (
            <p className="caption">
              If confirmation needs repair, use the saved order reconciliation, then check this
              reference. A new order is not created.
            </p>
          )}
          {command.state === 'paid' && command.orderId && (
            <>
              <InvoiceActions
                ownerId={draft.ownerId}
                storeId={command.storeId}
                orderId={command.orderId}
              />
              <button
                className="button secondary full"
                disabled={disabled || busy || !online}
                onClick={() =>
                  void act(async (actor) => {
                    await publish(await releaseFastCash(actor, command.id));
                    setCommand(null);
                  })
                }
              >
                Keep receipt and start another fast sale
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
