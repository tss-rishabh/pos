import { z } from 'zod';
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { X, Check, RefreshCw } from 'lucide-react';
import type { LocalDraft } from '../../offline/database';
import type { Principal } from '../../api/types';
import { currency } from '../../lib/format';
import { ApiError, NetworkError } from '../../api/client';
import {
  authoritativeTotal,
  assertCheckoutDraft,
  createCheckout,
  mutateCheckout,
  readCheckout,
  readCheckoutPaymentOptions,
  readOperation,
  reconcileCustomerVerification,
  recoveryFor,
  saveRecovery,
  registrationSchema,
  type Checkout,
  type CheckoutFlags,
} from './client';
import { PaymentPanel, type ConfirmedPayment } from './PaymentPanel';
import { FastCashCheckout } from './FastCashCheckout';
import { WalletControls } from './WalletControls';
import { CustomerLookup } from './CustomerLookup';
import { SalespersonAssignments } from './SalespersonAssignments';
import { confirmedPaymentSchema } from './receipts';
import { InvoiceActions } from './InvoiceActions';
import { DiscountApproval } from './DiscountApproval';
import { GiftCardItems } from './GiftCardItems';
import { CustomerRegistration } from './CustomerRegistration';
import { CustomerProfileCard } from '../customer-insights/profile';
import { CustomerInsights } from '../customer-insights/insights';
import { CustomerBenefitsCard } from '../customer-insights/benefits';
import { CustomerHistoryCard } from '../customer-insights/history';
import { productFeedbackPath } from '../product-feedback/client';
import { CustomerContactPanel } from '../customer-contacts';
import { GlobalVoucherConversion } from '../global-vouchers/conversion';
import './CheckoutReview.css';
import type { CheckoutClearance } from '../../api/checkout-clearance';
import { bindReviewedCheckout } from '../../offline/review-snapshot';
import { invokeCashierShortcut, type CashierShortcutRequest } from '../cashier-shortcuts/shortcuts';
import { displayedMembershipBenefits } from '../cashier-shortcuts/membership';
import { CustomerWebsiteHandoffAction } from '../customer-website-handoff';
import { OrderCopyPanel } from '../order-copy';
import { checkoutOperationReference } from './operation-reference';
import { CartQuoteSummary } from './CartQuoteSummary';
import { CheckoutCartLines } from './CheckoutCartLines';
import { quoteIsCurrent } from './quote-summary';

export interface CheckoutReviewProps {
  user: Principal;
  draft: LocalDraft;
  online: boolean;
  onClose: () => void;
  onOrderCreated?: (orderId: string) => void;
  onPaymentConfirmed?: (receipt: ConfirmedPayment) => void;
  onCheckoutCleared?: (clearance: CheckoutClearance) => void | Promise<void>;
  recoveryNotice?: string;
  shortcutRequest?: CashierShortcutRequest;
}
export function CheckoutReview({
  user,
  draft,
  online,
  onClose,
  onOrderCreated,
  onPaymentConfirmed,
  onCheckoutCleared,
  recoveryNotice,
  shortcutRequest,
}: CheckoutReviewProps) {
  const shortcutRoot = useRef<HTMLElement>(null),
    shortcutIntent = useRef({ id: '', consumed: false, loaded: false });
  const [openSections, setOpenSections] = useState({ messages: false, membership: false });
  function sectionProps(name: 'messages' | 'membership') {
    return {
      open: openSections[name],
      'data-checkout-section': name,
      onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
        const open = event.currentTarget.open;
        setOpenSections((previous) =>
          previous[name] === open ? previous : { ...previous, [name]: open },
        );
      },
    };
  }
  function rememberOpenSections() {
    const snapshot = [
      ...(shortcutRoot.current?.querySelectorAll<HTMLDetailsElement>(
        'details[data-checkout-section]',
      ) ?? []),
    ].map((element) => ({ name: element.dataset.checkoutSection, open: element.open }));
    setOpenSections((previous) => {
      const next = { ...previous };
      for (const section of snapshot)
        if (section.name === 'messages' || section.name === 'membership')
          next[section.name] = section.open;
      return next.messages === previous.messages && next.membership === previous.membership
        ? previous
        : next;
    });
  }
  const [checkout, setCheckout] = useState<Checkout | null>(null),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState(''),
    [notice, setNotice] = useState(''),
    [pendingId, setPendingId] = useState<string | null>(null),
    [otp, setOtp] = useState(''),
    [coupon, setCoupon] = useState(''),
    [giftCode, setGiftCode] = useState(''),
    [giftPin, setGiftPin] = useState(''),
    [giftPinRequested, setGiftPinRequested] = useState(false),
    [paymentFormOpen, setPaymentFormOpen] = useState(false),
    [flags, setFlags] = useState<CheckoutFlags | null>(null),
    [discount, setDiscount] = useState(''),
    [discountKind, setDiscountKind] = useState<'pg' | 'store'>('store'),
    [discountRemark, setDiscountRemark] = useState(''),
    [discountReason, setDiscountReason] = useState(''),
    [appliedPrefill, setAppliedPrefill] = useState<string | null>(null);
  useEffect(() => {
    if (flags?.enableNewPgDiscount === false && flags.enableOldPgDiscount) setDiscountKind('pg');
    if (flags?.enableOldPgDiscount === false && flags.enableNewPgDiscount) setDiscountKind('store');
  }, [flags]);
  // Applied coupon, voucher and PG amounts prefill their inputs from the cart, as legacy renders
  // them from `cart.meta.items` (create_order.html:265, :279, :309, :335).
  useEffect(() => {
    if (!checkout?.cart) return;
    const key = `${checkout.id}:${checkout.version}`;
    if (appliedPrefill === key) return;
    setAppliedPrefill(key);
    const meta: unknown = checkout.cart.meta;
    const items =
      typeof meta === 'object' && meta !== null && 'items' in meta && Array.isArray(meta.items)
        ? (meta.items as unknown[])
        : [];
    const find = (name: string) =>
      items.find(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && 'name' in item && item.name === name,
      );
    const text = (value: unknown) =>
      typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    setCoupon(text(find('coupon')?.coupon));
    setGiftCode(text(find('gift_voucher')?.voucher_code));
    const pg = text(find('pg_discount')?.used_pg_discount),
      storePg = text(find('store_discount_pg')?.used_store_discount_pg);
    setDiscount(discountKind === 'pg' ? pg : storePg);
  }, [checkout, appliedPrefill, discountKind]);
  const [profilePending, setProfilePending] = useState(false);
  const [contactPending, setContactPending] = useState(false);
  const [conversionPending, setConversionPending] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const copyActive = useRef(false);
  const onCopyPending = useCallback((value: boolean) => {
    copyActive.current = value;
    setCopyPending(value);
  }, []);
  const [recoveryError, setRecoveryError] = useState(() => {
    const saved = recoveryFor(draft.ownerId, draft.id);
    return saved && saved.draftVersion !== draft.updatedAt
      ? 'This checkout has a different saved review snapshot. Keep its reference and restore the original sale before continuing.'
      : '';
  });
  const [approvalState, setApprovalState] = useState<{ version: number; ready: boolean } | null>(
    null,
  );
  const approvalReady = useCallback(
    (version: number, ready: boolean) =>
      setApprovalState((previous) =>
        previous?.version === version && previous.ready === ready ? previous : { version, ready },
      ),
    [],
  );
  const current = useRef<Checkout | null>(null),
    locked = useRef(false),
    notifiedReceipt = useRef<string | null>(null),
    completedCallback = useRef(onPaymentConfirmed),
    notifiedClear = useRef<string | null>(null),
    clearCallback = useRef(onCheckoutCleared);
  completedCallback.current = onPaymentConfirmed;
  clearCallback.current = onCheckoutCleared;
  function notifyClear(clearance: CheckoutClearance) {
    if (!clearCallback.current || notifiedClear.current === clearance.operationId) return;
    notifiedClear.current = clearance.operationId;
    void (async () => {
      try {
        await clearCallback.current!(clearance);
      } catch (error) {
        notifiedClear.current = null;
        setProblem(
          error instanceof Error
            ? error.message
            : 'The cleared checkout could not be completed on this device.',
        );
      }
    })();
  }
  const adopt = async (value: Checkout) => {
    try {
      assertCheckoutDraft(value, draft.id, draft.updatedAt, draft.lines);
      const saved = recoveryFor(draft.ownerId, draft.id);
      if (saved && saved.draftVersion !== draft.updatedAt)
        throw new Error(
          'This checkout has a different saved review snapshot. Keep its reference and restore the original sale before continuing.',
        );
    } catch (error) {
      setRecoveryError(
        error instanceof Error ? error.message : 'The saved sale could not be verified.',
      );
      throw error;
    }
    if (
      value.settlement &&
      (value.settlement.orderId !== value.orderId ||
        (value.settlement.source === 'prepaid' && value.settlement.checkoutId !== value.id))
    )
      throw new Error(
        'The payment evidence does not match this checkout. Review the order before continuing.',
      );
    if (value.operatorId && value.operatorId !== draft.ownerId)
      throw new Error(
        'This checkout belongs to a different operator. Restore the original operator before continuing.',
      );
    if (value.flags) setFlags(value.flags);
    if (value.phase === 'cleared') {
      const proof = value.lastClear;
      if (
        value.orderId ||
        value.settlement ||
        (value.cart?.products.items.length ?? 0) !== 0 ||
        (value.cart?.giftvouchers?.items.length ?? 0) !== 0
      )
        throw new Error(
          'The clear confirmation conflicts with the saved sale. Keep its reference and review it.',
        );
      if (
        proof &&
        (proof.checkoutId !== value.id ||
          proof.operatorId !== draft.ownerId ||
          proof.storeId !== draft.storeId ||
          proof.counterId !== draft.counterId ||
          proof.draftId !== draft.id ||
          proof.draftVersion !== draft.updatedAt)
      )
        throw new Error(
          'The clear confirmation does not match this reviewed draft. Your local cart has been kept.',
        );
    } else if (value.lastClear)
      throw new Error('The saved clear confirmation has an inconsistent checkout state.');
    const binding = await bindReviewedCheckout(draft, value.id);
    if (binding.cleared && value.phase !== 'cleared')
      throw new Error(
        'This checkout was already cleared. Its original items will not be imported again.',
      );
    const ownedValue = { ...value, operatorId: draft.ownerId };
    current.current = ownedValue;
    setCheckout(ownedValue);
    if (value.phase === 'cleared' && value.lastClear) notifyClear(value.lastClear);
    if (value.settlement && notifiedReceipt.current !== value.settlement.receiptId) {
      notifiedReceipt.current = value.settlement.receiptId;
      completedCallback.current?.(value.settlement);
    }
  };
  const store = (state: Checkout, operationId: string | null) => {
    const genericReference = checkoutOperationReference(state, operationId);
    saveRecovery(draft.ownerId, draft.id, {
      checkoutId: state.id,
      pendingOperationId: genericReference,
      draftVersion: draft.updatedAt,
    });
    setPendingId(genericReference);
  };
  function canClearCancelledCopy(state: Checkout | null) {
    const recovering = Boolean(pendingId && pendingId !== state?.orderCopy?.commandId);
    return Boolean(
      state?.orderCopy?.status === 'cancelled-unsent' &&
      !state.orderId &&
      !state.settlement &&
      state.draftImport?.status === 'complete' &&
      (recovering || ['open', 'quoted'].includes(state.phase)) &&
      (!state.busyOperationId || (recovering && state.busyOperationId === pendingId)) &&
      online &&
      !recoveryError &&
      !profilePending &&
      !contactPending &&
      !conversionPending,
    );
  }
  const act = async (
    task: () => Promise<void>,
    purpose: 'ordinary' | 'cancelled-copy-clear' = 'ordinary',
  ) => {
    const clearingCancelledCopy =
      purpose === 'cancelled-copy-clear' && canClearCancelledCopy(current.current);
    if (
      locked.current ||
      (purpose === 'cancelled-copy-clear' && !clearingCancelledCopy) ||
      (!clearingCancelledCopy &&
        (copyActive.current ||
          (current.current?.orderCopy && current.current.orderCopy.status !== 'acknowledged')))
    )
      return;
    locked.current = true;
    setBusy(true);
    setProblem('');
    try {
      if (recoveryError) throw new Error(recoveryError);
      await task();
    } catch (error) {
      setProblem(
        error instanceof ApiError
          ? `${error.message}${error.requestId ? ` (Reference ${error.requestId})` : ''}`
          : error instanceof Error
            ? error.message
            : 'Checkout could not be confirmed.',
      );
    } finally {
      setBusy(false);
      locked.current = false;
    }
  };
  const mutate = async (
    path: string,
    method: 'POST' | 'PUT',
    body: Record<string, unknown> = {},
  ) => {
    const state = current.current;
    if (!state) throw new Error('Start this checkout first.');
    const operationId = crypto.randomUUID();
    store(state, operationId);
    try {
      const reply = await mutateCheckout(state, operationId, path, method, body);
      if (reply.state) {
        const settlement = confirmedPaymentSchema.safeParse(reply.result?.settlement);
        const registration = registrationSchema.safeParse(reply.result?.registration);
        await adopt({
          ...reply.state,
          registration: registration.success
            ? registration.data
            : reply.state.registrationId && reply.state.registrationId === state.registrationId
              ? state.registration
              : null,
          ...(settlement.success ? { settlement: settlement.data } : {}),
        });
      }
      if (reply.status !== 'succeeded')
        throw new Error(
          reply.status === 'uncertain'
            ? 'The last action needs review. Check its status before continuing.'
            : 'The last action is still being confirmed. Check its status before continuing.',
        );
      store(reply.state || state, null);
      return reply;
    } catch (error) {
      // A validation/permission rejection occurs before an operation is accepted.
      // Network errors retain the operation identifier for server reconciliation.
      if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
        try {
          const latest = await readCheckout(draft.storeId, state.id, draft.ownerId);
          await adopt(latest);
          store(latest, latest.busyOperationId || operationId);
        } catch {
          // Preserve the original failure and ID when a writer read is also
          // unavailable; the user can inspect it with Check action status.
        }
      }
      if (error instanceof ApiError && [400, 401, 403, 404, 410, 422].includes(error.status))
        store(current.current || state, null);
      if (
        error instanceof ApiError &&
        [
          'CHECKOUT_CONFIRMATION_IN_PROGRESS',
          'CHECKOUT_CONFIRMATION_NOT_RECOVERABLE',
          'CUSTOMER_REGISTRATION_REQUEST_IN_PROGRESS',
          'CUSTOMER_REGISTRATION_REQUEST_NOT_RECOVERABLE',
        ].includes(error.code)
      )
        store(current.current || state, current.current?.busyOperationId ?? null);
      if (
        error instanceof ApiError &&
        ['CHECKOUT_VERSION_CONFLICT', 'CHECKOUT_REVIEW_REQUIRED', 'CHECKOUT_CLEARED'].includes(
          error.code,
        )
      ) {
        const latest = await readCheckout(draft.storeId, state.id, draft.ownerId);
        await adopt(latest);
        store(latest, latest.busyOperationId);
      }
      throw error;
    }
  };
  useEffect(() => {
    let active = true;
    const recovery = recoveryFor(draft.ownerId, draft.id);
    if (!recovery || !online) return;
    if (recovery.draftVersion !== draft.updatedAt) {
      setRecoveryError(
        'This checkout has a different saved review snapshot. Keep its reference and restore the original sale before continuing.',
      );
      return;
    }
    void readCheckout(draft.storeId, recovery.checkoutId, draft.ownerId)
      .then(async (value) => {
        if (active) {
          await adopt(value);
          setPendingId(checkoutOperationReference(value, recovery.pendingOperationId));
        }
      })
      .catch((error) => {
        if (active)
          setProblem(error instanceof Error ? error.message : 'Could not restore checkout.');
      });
    return () => {
      active = false;
    };
  }, [draft.ownerId, draft.id, draft.storeId, draft.updatedAt, online]);
  async function start() {
    let state = current.current;
    if (!state) {
      state = await createCheckout(
        draft.storeId,
        draft.counterId,
        draft.id,
        draft.updatedAt,
        draft.lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        draft.ownerId,
      );
      await adopt(state);
      store(state, state.busyOperationId);
    }
    if (state.draftImport?.status === 'pending') {
      if (state.busyOperationId) return;
      await mutate('draft-initializations', 'POST');
      setNotice('Prices and availability are now confirmed online.');
      return;
    }
    if (state.phase !== 'open' || state.cart !== null || state.version > 0 || state.busyOperationId)
      return;
    throw new Error(
      'This saved sale has no confirmed line manifest. Keep its checkout reference and review it before continuing.',
    );
  }
  async function recover(reconcileVerification = true) {
    const state = current.current;
    if (!state || !pendingId) return;
    if (pendingId === state.orderCopy?.commandId) {
      store(state, null);
      return;
    }
    let result = await readOperation(state, pendingId);
    if (
      reconcileVerification &&
      ['inflight', 'uncertain'].includes(result.status) &&
      [
        state.verificationChallenge?.requestOperationId,
        state.verificationChallenge?.verifyOperationId,
      ].includes(pendingId)
    )
      result = await reconcileCustomerVerification(state, pendingId);
    const latest = await readCheckout(draft.storeId, state.id, draft.ownerId);
    await adopt(latest);
    if (result.status === 'succeeded' || result.status === 'rejected') {
      store(latest, latest.busyOperationId);
      setNotice(
        result.status === 'succeeded'
          ? 'The last action was confirmed.'
          : `The last action was rejected (${result.errorCode || 'CHECKOUT_REJECTED'}).`,
      );
    } else
      setNotice(
        result.status === 'inflight'
          ? 'The last action is still processing.'
          : 'The outcome needs administrator review. No payment or order action will be repeated.',
      );
  }
  const copyOwned = Boolean(checkout?.orderCopy && checkout.orderCopy.status !== 'acknowledged');
  const editable =
      !!checkout &&
      ['open', 'quoted'].includes(checkout.phase) &&
      checkout.draftImport?.status === 'complete' &&
      !pendingId &&
      !profilePending &&
      !contactPending &&
      !conversionPending &&
      !copyPending &&
      !copyOwned &&
      !checkout.busyOperationId,
    disabled =
      busy ||
      profilePending ||
      contactPending ||
      conversionPending ||
      copyPending ||
      copyOwned ||
      !online ||
      Boolean(recoveryError),
    total = checkout ? authoritativeTotal(checkout) : null,
    memberBenefits = displayedMembershipBenefits(checkout?.cart);
  useEffect(() => {
    const request = shortcutRequest,
      root = shortcutRoot.current;
    if (!request || !root) return;
    if (shortcutIntent.current.id !== request.id)
      shortcutIntent.current = { id: request.id, consumed: false, loaded: false };
    const intent = shortcutIntent.current;
    if (intent.consumed) return;
    if (
      Date.now() - request.requestedAt > 10000 ||
      recoveryError ||
      checkout?.phase === 'submitted' ||
      checkout?.phase === 'cleared'
    ) {
      intent.consumed = true;
      return;
    }
    if (disabled || pendingId || checkout?.busyOperationId || checkout?.phase === 'uncertain')
      return;
    if (!checkout && recoveryFor(draft.ownerId, draft.id)) return;
    if (invokeCashierShortcut(root, request.action)) {
      intent.consumed = true;
      return;
    }
    // Only pricing/loading steps may continue automatically. No shortcut clicks
    // a payment, cash completion, refund, or saved financial-operation retry.
    if (!checkout && !intent.loaded && !recoveryFor(draft.ownerId, draft.id)) {
      intent.loaded = true;
      invokeCashierShortcut(root, 'quote');
    } else if (checkout?.phase === 'quoted') intent.consumed = true;
  }, [
    shortcutRequest,
    checkout,
    disabled,
    pendingId,
    editable,
    recoveryError,
    approvalState,
    draft.ownerId,
    draft.id,
  ]);
  useEffect(() => {
    const request = shortcutRequest,
      root = shortcutRoot.current;
    if (!request || !root || request.action !== 'salesperson' || disabled || pendingId) return;
    const focus = () => {
      if (
        !shortcutIntent.current.consumed &&
        shortcutIntent.current.id === request.id &&
        Date.now() - request.requestedAt <= 10000 &&
        invokeCashierShortcut(root, request.action)
      )
        shortcutIntent.current.consumed = true;
    };
    const observer = new MutationObserver(focus);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    const timeout = setTimeout(
      () => observer.disconnect(),
      Math.max(0, 10000 - (Date.now() - request.requestedAt)),
    );
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [shortcutRequest, disabled, pendingId]);
  return (
    <div className="modal-backdrop">
      <section
        ref={shortcutRoot}
        onClickCapture={rememberOpenSections}
        data-cashier-shortcuts="review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-title"
        className="modal checkout-dialog"
      >
        <button className="icon-button modal-close" aria-label="Close checkout" onClick={onClose}>
          <X size={20} />
        </button>
        <div className="eyebrow">SALE REVIEW</div>
        <h2 id="checkout-title">Confirm the sale</h2>
        {recoveryNotice && (
          <p role="status" className="caption">
            {recoveryNotice}
          </p>
        )}
        {recoveryError && (
          <p role="alert" className="inline-error">
            {recoveryError}
          </p>
        )}
        {!online && (
          <p role="status">
            Your draft is saved on this device. Reconnect to confirm prices, benefits and payment.
          </p>
        )}
        {problem && (
          <p role="alert" className="inline-error">
            {problem}
          </p>
        )}
        {notice && (
          <p role="status" className="sync-message">
            <Check size={16} />
            {notice}
          </p>
        )}
        {checkout && (
          <button
            className="button secondary"
            data-cashier-action="refresh"
            aria-keyshortcuts="R"
            disabled={disabled}
            onClick={() =>
              void act(async () => {
                const state = current.current;
                if (!state) return;
                const latest = await readCheckout(draft.storeId, state.id, draft.ownerId);
                await adopt(latest);
                store(latest, latest.busyOperationId || pendingId);
              })
            }
          >
            Refresh sale
          </button>
        )}
        {!checkout && (
          <button
            data-cashier-action={recoveryFor(draft.ownerId, draft.id) ? undefined : 'proceed quote'}
            className="button primary full"
            disabled={disabled}
            onClick={() => void act(start)}
          >
            {busy ? 'Confirming…' : 'Confirm prices online'}
          </button>
        )}
        {pendingId && (
          <div>
            <p>The last action is awaiting confirmation. Reference {pendingId}.</p>
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() => void act(recover)}
            >
              <RefreshCw size={16} /> Check action status
            </button>
          </div>
        )}
        {checkout?.draftImport?.status === 'pending' &&
          !pendingId &&
          checkout.phase !== 'uncertain' && (
            <div>
              <p>Every saved line must be confirmed before this sale can be quoted.</p>
              <button
                data-cashier-action="proceed quote"
                className="button primary full"
                disabled={disabled}
                onClick={() => void act(start)}
              >
                Finish loading saved sale
              </button>
            </div>
          )}
        {checkout?.phase === 'uncertain' && !checkout.orderId && (
          <p role="alert">
            This sale needs administrator review before another order or payment can be attempted.
            Checkout reference: {checkout.id}.
          </p>
        )}
        {checkout?.phase === 'cleared' && (
          <div>
            <p role="status">
              This checkout is cleared. Its original items cannot be submitted again.
            </p>
            {checkout.lastClear && onCheckoutCleared && (
              <button
                className="button secondary full"
                disabled={busy || Boolean(recoveryError)}
                onClick={() => {
                  notifiedClear.current = null;
                  notifyClear(checkout.lastClear!);
                }}
              >
                Finish clearing this device
              </button>
            )}
            {!checkout.lastClear && (
              <p role="alert">
                The original draft binding is unavailable. Keep the local cart and review this
                reference.
              </p>
            )}
          </div>
        )}
        {checkout?.registrationRequestRecovery && (
          <div>
            <p>The registration delivery is saved, but its checkout checkpoint was interrupted.</p>
            <button
              className="button secondary full"
              disabled={disabled}
              onClick={() =>
                void act(async () => {
                  await mutate('customer-registration-request-reconciliations', 'POST');
                  setNotice(
                    'The queued registration request is recovered. No new message was sent.',
                  );
                })
              }
            >
              Recover queued registration request
            </button>
          </div>
        )}
        {checkout?.orderId &&
          ['order-created', 'uncertain'].includes(checkout.phase) &&
          ['dispatching', 'acknowledged'].includes(checkout.confirmationPhase ?? '') && (
            <div>
              <p>
                Order {checkout.orderId} has a saved confirmation reference. Check its committed
                stock and wallet updates before continuing.
              </p>
              <button
                className="button secondary full"
                disabled={disabled}
                onClick={() =>
                  void act(async () => {
                    await mutate('confirmation-reconciliations', 'POST');
                    setNotice(
                      'The saved confirmation is proved and order preparation is complete.',
                    );
                  })
                }
              >
                Reconcile saved confirmation
              </button>
            </div>
          )}
        {checkout?.phase === 'order-created' && (
          <div role="status">
            <p>
              Order {checkout.orderId} is saved.{' '}
              {checkout.confirmationPhase === 'acknowledged'
                ? 'Invoice preparation needs to finish before payment can continue.'
                : 'Its confirmation needs administrator review before payment can continue.'}
            </p>
            {checkout.confirmationPhase === 'acknowledged' && (
              <button
                className="button secondary full"
                disabled={disabled || Boolean(pendingId) || Boolean(checkout.busyOperationId)}
                onClick={() =>
                  void act(async () => {
                    await mutate('order-finalizations', 'POST');
                  })
                }
              >
                Finish order preparation
              </button>
            )}
          </div>
        )}
        {checkout && (
          <>
            <p>
              {checkout.customerId ? `Customer ${checkout.customerId}` : 'Walk-in customer'} ·{' '}
              {checkout.phase === 'submitted'
                ? 'Order created'
                : `${checkout.cart?.products.items.length || 0} product lines`}
            </p>
            {checkout.customerId && (
              <CustomerProfileCard
                key={`profile:${draft.ownerId}:${checkout.id}:${checkout.customerId}`}
                operatorId={draft.ownerId}
                storeId={draft.storeId}
                checkoutId={checkout.id}
                customerId={checkout.customerId}
                checkoutVersion={checkout.version}
                online={online}
                disabled={
                  busy ||
                  contactPending ||
                  conversionPending ||
                  copyPending ||
                  copyOwned ||
                  !online ||
                  Boolean(recoveryError)
                }
                actions={{
                  act,
                  onPending: setProfilePending,
                  onSaved: async () => {
                    const latest = await readCheckout(draft.storeId, checkout.id, draft.ownerId);
                    await adopt(latest);
                    setProfilePending(false);
                    setNotice(
                      'Customer details saved. Recalculate the quote before completing this sale.',
                    );
                  },
                }}
              />
            )}
            {checkout.customerId && (
              <CustomerContactPanel
                key={`contact:${draft.ownerId}:${checkout.id}:${checkout.customerId}`}
                scope={{
                  operatorId: draft.ownerId,
                  storeId: draft.storeId,
                  checkoutId: checkout.id,
                  customerId: checkout.customerId,
                }}
                checkoutVersion={checkout.version}
                online={online}
                disabled={
                  busy ||
                  profilePending ||
                  conversionPending ||
                  copyPending ||
                  copyOwned ||
                  !online ||
                  Boolean(recoveryError)
                }
                actions={{
                  act,
                  onPending: setContactPending,
                  onSaved: async () => {
                    const latest = await readCheckout(draft.storeId, checkout.id, draft.ownerId);
                    await adopt(latest);
                    setContactPending(false);
                    setNotice(
                      'Customer contact saved. Recalculate the quote and verify benefits again before completing this sale.',
                    );
                  },
                }}
              />
            )}
            {checkout.customerId && (
              <OrderCopyPanel
                scope={{
                  operatorId: draft.ownerId,
                  storeId: draft.storeId,
                  checkoutId: checkout.id,
                  customerId: checkout.customerId,
                }}
                checkoutVersion={checkout.version}
                online={online}
                disabled={
                  busy ||
                  profilePending ||
                  contactPending ||
                  conversionPending ||
                  !online ||
                  Boolean(recoveryError) ||
                  Boolean(pendingId) ||
                  Boolean(checkout.orderId) ||
                  checkout.draftImport?.status !== 'complete' ||
                  (!['open', 'quoted'].includes(checkout.phase) && !copyOwned) ||
                  Boolean(
                    checkout.busyOperationId &&
                    checkout.busyOperationId !== checkout.orderCopy?.commandId,
                  )
                }
                beforeDispatch={async () => {
                  const latest = current.current;
                  if (
                    !latest ||
                    latest.id !== checkout.id ||
                    latest.customerId !== checkout.customerId
                  )
                    throw new Error(
                      'The checkout customer changed. Refresh its original reference.',
                    );
                  // Recheck actual local cash evidence and the immutable draft
                  // binding immediately before a copy POST. The binding also
                  // serializes stale-tab cash completion through IndexedDB.
                  await bindReviewedCheckout(draft, latest.id);
                }}
                onPending={onCopyPending}
                onSaved={async () => {
                  const latest = await readCheckout(draft.storeId, checkout.id, draft.ownerId);
                  await adopt(latest);
                  store(latest, latest.busyOperationId);
                  setNotice(
                    'Review the copied cart and get a fresh quote before completing this sale.',
                  );
                }}
                onUnsentCancelled={async (proof) => {
                  const latest = await readCheckout(draft.storeId, checkout.id, draft.ownerId);
                  if (
                    latest.id !== proof.checkoutId ||
                    latest.orderCopy?.status !== 'cancelled-unsent' ||
                    latest.orderCopy.commandId !== proof.id ||
                    latest.orderCopy.reviewId !== proof.reviewId ||
                    latest.orderCopy.cancellationId !== proof.cancellationId
                  )
                    throw new Error(
                      'The checkout does not confirm this cancellation. Keep its reference and refresh.',
                    );
                  await adopt(latest);
                  store(
                    latest,
                    latest.busyOperationId ||
                      recoveryFor(draft.ownerId, draft.id)?.pendingOperationId ||
                      null,
                  );
                  setNotice(
                    'The copy was stopped before dispatch. Clear this checkout online before starting a new sale.',
                  );
                }}
              />
            )}
            {checkout.orderCopy?.status === 'cancelled-unsent' && (
              <div>
                <p role="status">
                  The unsent copy is cancelled. Your saved draft and cash records are retained until
                  this checkout is explicitly cleared.
                </p>
                <button
                  className="button secondary full"
                  disabled={busy || !canClearCancelledCopy(checkout)}
                  onClick={() =>
                    void act(async () => {
                      if (pendingId) {
                        await recover(false);
                        return;
                      }
                      const state = current.current;
                      if (!state) return;
                      await bindReviewedCheckout(draft, state.id);
                      await mutate('clear', 'POST');
                    }, 'cancelled-copy-clear')
                  }
                >
                  {pendingId ? 'Check clear status' : 'Clear cancelled copy and start a new sale'}
                </button>
              </div>
            )}
            {checkout.customerId && (
              <CustomerWebsiteHandoffAction
                key={`website:${draft.ownerId}:${checkout.id}:${checkout.customerId}`}
                user={user}
                storeId={draft.storeId}
                checkoutId={checkout.id}
                checkoutVersion={checkout.version}
                online={online}
                disabled={
                  disabled ||
                  busy ||
                  profilePending ||
                  contactPending ||
                  conversionPending ||
                  Boolean(recoveryError)
                }
                onOpen={(url) => {
                  window.open(url, '_blank', 'noopener,noreferrer');
                }}
              />
            )}
            {checkout.customerId && (
              <GlobalVoucherConversion
                key={`voucher-conversion:${draft.ownerId}:${checkout.id}:${checkout.customerId}`}
                user={{ id: draft.ownerId }}
                state={checkout}
                online={online}
                disabled={
                  busy ||
                  profilePending ||
                  contactPending ||
                  copyPending ||
                  copyOwned ||
                  !online ||
                  Boolean(recoveryError)
                }
                onPending={setConversionPending}
                onSaved={async () => {
                  const latest = await readCheckout(draft.storeId, checkout.id, draft.ownerId);
                  await adopt(latest);
                  setConversionPending(false);
                  setNotice(
                    'Gift voucher conversion confirmed. Recalculate the quote before completing this sale.',
                  );
                }}
              />
            )}
            {checkout.customerId && (
              <CustomerInsights
                key={`insights:${draft.ownerId}:${checkout.id}:${checkout.customerId}:${checkout.version}`}
                scope={{
                  operatorId: draft.ownerId,
                  storeId: draft.storeId,
                  checkoutId: checkout.id,
                  customerId: checkout.customerId,
                }}
                checkoutVersion={checkout.version}
                online={online}
                disabled={disabled}
              />
            )}
            {checkout.customerId && (
              <CustomerBenefitsCard
                key={`benefits:${draft.ownerId}:${checkout.id}:${checkout.customerId}:${checkout.version}`}
                scope={{
                  operatorId: draft.ownerId,
                  storeId: draft.storeId,
                  checkoutId: checkout.id,
                  customerId: checkout.customerId,
                }}
                checkoutVersion={checkout.version}
                online={online}
                disabled={disabled || Boolean(pendingId) || Boolean(checkout.busyOperationId)}
              />
            )}
            {checkout.customerId && (
              <CustomerHistoryCard
                key={`history:${draft.ownerId}:${checkout.id}:${checkout.customerId}:${checkout.version}`}
                scope={{
                  operatorId: draft.ownerId,
                  storeId: draft.storeId,
                  checkoutId: checkout.id,
                  customerId: checkout.customerId,
                }}
                checkoutVersion={checkout.version}
                online={online}
                disabled={disabled || Boolean(pendingId) || Boolean(checkout.busyOperationId)}
                orderDetailsPath={(orderId) => '/orders?orderId=' + encodeURIComponent(orderId)}
                feedbackPath={(orderId) =>
                  productFeedbackPath({
                    storeId: draft.storeId,
                    checkoutId: checkout.id,
                    customerId: checkout.customerId!,
                    orderId,
                  })
                }
              />
            )}
            {checkout.draftImport?.status === 'complete' && checkout.phase !== 'cleared' && (
              <SalespersonAssignments
                checkout={checkout}
                operatorId={draft.ownerId}
                disabled={disabled || !editable}
                act={act}
                mutate={mutate}
              />
            )}
            {editable && (
              <>
                <GiftCardItems checkout={checkout} disabled={disabled} act={act} mutate={mutate} />
                <CustomerRegistration
                  checkout={checkout}
                  disabled={disabled}
                  act={act}
                  mutate={mutate}
                  refresh={async () => {
                    const latest = await readCheckout(draft.storeId, checkout.id, draft.ownerId);
                    await adopt(latest);
                    return latest;
                  }}
                />
                <details {...sectionProps('messages')}>
                  <summary>Order messages</summary>
                  {/* Legacy posts nps_feedback_switch from a checked, disabled box and always
                      queues the order SMS (create_order.html:76, order/views.py:2831). */}
                  <label>
                    <input
                      type="checkbox"
                      checked
                      disabled
                      data-cashier-action="toggle-nps"
                      aria-keyshortcuts="N"
                      readOnly
                    />
                    NPS Feedback
                  </label>
                  <p className="caption">
                    The order SMS is sent after the order is confirmed. Its delivery does not
                    determine payment status.
                  </p>
                </details>
                <details>
                  <summary>Customer and verification</summary>
                  <CustomerLookup
                    storeId={draft.storeId}
                    counterId={draft.counterId}
                    operatorId={draft.ownerId}
                    connectedCustomerId={checkout.customerId}
                    disabled={disabled}
                    act={act}
                    mutate={mutate}
                  />
                  {checkout.customerId && (
                    <>
                      <p className="caption">
                        Detaching the customer clears this checkout's items, benefits and
                        salesperson assignments.
                      </p>
                      <button
                        className="button secondary"
                        disabled={disabled}
                        onClick={() =>
                          void act(async () => {
                            await mutate('customer-detachments', 'POST');
                            setOtp('');
                            setNotice('The customer is detached and the checkout is empty.');
                          })
                        }
                      >
                        Detach customer and clear checkout
                      </button>
                      <button
                        className="button secondary"
                        disabled={disabled}
                        onClick={() =>
                          void act(async () => {
                            setOtp('');
                            await mutate('customer-verification/challenges', 'POST');
                            setNotice(
                              'Verification queued. Check delivery before entering the code.',
                            );
                          })
                        }
                      >
                        Send verification code
                      </button>
                      {/* create_order.html:258 */}
                      <p role="status">
                        {checkout.verifiedCustomerUntil &&
                        checkout.verifiedCustomerUntil > Date.now()
                          ? 'User is verified !'
                          : 'Verify the user to use Tss Money/Points/Voucher !'}
                      </p>
                      {checkout.verificationChallenge && !checkout.verifiedCustomerUntil && (
                        <div role="status">
                          <p>
                            {checkout.verificationChallenge.deliveryStatus === 'uncertain'
                              ? 'Delivery is unconfirmed. If the code arrived, it can be verified. No code will be resent automatically.'
                              : checkout.verificationChallenge.sent
                                ? 'The verification code was delivered.'
                                : checkout.verificationChallenge.deliveryStatus === 'rejected'
                                  ? 'The verification is unavailable or expired. Request a new code when permitted.'
                                  : 'The verification code is queued for delivery.'}
                          </p>
                          <button
                            className="button secondary"
                            disabled={disabled}
                            onClick={() =>
                              void act(async () => {
                                const latest = await readCheckout(
                                  draft.storeId,
                                  checkout.id,
                                  draft.ownerId,
                                );
                                await adopt(latest);
                              })
                            }
                          >
                            Check verification delivery
                          </button>
                        </div>
                      )}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(async () => {
                            const code = otp;
                            setOtp('');
                            await mutate('customer-verification/confirmations', 'POST', {
                              otp: code,
                            });
                            setNotice('Customer verified.');
                          });
                        }}
                      >
                        <label>
                          Verification code
                          <input
                            value={otp}
                            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            pattern="[0-9]{4}"
                            maxLength={4}
                            required
                            disabled={
                              disabled ||
                              !(
                                checkout.verificationChallenge?.sent ||
                                checkout.verificationChallenge?.deliveryStatus === 'uncertain'
                              )
                            }
                          />
                        </label>
                        <button
                          className="button secondary"
                          disabled={
                            disabled ||
                            otp.length !== 4 ||
                            !(
                              checkout.verificationChallenge?.sent ||
                              checkout.verificationChallenge?.deliveryStatus === 'uncertain'
                            )
                          }
                        >
                          Verify customer
                        </button>
                      </form>
                    </>
                  )}
                </details>
                <details {...sectionProps('membership')}>
                  <summary>
                    {flags?.showCouponModule === false ? 'Membership' : 'Coupon and membership'}
                  </summary>
                  {flags?.showCouponModule !== false && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(async () => {
                          await mutate('coupon', 'PUT', { code: coupon });
                          setCoupon('');
                        });
                      }}
                    >
                      <label>
                        Coupon
                        <input
                          value={coupon}
                          onChange={(e) => setCoupon(e.target.value)}
                          maxLength={100}
                        />
                      </label>
                      <button className="button secondary" disabled={disabled}>
                        Apply coupon
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={disabled}
                        onClick={() =>
                          void act(async () => {
                            await mutate('coupon/removals', 'POST');
                          })
                        }
                      >
                        Remove coupon
                      </button>
                    </form>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      data-cashier-action="toggle-exclusive"
                      aria-keyshortcuts="E"
                      checked={memberBenefits === true}
                      disabled={disabled || checkout.customerId !== null || memberBenefits === null}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void act(async () => {
                          await mutate('membership-benefits', 'PUT', { enabled });
                        });
                      }}
                    />{' '}
                    Apply walk-in member benefits
                  </label>
                  {checkout.customerId && (
                    <p className="caption">
                      Connected customers use their own membership eligibility.
                    </p>
                  )}
                  {memberBenefits === null && (
                    <p className="caption">Refresh the sale to verify member benefits.</p>
                  )}
                </details>
                <details>
                  <summary>Wallet and gift voucher</summary>
                  <WalletControls
                    checkout={checkout}
                    operatorId={draft.ownerId}
                    disabled={disabled}
                    act={act}
                    mutate={mutate}
                  />
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        // Legacy applies with gc_pin 0 and asks for "GC PIN" only when the
                        // voucher needs one (create_order.html:3433-3557).
                        const pin = giftPinRequested && giftPin ? giftPin : '0';
                        setGiftPin('');
                        try {
                          await mutate('gift-vouchers', 'POST', { code: giftCode, pin });
                        } catch (error) {
                          if (
                            error instanceof ApiError &&
                            ['GIFT_VOUCHER_PIN_REQUIRED', 'GIFT_VOUCHER_PIN_INVALID'].includes(
                              error.code,
                            )
                          )
                            setGiftPinRequested(true);
                          throw error;
                        }
                        setGiftPinRequested(false);
                        setGiftCode('');
                      });
                    }}
                  >
                    <label>
                      Gift voucher code
                      <input
                        value={giftCode}
                        onChange={(e) => setGiftCode(e.target.value)}
                        maxLength={100}
                        required
                      />
                    </label>
                    {giftPinRequested && (
                      <label>
                        GC PIN
                        <input
                          type="password"
                          autoComplete="off"
                          inputMode="numeric"
                          placeholder="Enter 6 Digit PIN"
                          value={giftPin}
                          onChange={(e) => setGiftPin(e.target.value)}
                          pattern="[0-9_]{1,20}"
                          maxLength={20}
                          required
                          autoFocus
                        />
                      </label>
                    )}
                    <button
                      className="button secondary"
                      disabled={
                        disabled ||
                        !checkout.verifiedCustomerUntil ||
                        checkout.verifiedCustomerUntil < Date.now()
                      }
                    >
                      Redeem voucher
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={disabled}
                      onClick={() =>
                        void act(async () => {
                          await mutate('gift-vouchers/removals', 'POST');
                        })
                      }
                    >
                      Remove gift voucher
                    </button>
                  </form>
                </details>
                {flags?.showPgDiscountModule !== false &&
                  (flags?.enableNewPgDiscount !== false ||
                    flags?.enableOldPgDiscount !== false) && (
                    <details>
                      <summary>Store and payment gateway discounts</summary>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(async () => {
                            await mutate('discount', 'PUT', {
                              kind: discountKind,
                              amount: discount,
                              apply: true,
                              remark: discountRemark,
                              ...(discountKind === 'store' ? { reason: discountReason } : {}),
                            });
                          });
                        }}
                      >
                        <label>
                          Discount type
                          <select
                            value={discountKind}
                            onChange={(event) =>
                              setDiscountKind(event.target.value === 'pg' ? 'pg' : 'store')
                            }
                          >
                            {flags?.enableNewPgDiscount !== false && (
                              <option value="store">Store discount (PG)</option>
                            )}
                            {flags?.enableOldPgDiscount !== false && (
                              <option value="pg">Payment gateway discount</option>
                            )}
                          </select>
                        </label>
                        <label>
                          Discount amount
                          <input
                            value={discount}
                            onChange={(e) => setDiscount(e.target.value)}
                            inputMode="decimal"
                            pattern="[0-9]+(\.[0-9]{1,2})?"
                            required
                          />
                        </label>
                        <label>
                          Discount remark
                          <input
                            value={discountRemark}
                            onChange={(event) => setDiscountRemark(event.target.value)}
                            minLength={3}
                            maxLength={35}
                            required
                          />
                        </label>
                        {discountKind === 'store' && (
                          <label>
                            Store discount reason
                            <select
                              required
                              value={discountReason}
                              onChange={(event) => setDiscountReason(event.target.value)}
                            >
                              <option value="">Select reason</option>
                              {[
                                'Price mismatch (Online v/s POS)',
                                'Price mismatch (Pricetag v/s POS)',
                                'Price mismatch (During exchange)',
                                'Founder billing',
                                'Marketing activity',
                                'Uniform billing',
                                'Perfume tester',
                                'Trial socks',
                                'Personal Care',
                              ].map((reason) => (
                                <option key={reason}>{reason}</option>
                              ))}
                            </select>
                          </label>
                        )}
                        <button className="button secondary" disabled={disabled}>
                          Apply discount
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={disabled}
                          onClick={() =>
                            void act(async () => {
                              await mutate('discount', 'PUT', {
                                kind: discountKind,
                                amount: '0.00',
                                apply: false,
                              });
                            })
                          }
                        >
                          Remove selected discount
                        </button>
                      </form>
                    </details>
                  )}
                <button
                  className="button secondary full"
                  disabled={disabled}
                  onClick={() =>
                    void act(async () => {
                      await mutate('clear', 'POST');
                    })
                  }
                >
                  Clear checkout and start a new sale
                </button>
                <button
                  className="button secondary full"
                  data-cashier-action={checkout.phase === 'quoted' ? 'quote' : 'proceed quote'}
                  disabled={disabled}
                  onClick={() =>
                    void act(async () => {
                      await mutate('quotes', 'POST');
                    })
                  }
                >
                  {checkout.phase === 'quoted' ? 'Refresh final quote' : 'Get final quote'}
                </button>
                <FastCashCheckout
                  checkout={checkout}
                  ownerId={draft.ownerId}
                  disabled={disabled}
                  mutate={mutate}
                  act={act}
                  onNotice={setNotice}
                  onOrderCreated={onOrderCreated}
                  onPaid={async (receipt) => {
                    await adopt(await readCheckout(draft.storeId, checkout.id, draft.ownerId));
                    completedCallback.current?.(receipt);
                  }}
                />
              </>
            )}
            <CheckoutCartLines
              checkout={checkout}
              disabled={disabled || !editable}
              act={act}
              mutate={mutate}
            />
            <CartQuoteSummary
              checkout={checkout}
              operatorId={draft.ownerId}
              current={quoteIsCurrent(checkout, draft, editable && !disabled)}
            />
            {total !== null && (
              <div className="grand-total">
                <span>Confirmed payable</span>
                <strong>{currency(total)}</strong>
              </div>
            )}
            {checkout.phase === 'quoted' && (
              <>
                <DiscountApproval
                  checkout={checkout}
                  disabled={disabled || !editable}
                  mutate={mutate}
                  act={act}
                  onReady={approvalReady}
                />
                {paymentFormOpen && total !== null && !/^0+(?:\.0+)?$/.test(total) ? (
                  <PaymentPanel
                    ownerId={draft.ownerId}
                    draftId={draft.id}
                    storeId={draft.storeId}
                    orderId=""
                    online={online}
                    preOrder={{
                      payable: total,
                      loadOptions: async () => ({
                        ...(await readCheckoutPaymentOptions(checkout)),
                        payable: total,
                      }),
                      submit: async (payment) => {
                        // Legacy: confirm the payment form, then ajax-order, then the upload.
                        const result = await mutate('order-submissions', 'POST', { payment });
                        setPaymentFormOpen(false);
                        const orderId = result.state?.orderId;
                        if (!orderId) return;
                        onOrderCreated?.(orderId);
                        const failure = z
                          .object({ message: z.string() })
                          .safeParse(result.result?.paymentError);
                        if (failure.success)
                          setProblem(
                            `Order ${orderId} created. ${failure.data.message} Continue with the payment below.`,
                          );
                        else setNotice('Order Created!');
                      },
                    }}
                  />
                ) : (
                  <button
                    className="button primary full"
                    data-cashier-action="proceed"
                    aria-keyshortcuts="P"
                    disabled={
                      disabled ||
                      !editable ||
                      approvalState?.version !== checkout.version ||
                      !approvalState.ready
                    }
                    onClick={() => {
                      // A positive payable opens the payment form first; the order is created only
                      // when the operator confirms it (create_order.html:6177-7239). Zero payable is
                      // the legacy Order Confirmation path.
                      if (total !== null && !/^0+(?:\.0+)?$/.test(total)) {
                        setPaymentFormOpen(true);
                        return;
                      }
                      void act(async () => {
                        const result = await mutate('order-submissions', 'POST');
                        const orderId = result.state?.orderId;
                        if (orderId) {
                          setNotice('Order Created!');
                          onOrderCreated?.(orderId);
                        }
                      });
                    }}
                  >
                    Proceed For Payment
                  </button>
                )}
              </>
            )}
            {checkout.phase === 'submitted' && (
              <>
                <p role="status">
                  Order {checkout.orderId} was created.{' '}
                  {checkout.settlement
                    ? 'Prepaid payment is confirmed. This order is ready for handover.'
                    : 'Payment must be confirmed before handing over products.'}
                </p>
                {checkout.settlement && checkout.orderId ? (
                  <InvoiceActions
                    ownerId={draft.ownerId}
                    storeId={draft.storeId}
                    orderId={checkout.orderId}
                  />
                ) : total !== null && /^0+(?:\.0+)?$/.test(total) ? (
                  <>
                    <p>Prepaid settlement is awaiting confirmation.</p>
                    <button
                      className="button secondary full"
                      disabled={disabled}
                      onClick={() =>
                        void act(async () => {
                          await adopt(
                            await readCheckout(draft.storeId, checkout.id, draft.ownerId),
                          );
                        })
                      }
                    >
                      Check prepaid payment status
                    </button>
                  </>
                ) : (
                  checkout.orderId && (
                    <PaymentPanel
                      ownerId={draft.ownerId}
                      draftId={draft.id}
                      storeId={draft.storeId}
                      orderId={checkout.orderId}
                      online={online}
                      onConfirmed={(receipt) => {
                        const currentState = current.current;
                        if (
                          !currentState ||
                          currentState.draftId !== draft.id ||
                          currentState.draftVersion !== draft.updatedAt ||
                          currentState.draftImport?.status !== 'complete' ||
                          receipt.orderId !== currentState.orderId
                        ) {
                          setProblem(
                            'The payment does not match this saved sale. Review its order before continuing.',
                          );
                          return;
                        }
                        completedCallback.current?.(receipt);
                      }}
                    />
                  )
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
