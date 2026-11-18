import { describe, expect, it } from 'vitest';
import {
  changeCash,
  changeOnline,
  changeReceived,
  initialPaymentForm,
  money,
  paymentFormProblem,
  paymentMessage,
} from '../src/pages/checkout/payments/form';
import { settlementReceiptId } from '../src/pages/checkout/payments/client';

describe('legacy payment form (create_order.html:6041-6135)', () => {
  const payable = '999.00';
  it('starts all cash with the 4-line breakdown message', () => {
    const form = initialPaymentForm(payable);
    expect(form).toEqual({ cash: '999', received: '999', online: '0', change: '0' });
    expect(paymentMessage(form)).toBe(
      '#Card/UPI Received: 0\n#Cash Received:999\n#Cash To Be Accepted:999\n#Cash To Be Return:0',
    );
  });
  it('auto-splits and clamps cash against card/UPI and keeps received at least the cash', () => {
    let form = initialPaymentForm(payable);
    form = changeCash(form, '450.5', payable);
    expect(form).toEqual({ cash: '450.5', received: '999', online: '548.5', change: '548.5' });
    form = changeReceived(form, '500');
    expect(form).toMatchObject({ received: '500', change: '49.5' });
    form = changeReceived(form, '100');
    expect(form).toMatchObject({ received: '450.5', change: '0' });
    form = changeCash(form, '5000', payable);
    expect(form).toMatchObject({ cash: '999', online: '0', received: '999' });
    form = changeCash(form, '0', payable);
    expect(form).toEqual({ cash: '0', received: '0', online: '999', change: '0' });
    form = changeOnline(initialPaymentForm(payable), '-5', payable);
    expect(form).toMatchObject({ online: '0', cash: '999' });
    form = changeOnline(initialPaymentForm(payable), '1200', payable);
    expect(form).toEqual({ cash: '0', received: '0', online: '999', change: '0' });
  });
  it('validates with the legacy alert text and order', () => {
    const base = {
      form: initialPaymentForm(payable),
      payable,
      transactionId: 'TSS-1',
      message: 'note',
      mode: null,
      districtTransactionId: '',
      creditPincodeId: '',
    };
    expect(paymentFormProblem(base)).toBeNull();
    expect(paymentFormProblem({ ...base, message: ' ' })).toBe('Provide a valid Message');
    expect(paymentFormProblem({ ...base, form: { ...base.form, cash: 'x' } })).toBe(
      'Enter Valid Value in Cash',
    );
    expect(paymentFormProblem({ ...base, form: { ...base.form, received: '0' } })).toBe(
      'Provide a value in Cash Recieved',
    );
    expect(paymentFormProblem({ ...base, form: { ...base.form, cash: '998' } })).toBe(
      'Incorrect Pay amount.',
    );
    const split = changeCash(base.form, '499', payable);
    expect(paymentFormProblem({ ...base, form: split })).toBe('Please Select Payment Mode.');
    expect(paymentFormProblem({ ...base, form: split, mode: 1005 })).toBe(
      'Provide District Transaction ID',
    );
    expect(paymentFormProblem({ ...base, form: split, mode: 1006 })).toBe(
      'Provide Credit-Pincode Transaction ID',
    );
    expect(money('548.5')).toBe('548.50');
  });
  it('derives one stable receipt identity per settlement', () => {
    const value = settlementReceiptId('9007199254740993', 'TSS-1');
    expect(value).toBe(settlementReceiptId('9007199254740993', 'TSS-1'));
    expect(value).not.toBe(settlementReceiptId('9007199254740993', 'TSS-1-2'));
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
