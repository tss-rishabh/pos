import { Printer, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { LocalCashReceipt } from '../../../offline/cash/storage-types';
import { InvoiceActions } from '../InvoiceActions';
import './styles.css';
import receiptStylesUrl from './styles.css?url&no-inline';

export function cashCurrency(cents: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(cents / 100);
}
export function CashReceiptDialog({
  value,
  operatorId,
  online,
  actions,
  onClose,
}: {
  value: Pick<LocalCashReceipt, 'envelope' | 'syncState' | 'acceptance'>;
  operatorId: string;
  online: boolean;
  actions?: ReactNode;
  onClose: () => void;
}) {
  const receipt = value.envelope.receipt;
  const eventTime = new Date(receipt.completedAt),
    deviceTime = Number.isFinite(eventTime.getTime())
      ? eventTime.toISOString()
      : 'Unavailable device time';
  const article = useRef<HTMLElement>(null),
    frame = useRef<HTMLIFrameElement>(null),
    [printReady, setPrintReady] = useState(false);
  const styleHref = new URL(receiptStylesUrl, window.location.href).href
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  const printDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${styleHref}"><title>Cash receipt</title></head><body></body></html>`;
  return (
    <div className="modal-backdrop">
      <section
        className="modal cash-receipt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cash-receipt-title"
      >
        <button
          className="icon-button modal-close cash-no-print"
          aria-label="Close cash receipt"
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="cash-receipt-title" className="cash-no-print">
          Saved cash receipt
        </h2>
        <p className="cash-no-print" role="status">
          {value.syncState === 'pending'
            ? 'Cash received. The receipt is saved on this device and will synchronize when you reconnect.'
            : value.syncState === 'conflicted'
              ? 'Cash received and recorded on the server. A manager is reviewing the reconciliation.'
              : value.syncState === 'imported'
                ? 'Cash received and the order is synchronized.'
                : 'Cash received and recorded on the server. The order is being reconciled.'}
        </p>
        <article ref={article} className="offline-cash-receipt" aria-label="Cash receipt">
          <header>
            <strong>THE SOULED STORE</strong>
            <h3>CASH RECEIPT</h3>
            <p>
              Store {receipt.storeId} · Counter {receipt.counterId}
            </p>
            <p>Business date {receipt.businessDate}</p>
            <code>{receipt.receiptNumber}</code>
          </header>
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Qty</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line) => (
                <tr key={line.productId}>
                  <td>
                    {line.name}
                    <small>
                      SKU {line.productId} · Unit ₹{line.unitPrice}
                    </small>
                    {line.hsn && <small>HSN {line.hsn}</small>}
                  </td>
                  <td>{line.quantity}</td>
                  <td>{cashCurrency(line.taxableCents + line.taxCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl>
            <div>
              <dt>Taxable amount</dt>
              <dd>{cashCurrency(receipt.taxableCents)}</dd>
            </div>
            <div>
              <dt>GST</dt>
              <dd>{cashCurrency(receipt.taxCents)}</dd>
            </div>
            <div>
              <dt>Rounding</dt>
              <dd>−{cashCurrency(receipt.roundingCents)}</dd>
            </div>
            <div className="cash-total">
              <dt>Paid in cash</dt>
              <dd>{cashCurrency(receipt.payableCents)}</dd>
            </div>
            <div>
              <dt>Cash received</dt>
              <dd>{cashCurrency(receipt.cashReceivedCents)}</dd>
            </div>
            <div>
              <dt>Change returned</dt>
              <dd>{cashCurrency(receipt.changeCents)}</dd>
            </div>
          </dl>
          <footer>
            <p>Cash payment completed on this device.</p>
            <p>
              This cash receipt is separate from the tax invoice, which is available after
              synchronization.
            </p>
            <small>Receipt reference {receipt.id}</small>
            <small>Operator {receipt.operatorId}</small>
            <small>Device time {deviceTime}</small>
          </footer>
        </article>
        <iframe
          className="cash-print-frame"
          ref={frame}
          title="Cash receipt print document"
          sandbox="allow-same-origin allow-modals"
          srcDoc={printDocument}
          onLoad={() => {
            const body = frame.current?.contentDocument?.body;
            if (body && article.current) {
              body.replaceChildren(article.current.cloneNode(true));
              setPrintReady(true);
            }
          }}
        />
        <div className="cash-no-print cash-actions">
          <button
            className="button primary"
            disabled={!printReady}
            onClick={() => frame.current?.contentWindow?.print()}
          >
            <Printer size={17} /> Print cash receipt
          </button>
          {online && value.syncState === 'imported' && value.acceptance?.orderId && (
            <InvoiceActions
              storeId={receipt.storeId}
              orderId={value.acceptance.orderId}
              ownerId={operatorId}
            />
          )}
        </div>
        <div className="cash-no-print">{actions}</div>
      </section>
    </div>
  );
}
