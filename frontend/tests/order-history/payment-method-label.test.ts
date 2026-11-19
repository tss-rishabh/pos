import { describe, expect, it } from 'vitest';
import { paymentMethodLabel } from '../../src/pages/order-history/payment-method-label';

describe('order-list payment method display', () => {
  it('joins the legacy method and split parts only when both exist', () => {
    // Legacy f"{pay_method}: {cash} {other} {online}" with an empty method name.
    expect(paymentMethodLabel(': CASH  ')).toBe('CASH');
    expect(paymentMethodLabel('Cash: CASH  ')).toBe('Cash: CASH');
    expect(paymentMethodLabel('Cash: CASH + Online (Other) ')).toBe('Cash: CASH + Online (Other)');
    expect(paymentMethodLabel('Cash: CASH  +UPI')).toBe('Cash: CASH +UPI');
    expect(paymentMethodLabel('None:   CARD')).toBe('None: CARD');
  });
  it('keeps plain and pending method names unchanged', () => {
    expect(paymentMethodLabel('COD')).toBe('COD');
    expect(paymentMethodLabel('Razorpay (Pending)')).toBe('Razorpay (Pending)');
    expect(paymentMethodLabel('')).toBe('');
    expect(paymentMethodLabel(null)).toBe('');
  });
});
