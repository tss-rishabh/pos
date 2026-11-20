import { currency } from '../../lib/format';
import { Modal } from '../../components/modal';
import { Loader, SkeletonText } from '../../components/loader';
import { readCheckout, recoveryFor } from './client';
import { FastCashCheckout } from './FastCashCheckout';
import { BirthdayPrompt } from './BirthdayPrompt';
import { MembershipEmailPrompt } from './MembershipEmailPrompt';
import { SalespersonAssignments } from './SalespersonAssignments';
import { CustomerProfileCard } from '../customer-insights/profile';
import { CustomerInsights } from '../customer-insights/insights';
import { CustomerBenefitsCard } from '../customer-insights/benefits';
import { CustomerHistoryCard } from '../customer-insights/history';
import { productFeedbackPath } from '../product-feedback/client';
import { CustomerContactPanel } from '../customer-contacts';
import { GlobalVoucherConversion } from '../global-vouchers/conversion';
import { useCheckoutReview, type CheckoutReviewProps } from './useCheckoutReview';
import { renderCheckoutStatus } from './CheckoutStatus';
import { renderCheckoutOptions } from './CheckoutOptions';
import { renderQuotedStep, renderSubmittedStep } from './CheckoutOrderSteps';
import './CheckoutReview.css';
import { bindReviewedCheckout } from '../../offline/review-snapshot';
import { CustomerWebsiteHandoffAction } from '../customer-website-handoff';
import { OrderCopyPanel } from '../order-copy';
import { CartQuoteSummary } from './CartQuoteSummary';
import { CheckoutCartLines } from './CheckoutCartLines';
import { quoteIsCurrent } from './quote-summary';

export type { CheckoutReviewProps } from './useCheckoutReview';
export function CheckoutReview(props: CheckoutReviewProps) {
  const view = useCheckoutReview(props);
  const {
    user,
    draft,
    online,
    onClose,
    onOrderCreated,
    dialogRoot,
    rememberOpenSections,
    checkout,
    busy,
    quoting,
    setQuoting,
    setNotice,
    pendingId,
    profilePending,
    setProfilePending,
    contactPending,
    setContactPending,
    conversionPending,
    setConversionPending,
    copyPending,
    onCopyPending,
    recoveryError,
    current,
    completedCallback,
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
    restoring,
  } = view;
  return (
    <Modal
      size="lg"
      title="Confirm the sale"
      closeLabel="Close checkout"
      onClose={onClose}
      dialogRef={dialogRoot}
      onClickCapture={rememberOpenSections}
      className="checkout-dialog"
    >
      {renderCheckoutStatus(view)}
      {restoring && <Loader inline label="Restoring the saved checkout…" />}
      {!checkout && (
        <button
          className="button primary full"
          disabled={disabled}
          aria-busy={busy}
          onClick={() => void act(start)}
        >
          {busy ? 'Confirming…' : 'Confirm prices online'}
        </button>
      )}
      {checkout && (
        <>
          <div className="checkout-summary">
            <p className="checkout-summary-text">
              {checkout.customerId ? `Customer ${checkout.customerId}` : 'Walk-in customer'} ·{' '}
              {checkout.phase === 'submitted'
                ? 'Order created'
                : `${checkout.cart?.products.items.length || 0} product lines`}
            </p>
            {checkout && (
              <button
                className="button secondary small"
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
          </div>
          <CheckoutCartLines
            checkout={checkout}
            disabled={disabled || !editable}
            act={act}
            mutate={mutate}
          />
          {checkout.draftImport?.status === 'complete' && checkout.phase !== 'cleared' && (
            <SalespersonAssignments
              checkout={checkout}
              operatorId={draft.ownerId}
              disabled={disabled || !editable}
              act={act}
              mutate={mutate}
            />
          )}
          {checkout.customerId && (
            <section className="checkout-section" aria-labelledby="checkout-customer-title">
              <h3 id="checkout-customer-title">Customer</h3>
              <div className="checkout-customer-tools">
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
                        const latest = await readCheckout(
                          draft.storeId,
                          checkout.id,
                          draft.ownerId,
                        );
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
                  <CustomerInsights
                    initiallyOpen
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
              </div>
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
                <BirthdayPrompt
                  key={`birthday:${checkout.id}:${checkout.customerId}`}
                  scope={{
                    operatorId: draft.ownerId,
                    storeId: draft.storeId,
                    checkoutId: checkout.id,
                    customerId: checkout.customerId,
                  }}
                  checkoutVersion={checkout.version}
                  disabled={disabled}
                  onSaved={async () => {
                    await adopt(await readCheckout(draft.storeId, checkout.id, draft.ownerId));
                  }}
                />
              )}
            </section>
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
          <MembershipEmailPrompt
            checkout={checkout}
            operatorId={draft.ownerId}
            disabled={disabled}
            onNotice={setNotice}
            onSaved={async () => {
              await adopt(await readCheckout(draft.storeId, checkout.id, draft.ownerId));
            }}
          />
          {renderCheckoutOptions({ ...view, checkout })}
          {quoting ? (
            <SkeletonText lines={6} label="Loading the final quote…" />
          ) : (
            <CartQuoteSummary
              checkout={checkout}
              operatorId={draft.ownerId}
              current={quoteIsCurrent(checkout, draft, editable && !blocked)}
            />
          )}
          {total !== null && (
            <div className="grand-total">
              <span>Confirmed payable</span>
              <strong>{currency(total)}</strong>
            </div>
          )}
          <div className="checkout-actions">
            {editable && (
              <>
                <button
                  className="button secondary checkout-clear"
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
                  className="button secondary"
                  disabled={disabled}
                  aria-busy={quoting}
                  onClick={() =>
                    void act(async () => {
                      setQuoting(true);
                      try {
                        await mutate('quotes', 'POST');
                      } finally {
                        setQuoting(false);
                      }
                    })
                  }
                >
                  {checkout.phase === 'quoted' ? 'Refresh final quote' : 'Get final quote'}
                </button>
              </>
            )}
            {/* Mounted outside the editable block: its own quote and order submission make the
                sale briefly non-editable, which must not discard the open Fast Checkout dialog. */}
            <FastCashCheckout
              checkout={checkout}
              ownerId={draft.ownerId}
              available={editable}
              disabled={disabled || !editable}
              mutate={mutate}
              act={act}
              onNotice={setNotice}
              onOrderCreated={onOrderCreated}
              onPaid={async (receipt) => {
                await adopt(await readCheckout(draft.storeId, checkout.id, draft.ownerId));
                completedCallback.current?.(receipt);
              }}
            />
          </div>
          {renderQuotedStep({ ...view, checkout })}
          {renderSubmittedStep({ ...view, checkout })}
        </>
      )}
    </Modal>
  );
}
