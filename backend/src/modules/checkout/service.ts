import type { CheckoutRepository } from './contracts.js';
import type { CheckoutEnvironment, CheckoutGateway } from './gateway.js';
import { checkoutServiceCore, type CheckoutServiceOptions } from './service-core.js';
import { checkoutSessionMethods } from './service-session.js';
import { checkoutCustomerMethods } from './service-customers.js';
import { checkoutCartMethods } from './service-cart.js';
import { checkoutVerificationMethods } from './service-verification.js';
import { checkoutOrderMethods } from './service-order.js';

export type { CheckoutServiceOptions, MutationReply } from './service-core.js';
export {
  assertOrderReady,
  quoteTotal,
  orderGiftCardData,
  giftCardWireData,
  quotePayable,
  publicCart,
  publicState,
  publicMutation,
} from './service-public.js';

export function checkoutService(
  repository: CheckoutRepository,
  gateway: CheckoutGateway,
  environment: CheckoutEnvironment,
  options: CheckoutServiceOptions,
) {
  const core = checkoutServiceCore(repository, gateway, environment, options);
  return {
    ...checkoutSessionMethods(core),
    ...checkoutCustomerMethods(core),
    ...checkoutCartMethods(core),
    ...checkoutVerificationMethods(core),
    ...checkoutOrderMethods(core),
  };
}
