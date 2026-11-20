import { ApiError } from '../../api/client';
import { readCheckout, type Checkout } from './client';
import { WalletControls } from './WalletControls';
import { CustomerLookup } from './CustomerLookup';
import { GiftCardItems } from './GiftCardItems';
import { CustomerRegistration } from './CustomerRegistration';
import type { CheckoutReviewView } from './useCheckoutReview';

/** The editable sale options: gift cards, registration, coupon, vouchers and discounts. */
export function renderCheckoutOptions(view: CheckoutReviewView & { checkout: Checkout }) {
  const {
    draft,
    sectionProps,
    checkout,
    setNotice,
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
    flags,
    discount,
    setDiscount,
    discountKind,
    setDiscountKind,
    discountRemark,
    setDiscountRemark,
    discountReason,
    setDiscountReason,
    adopt,
    act,
    mutate,
    editable,
    disabled,
    memberBenefits,
  } = view;
  return (
    editable && (
      <div className="checkout-options">
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
            <input type="checkbox" checked disabled readOnly />
            NPS Feedback
          </label>
          <p className="caption">
            The order SMS is sent after the order is confirmed. Its delivery does not determine
            payment status.
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
                Detaching the customer clears this checkout's items, benefits and salesperson
                assignments.
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
                    setNotice('Verification queued. Check delivery before entering the code.');
                  })
                }
              >
                Send verification code
              </button>
              {/* create_order.html:258 */}
              <p role="status">
                {checkout.verifiedCustomerUntil && checkout.verifiedCustomerUntil > Date.now()
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
                  setNotice('Applied Succesfully');
                  setCoupon('');
                });
              }}
            >
              <label>
                Coupon
                <input value={coupon} onChange={(e) => setCoupon(e.target.value)} maxLength={100} />
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
                    setNotice('Removed Succesfully');
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
            <p className="caption">Connected customers use their own membership eligibility.</p>
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
                    ['GIFT_VOUCHER_PIN_REQUIRED', 'GIFT_VOUCHER_PIN_INVALID'].includes(error.code)
                  )
                    setGiftPinRequested(true);
                  throw error;
                }
                setGiftPinRequested(false);
                setGiftCode('');
                setNotice('Applied/Remove');
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
                  setNotice('Applied/Remove');
                })
              }
            >
              Remove gift voucher
            </button>
          </form>
        </details>
        {flags?.showPgDiscountModule !== false &&
          (flags?.enableNewPgDiscount !== false || flags?.enableOldPgDiscount !== false) && (
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
                    setNotice('Applied Succesfully');
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
                      setNotice('Removed Succesfully');
                    })
                  }
                >
                  Remove selected discount
                </button>
              </form>
            </details>
          )}
      </div>
    )
  );
}
