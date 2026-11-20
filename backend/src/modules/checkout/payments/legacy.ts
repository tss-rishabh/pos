/**
 * Pure ports of the legacy payment rules (backend-pos-web@78d5b63). No I/O.
 */
import { pythonFloatRepr } from '../../../domain/python-compat.js';
import type { PaytmReply, PineReply } from './contracts.js';

/** `Helpers.get_transaction_id` (helpers/helpers.py:714-737). */
export function legacyTransactionId(input: {
  orderId: string;
  orderRefNo: string;
  inactivePineCreated: number;
  inactivePaytmCreated: number;
  activePaytmCreated: number;
}): string {
  const pine = input.inactivePineCreated ? input.inactivePineCreated + 1 : 0,
    paytm = input.inactivePaytmCreated ? input.inactivePaytmCreated + 1 : 0,
    total = pine + paytm;
  let reference = input.orderRefNo,
    suffix: string;
  if (input.activePaytmCreated) {
    reference = reference.replaceAll('-', '');
    suffix = String(total);
  } else suffix = `-${total}`;
  if (total) return reference ? `${reference}${suffix}` : `${input.orderId}${suffix}`;
  const result = reference || input.orderId;
  return result.replaceAll('-', '').length >= 8 ? result : input.orderId;
}

/** `pay_dict` written by `complete_order` / `AjaxPaymentStatusView` (floats, Python repr). */
export function legacyPayDict(entries: [string, number][]): string {
  return '{' + entries.map(([key, item]) => `'${key}': ${pythonFloatRepr(item)}`).join(', ') + '}';
}

/** Result of a provider reply, classified as legacy handles it. */
export interface Classified {
  /** pending = awaiting the terminal; failed = definitive, cashier may re-initiate. */
  status: 'pending' | 'paid' | 'failed' | 'cancelled';
  /** Legacy status string returned by the original view. */
  legacyStatus: string;
  /** Legacy UI text shown for it (create_order.html / show.html). */
  message: string;
}
const printable = (value: string) =>
  value
    .replace(/[^\x20-\x7e]/g, ' ')
    .trim()
    .slice(0, 200) || 'Failed, unknown response';

/** `TerminalHelper.upload_billed_transaction` (terminal_helpers.py:56-86). */
export function classifyPineUpload(reply: PineReply): Classified {
  if (reply.responseCode === 0 && reply.responseMessage === 'APPROVED')
    return { status: 'pending', legacyStatus: 'Approved', message: 'Approved' };
  switch (reply.responseMessage) {
    case 'PLEASE APPROVE OPEN TXN FIRST':
      return { status: 'failed', legacyStatus: 'Open', message: 'Please Approve Open Txn First' };
    case 'TXN ALREADY COMPLETED':
      return {
        status: 'failed',
        legacyStatus: 'Already Completed',
        message: 'Already Completed',
      };
    case 'INVALID MERCHANT':
      return { status: 'failed', legacyStatus: 'Invalid Merchant', message: 'Invalid Merchant' };
    default: {
      const text = printable(reply.responseMessage);
      return { status: 'failed', legacyStatus: text, message: text };
    }
  }
}
/** `PaytmHelper.create_paytm_payment_request` (terminal_helpers.py:392-418). */
export function classifyPaytmRequest(reply: PaytmReply): Classified {
  const known: Record<string, string> = {
    '0333': 'Open',
    '0233': 'Duplicate Order ID',
    '0007': 'Terminal Not In Active State',
    '0002': 'Request parameters are not valid',
  };
  if (reply.resultCode === '0009')
    return { status: 'pending', legacyStatus: 'Approved', message: 'Approved' };
  const legacy = known[reply.resultCode];
  if (legacy)
    return {
      status: 'failed',
      legacyStatus: legacy,
      message: legacy === 'Open' ? 'Please Approve Open Txn First' : legacy,
    };
  const text = printable(`${reply.resultCode} ${reply.resultMessage}`);
  return { status: 'failed', legacyStatus: text, message: text };
}
/** `TerminalHelper.get_transaction_status` (terminal_helpers.py:128-157) + show.html:536-556. */
export function classifyPineStatus(reply: PineReply): Classified {
  if (reply.responseMessage === 'TXN APPROVED')
    return {
      status: 'paid',
      legacyStatus: 'Approved',
      message: 'Transaction Completed Successfully',
    };
  if (reply.responseMessage === 'TXN UPLOADED')
    return {
      status: 'pending',
      legacyStatus: 'UPLOADED',
      message: 'Status :UPLOADED, Check Status Again',
    };
  if (reply.responseMessage === 'INVALID PLUTUS TXN REF ID')
    return {
      status: 'failed',
      legacyStatus: 'INVALID PLUTUS ID',
      message: 'Time Out, Initialize Transaction Again',
    };
  return {
    status: 'pending',
    legacyStatus: 'Failed',
    message: 'Status :Failed, Check Status Again',
  };
}
/** `PaytmHelper.paytm_payment_status_check` (terminal_helpers.py:477-535). */
export function classifyPaytmStatus(reply: PaytmReply): Classified {
  if (reply.resultCode === '0000')
    return {
      status: 'paid',
      legacyStatus: 'Approved',
      message: 'Transaction Completed Successfully',
    };
  // Legacy compares against ' 0011' (leading space) and so never matches; the
  // provider's definitive failure is surfaced without any extra write.
  if (reply.resultCode === '0011')
    return {
      status: 'failed',
      legacyStatus: 'sale txn has failed',
      message: 'sale txn has failed',
    };
  if (reply.resultCode === '0404')
    return {
      status: 'failed',
      legacyStatus: 'Merchant transaction id does not exits..!',
      message: 'Merchant transaction id does not exits..!',
    };
  const text =
    'Payment has been cancelled or there is an issue with status check please reload the page';
  return { status: 'pending', legacyStatus: text, message: `Status :${text}, Check Status Again` };
}
/** `TerminalHelper.cancel_transaction` (terminal_helpers.py:205-232) + show.html cancel handler. */
export function classifyPineCancel(reply: PineReply): Classified | null {
  if (reply.responseCode === 0 && reply.responseMessage === 'APPROVED')
    return {
      status: 'cancelled',
      legacyStatus: 'Approved',
      message: 'Transaction Cancelled Successfully',
    };
  if (reply.responseCode === 1 && reply.responseMessage === 'TRANSACTION NOT FOUND')
    return {
      status: 'pending',
      legacyStatus: 'TRANSACTION NOT FOUND',
      message: 'Status :TRANSACTION NOT FOUND, Check Status Again',
    };
  if (
    reply.responseCode === 1 &&
    reply.responseMessage === 'CANNOT CANCEL AS TRANSACTION IS IN PROGRESS'
  )
    return {
      status: 'pending',
      legacyStatus: 'CANNOT CANCEL AS TRANSACTION IS IN PROGRESS',
      message: 'Cannot Cancel as Transaction is in Progress',
    };
  return null;
}

/** Message the legacy form composes (create_order.html:6044-6046). */
export function legacyPaymentMessage(values: {
  online: string;
  cashReceived: string;
  cash: string;
  change: string;
}): string {
  return `#Card/UPI Received: ${values.online}\n#Cash Received:${values.cashReceived}\n#Cash To Be Accepted:${values.cash}\n#Cash To Be Return:${values.change}`;
}
