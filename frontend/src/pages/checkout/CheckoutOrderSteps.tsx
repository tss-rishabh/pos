import { z } from 'zod';
import { readCheckout, readCheckoutPaymentOptions, type Checkout } from './client';
import { PaymentPanel } from './PaymentPanel';
import { InvoiceActions } from './InvoiceActions';
import { DiscountApproval } from './DiscountApproval';
import type { CheckoutReviewView } from './useCheckoutReview';

/** The quoted step: PG-discount approval and the payment form. */
export function renderQuotedStep(view: CheckoutReviewView & { checkout: Checkout }) {
  const {
    draft,
    online,
    onOrderCreated,
    checkout,
    setProblem,
    setNotice,
    paymentFormOpen,
    setPaymentFormOpen,
    approvalState,
    approvalReady,
    act,
    mutate,
    editable,
    disabled,
    total,
  } = view;
  return (
    checkout.phase === 'quoted' && (
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
    )
  );
}
/** The submitted step: the created order, its payment and invoice actions. */
export function renderSubmittedStep(view: CheckoutReviewView & { checkout: Checkout }) {
  const {
    draft,
    online,
    checkout,
    setProblem,
    current,
    completedCallback,
    adopt,
    act,
    disabled,
    total,
  } = view;
  return (
    checkout.phase === 'submitted' && (
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
                  await adopt(await readCheckout(draft.storeId, checkout.id, draft.ownerId));
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
    )
  );
}
