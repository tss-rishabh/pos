/**
 * Legacy payment form behaviour (order/templates/order/create_order.html:5820-5870,
 * 5890-5960, 6041-6135). Amounts are kept as the text the cashier sees; arithmetic is
 * done in paise so values never drift.
 */
export interface PaymentFormValues {
  /** Cash To Be Accepted */
  cash: string;
  /** Cash Recieved */
  received: string;
  /** Card/UPI */
  online: string;
  /** Cash To Be Return */
  change: string;
}
const paise = (value: string): bigint | null => {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
};
/** JS number text, as the legacy inputs show (`450`, `548.5`). */
export const plain = (value: bigint) => String(Number(value) / 100);
const parsed = (value: string) => paise(value) ?? 0n;
const clamp = (value: bigint, total: bigint) => (value > total ? total : value < 0n ? 0n : value);

export function initialPaymentForm(payable: string): PaymentFormValues {
  const total = plain(parsed(payable));
  return { cash: total, received: total, online: '0', change: '0' };
}
/** `#offline_payment` change handler (create_order.html:6066-6091). */
export function changeCash(
  form: PaymentFormValues,
  value: string,
  payable: string,
): PaymentFormValues {
  const total = parsed(payable),
    raw = paise(value);
  let cash = raw === null ? 0n : clamp(raw, total),
    received = parsed(form.received),
    change = parsed(form.change);
  if (raw === null || raw <= 0n) {
    cash = 0n;
    received = 0n;
    change = 0n;
  }
  if (received) {
    if (received <= cash) {
      received = cash;
      change = 0n;
    } else change = received - cash;
  }
  return {
    cash: plain(cash),
    received: plain(received),
    online: plain(total - cash),
    change: plain(change),
  };
}
/** `#online_payment` change handler (create_order.html:6092-6118). */
export function changeOnline(
  form: PaymentFormValues,
  value: string,
  payable: string,
): PaymentFormValues {
  const total = parsed(payable),
    raw = paise(value),
    online = raw === null ? 0n : clamp(raw, total),
    cash = total - online;
  let received = parsed(form.received),
    change = parsed(form.change);
  if (received) {
    if (received <= cash) {
      received = cash;
      change = 0n;
    } else {
      change = received - cash;
      if (change === received) {
        change = 0n;
        received = 0n;
      }
    }
  }
  return {
    cash: plain(cash),
    received: plain(received),
    online: plain(online),
    change: plain(change),
  };
}
/** `#cash_recieved` change handler (create_order.html:6119-6135). */
export function changeReceived(form: PaymentFormValues, value: string): PaymentFormValues {
  const cash = parsed(form.cash),
    raw = paise(value);
  // Legacy compares the raw text numerically, so an empty value counts as 0.
  let received = raw ?? 0n,
    change = parsed(form.change);
  if (received < cash) {
    received = cash;
    change = 0n;
  } else if (raw === null) {
    received = 0n;
  } else {
    change = received - cash;
    if (change === received) {
      change = 0n;
      received = 0n;
    }
  }
  return { ...form, received: plain(received), change: plain(change) };
}
/** `update_message()` (create_order.html:6044-6046). */
export function paymentMessage(form: PaymentFormValues): string {
  return `#Card/UPI Received: ${form.online}\n#Cash Received:${form.received}\n#Cash To Be Accepted:${form.cash}\n#Cash To Be Return:${form.change}`;
}
/** Submit validation, with the legacy alert text, in the legacy order (create_order.html:5900-5952). */
export function paymentFormProblem(input: {
  form: PaymentFormValues;
  payable: string;
  transactionId: string;
  message: string;
  mode: number | null;
  districtTransactionId: string;
  creditPincodeId: string;
}): string | null {
  const cash = paise(input.form.cash),
    online = paise(input.form.online);
  if (cash === null) return 'Enter Valid Value in Cash';
  if (online === null) return 'Enter Valid Value in UPI/Card';
  if (!input.transactionId.trim()) return 'Provide a valid Transaction ID';
  if (!input.message.trim()) return 'Provide a valid Message';
  if (cash > 0n && parsed(input.form.received) === 0n) return 'Provide a value in Cash Recieved';
  if (cash + online !== parsed(input.payable)) return 'Incorrect Pay amount.';
  if (online && input.mode === null) return 'Please Select Payment Mode.';
  if (input.mode === 1005 && !input.districtTransactionId.trim())
    return 'Provide District Transaction ID';
  if (input.mode === 1006 && !input.creditPincodeId.trim())
    return 'Provide Credit-Pincode Transaction ID';
  return null;
}
/** Server amount text (`12.50`). */
export const money = (value: string) => {
  const amount = parsed(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, '0')}`;
};

/** Pine auto status polling (order/templates/order/show.html:512-573). */
export const PINE_POLL_INTERVAL_MS = 5000;
export const PINE_POLL_MAX_ATTEMPTS = 63;
export const PINE_POLL_TIMEOUT_MESSAGE =
  'Auto-check timed out after 5 minutes. Please check status manually.';
export const PAYTM_CANCEL_CONFIRMATION =
  'Do you want to cancel this transaction? As this payment would not be canceled on PayTm side and you have to cancel it mannually on machine';
