import type { Checkout } from '../../src/pages/checkout/client';
export const quoteCalculations = {
  name: 'calculations',
  products_total: '999.99',
  total_savings: '30.50',
  exclusive_savings: '20.25',
  used_store_discount_pg: '10.25',
  used_tss_points: '5.00',
  coupon_discount: '10.00',
  gift_voucher_value: '25.49',
  used_tss_money: '50.25',
  gst_total: '47.61',
  rounding_off: '0.49',
  total: '868.00',
  app_cashback: '20.49',
};
export function quotedCheckout(): Checkout {
  const cart = {
    products: {
      items: [
        {
          prod_id: '9007199254740993',
          parent_prod_id: '9',
          product: 'Quoted shirt',
          quantity: 2,
          price: '500.49',
          spl_price: '450.25',
        },
      ],
    },
    complementary_products: {
      items: [
        {
          prod_id: '9007199254740995',
          parent_prod_id: '0',
          product: 'Complimentary bag',
          quantity: 1,
          price: '0.00',
        },
      ],
    },
    meta: { items: [quoteCalculations] },
  };
  return {
    id: '00000000-0000-4000-8000-000000000001',
    operatorId: '1',
    storeId: '2',
    counterId: '3',
    version: 1,
    draftId: '00000000-0000-4000-8000-000000000002',
    draftVersion: 1,
    customerId: null,
    draftImport: { status: 'complete', lineItems: [], completedProductIds: [] },
    verifiedCustomerUntil: null,
    phase: 'quoted',
    orderId: null,
    cart,
    quote: cart,
    busyOperationId: null,
    giftCards: {},
    quoteDisplay: {
      nonCouponDiscount: '20.50',
      totalBeforeRounding: '868.49',
      cashbackCreditMessage: 'Fixture configured cashback timing.',
    },
  };
}
