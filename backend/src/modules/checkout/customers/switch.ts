import type { CheckoutState } from '../contracts.js';
import type { CustomerContactBinding } from '../customer-contact-authority.js';

/**
 * Legacy "Connect the User" while a customer is already connected (`create_order.html:2986-3033`,
 * `is_cart_sync = 0`) → `AjaxSyncCartView` (`order/views.py:1994-2019`) only re-points the tab to
 * the new customer (`redis_instance.set(tab_id, user_id)`): no `syncart`, no cart clear. The sale
 * then shows the new customer's own API-v2 cart. Verification is per customer (`{user}_{tab}`), so
 * nothing verified for the previous customer carries over, and the quote is re-read.
 *
 * Returns the next state; the caller reads the new customer's cart afterwards. `verifiedUntil` and
 * `contact` are the new customer's registration proof, if any (`verifiedCustomerUntil`).
 */
export function switchedCustomerState(
  state: CheckoutState,
  customerId: string,
  verifiedUntil: number | null,
  contact: CustomerContactBinding | null,
  now: number,
): CheckoutState {
  return {
    ...state,
    customerId,
    verifiedCustomerUntil: verifiedUntil,
    verifiedCustomerContact: verifiedUntil ? contact : null,
    verificationChallenge: null,
    cart: null,
    quote: null,
    phase: 'open',
    updatedAt: now,
  };
}
