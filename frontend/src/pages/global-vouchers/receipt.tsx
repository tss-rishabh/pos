import { currency } from '../../lib/format';
import type { VoucherReceipt } from './api';
export function GlobalVoucherReceipt({ receipt }: { receipt: VoucherReceipt }) {
  return (
    <section className="global-voucher-receipt" aria-label="Confirmed voucher operation">
      <h3>
        {receipt.kind === 'issuance' ? 'Gift voucher issued' : 'Voucher converted to TSS Money'}
      </h3>
      <dl>
        <dt>Voucher code</dt>
        <dd>
          <code>{receipt.voucherCode}</code>
        </dd>
        <dt>Value</dt>
        <dd>{currency(receipt.amount)}</dd>
        <dt>Customer</dt>
        <dd>{receipt.customerId}</dd>
        {receipt.nonExpiring && (
          <>
            <dt>Validity</dt>
            <dd>Won’t expire</dd>
          </>
        )}
        {receipt.walletAfter !== null && (
          <>
            <dt>TSS Money balance</dt>
            <dd>{currency(receipt.walletAfter)}</dd>
          </>
        )}
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
