import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import type { LocalDraft } from '../../offline/database';
import type { Principal } from '../../api/types';
import { ApiError, NetworkError } from '../../api/client';
import { useProblem } from '../../components/common';
import {
  authoritativeTotal,
  assertCheckoutDraft,
  createCheckout,
  mutateCheckout,
  readCheckout,
  readOperation,
  reconcileCustomerVerification,
  recoveryFor,
  saveRecovery,
  registrationSchema,
  type Checkout,
  type CheckoutFlags,
} from './client';
import type { ConfirmedPayment } from './PaymentPanel';
import { confirmedPaymentSchema } from './receipts';
import type { CheckoutClearance } from '../../api/checkout-clearance';
import { bindReviewedCheckout } from '../../offline/review-snapshot';
import { displayedMembershipBenefits } from './membership';
import { checkoutOperationReference } from './operation-reference';

export interface CheckoutReviewProps {
  user: Principal;
  draft: LocalDraft;
  online: boolean;
  onClose: () => void;
  onOrderCreated?: (orderId: string) => void;
  onPaymentConfirmed?: (receipt: ConfirmedPayment) => void;
  onCheckoutCleared?: (clearance: CheckoutClearance) => void | Promise<void>;
  recoveryNotice?: string;
}
/** The checkout review state, effects and actions; `CheckoutReview` renders them. */
export function useCheckoutReview({
  user,
  draft,
  online,
  onClose,
  onOrderCreated,
  onPaymentConfirmed,
  onCheckoutCleared,
  recoveryNotice,
}: CheckoutReviewProps) {
  const dialogRoot = useRef<HTMLElement>(null);
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
      ...(dialogRoot.current?.querySelectorAll<HTMLDetailsElement>(
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
    [quoting, setQuoting] = useState(false),
    [problem, setProblem, problemCause, reportProblem] = useProblem(),
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
        reportProblem(error, 'The cleared checkout could not be completed on this device.');
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
        if (active) reportProblem(error, 'Could not restore checkout.');
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
    // `disabled` without the transient busy flag: an action in flight keeps the breakdown
    // in place instead of hiding and re-showing it.
    blocked =
      profilePending ||
      contactPending ||
      conversionPending ||
      copyPending ||
      copyOwned ||
      !online ||
      Boolean(recoveryError),
    total = checkout ? authoritativeTotal(checkout) : null,
    memberBenefits = displayedMembershipBenefits(checkout?.cart);
  const restoring =
    !checkout &&
    online &&
    !recoveryError &&
    !problem &&
    Boolean(recoveryFor(draft.ownerId, draft.id));
  return {
    user,
    draft,
    online,
    onClose,
    onOrderCreated,
    onCheckoutCleared,
    recoveryNotice,
    dialogRoot,
    sectionProps,
    rememberOpenSections,
    checkout,
    busy,
    quoting,
    setQuoting,
    problem,
    setProblem,
    problemCause,
    notice,
    setNotice,
    pendingId,
    otp,
    setOtp,
    coupon,
    setCoupon,
    giftCode,
    setGiftCode,
    giftPin,
    setGiftPin,
    giftPinRequested,
    setGiftPinRequested,
    paymentFormOpen,
    setPaymentFormOpen,
    flags,
    discount,
    setDiscount,
    discountKind,
    setDiscountKind,
    discountRemark,
    setDiscountRemark,
    discountReason,
    setDiscountReason,
    profilePending,
    setProfilePending,
    contactPending,
    setContactPending,
    conversionPending,
    setConversionPending,
    copyPending,
    onCopyPending,
    recoveryError,
    approvalState,
    approvalReady,
    current,
    completedCallback,
    notifiedClear,
    notifyClear,
    adopt,
    store,
    canClearCancelledCopy,
    act,
    mutate,
    start,
    recover,
    copyOwned,
    editable,
    disabled,
    blocked,
    total,
    memberBenefits,
    restoring,
  };
}
export type CheckoutReviewView = ReturnType<typeof useCheckoutReview>;
