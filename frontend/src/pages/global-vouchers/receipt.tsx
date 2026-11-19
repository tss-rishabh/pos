import { currency } from '../../lib/format';
import type { VoucherReceipt } from './api';
export function GlobalVoucherReceipt({ receipt }: { receipt: VoucherReceipt }) {
  return (
    <section className="global-voucher-receipt" aria-label="Confirmed voucher operation">
      <h3>Gift voucher issued</h3>
      <p role="status">{receipt.message}</p>
      <dl>
        <dt>Voucher code</dt>
        <dd>
          <code>{receipt.voucherCode}</code>
        </dd>
        <dt>Value</dt>
        <dd>{currency(receipt.amount)}</dd>
        <dt>Customer</dt>
        <dd>{receipt.customerId}</dd>
        <dt>Validity</dt>
        <dd>Won’t expire</dd>
        <dt>Operation</dt>
        <dd>
          <code>{receipt.operationId}</code>
        </dd>
        <dt>Confirmed</dt>
        <dd>{receipt.createdAt}</dd>
      </dl>
    </section>
  );
}
