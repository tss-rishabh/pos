import { useDeferredValue, useRef, useState } from 'react';
import type { Principal } from '../../api/types';
import { captureOperatorScope } from '../../api/client';
import { useProducts } from '../../hooks/use-pos';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { currency, total } from '../../lib/format';
import {
  addWorksheetLine,
  createWorksheet,
  removeWorksheetLine,
  validateWorksheet,
  worksheetAmounts,
  worksheetCsv,
} from './domain';
import './styles.css';
import printStyles from './styles.css?url&no-inline';

export function OfflineWorksheetPage({ user, storeId }: { user: Principal; storeId: string }) {
  if (!storeId) return <Empty title="Choose a store">Select the store for this worksheet.</Empty>;
  if (!(user.role === 1 && user.userType === 1) && !user.storeIds.includes(storeId))
    return <p role="alert">This store is outside your current access.</p>;
  const owner = JSON.stringify([
    user.id,
    user.role,
    user.userType,
    [...user.storeIds].sort(),
    storeId,
  ]);
  return <OwnedWorksheet key={owner} user={user} storeId={storeId} />;
}
function OwnedWorksheet({ user, storeId }: { user: Principal; storeId: string }) {
  const [sheet, setSheet] = useState(() => createWorksheet(storeId)),
    [search, setSearch] = useState(''),
    [selectedId, setSelectedId] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [price, setPrice] = useState('0.00'),
    [problem, setProblem] = useState<unknown>(null),
    [printReady, setPrintReady] = useState(false);
  const deferredSearch = useDeferredValue(search),
    products = useProducts(user.id, storeId, deferredSearch, true),
    choices = products.data?.pages.flatMap((page) => page.data) ?? [],
    cached = products.data?.pages.some((page) => page.cached),
    amounts = worksheetAmounts(sheet),
    article = useRef<HTMLElement>(null),
    frame = useRef<HTMLIFrameElement>(null);
  const styleHref = new URL(printStyles, window.location.href).href
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;'),
    printDocument = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${styleHref}"><title>Invoice worksheet</title></head><body></body></html>`;
  function add() {
    try {
      captureOperatorScope(user.id).throwIfAborted();
      const product = choices.find((item) => item.id === selectedId);
      if (!product) throw new Error('Choose a product from the current store catalog.');
      const next = addWorksheetLine(sheet, {
        productId: product.id,
        name: product.name,
        quantity,
        unitPrice: price,
      });
      setSheet(next);
      setQuantity('1');
      setPrice('0.00');
      setProblem(null);
    } catch (error) {
      setProblem(error);
    }
  }
  function exportCsv() {
    let url: string | undefined;
    try {
      const signal = captureOperatorScope(user.id),
        content = worksheetCsv(sheet);
      signal.throwIfAborted();
      url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'invoice.csv';
      document.body.append(anchor);
      try {
        signal.throwIfAborted();
        anchor.click();
      } finally {
        anchor.remove();
      }
      setProblem(null);
    } catch (error) {
      setProblem(error);
    } finally {
      if (url) {
        const downloadUrl = url;
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      }
    }
  }
  function print() {
    try {
      captureOperatorScope(user.id).throwIfAborted();
      validateWorksheet(sheet);
      const body = frame.current?.contentDocument?.body,
        content = article.current?.cloneNode(true);
      if (!body || !content || !printReady) throw new Error('The print document is still loading.');
      body.replaceChildren(content);
      body.querySelectorAll('.worksheet-no-print').forEach((element) => element.remove());
      frame.current?.contentWindow?.print();
      setProblem(null);
    } catch (error) {
      setProblem(error);
    }
  }
  return (
    <>
      <PageTitle eyebrow="OFFLINE TOOLS" title="Invoice worksheet">
        <button
          className="button secondary"
          onClick={() => {
            setSheet(createWorksheet(storeId, Math.max(Date.now(), sheet.createdAt + 1)));
            setSelectedId('');
            setQuantity('1');
            setPrice('0.00');
            setProblem(null);
          }}
        >
          New worksheet
        </button>
      </PageTitle>
      <p className="muted">
        Prepare a draft with manual prices, then print or export it for review.
      </p>
      {problem !== null && <ErrorState error={problem} />}
      <section className="surface worksheet-editor" aria-label="Worksheet details">
        <label>
          Customer name
          <input
            autoComplete="off"
            maxLength={256}
            value={sheet.customerName}
            onChange={(event) => setSheet({ ...sheet, customerName: event.target.value })}
          />
        </label>
        <label>
          Customer email
          <input
            type="email"
            autoComplete="off"
            maxLength={254}
            value={sheet.customerEmail}
            onChange={(event) => setSheet({ ...sheet, customerEmail: event.target.value })}
          />
        </label>
        <label>
          Find a product
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setSelectedId('');
            }}
            placeholder="Product name, barcode or ID"
          />
        </label>
        <label>
          Product
          <select
            aria-label="Product"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">Choose a product</option>
            {choices.map((product) => (
              <option key={product.id} value={product.id}>
                {product.barcode ?? 'No barcode'} · {product.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <input
            inputMode="numeric"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </label>
        <label>
          Unit price
          <input
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </label>
        <button className="button primary" disabled={!selectedId} onClick={add}>
          Add to worksheet
        </button>
        {products.hasNextPage && (
          <button
            className="button secondary"
            disabled={products.isFetchingNextPage}
            onClick={() => void products.fetchNextPage()}
          >
            Load more products
          </button>
        )}
        {products.isPending ? (
          <Loading />
        ) : products.isError ? (
          <ErrorState error={products.error} retry={() => void products.refetch()} />
        ) : null}
        {cached && <p role="status">Using products already cached on this device.</p>}
      </section>
      <article
        ref={article}
        className="surface worksheet-document"
        aria-label="Invoice worksheet preview"
      >
        <header>
          <h2>THE SOULED STORE</h2>
          <h3>INVOICE WORKSHEET</h3>
          <p>Draft · Payment not recorded</p>
          <p>
            Store {storeId} · Worksheet {sheet.serialNo}
          </p>
          <p>Customer: {sheet.customerName || 'Walk-in'}</p>
          {sheet.customerEmail && <p>Email: {sheet.customerEmail}</p>}
          <p>Operator: {user.name}</p>
          <time dateTime={new Date(sheet.createdAt).toISOString()}>
            {new Date(sheet.createdAt).toLocaleString('en-IN')}
          </time>
        </header>
        <table>
          <thead>
            <tr>
              <th>Product ID</th>
              <th>Product name</th>
              <th>Quantity</th>
              <th>Unit price</th>
              <th>Value</th>
              <th className="worksheet-no-print">Action</th>
            </tr>
          </thead>
          <tbody>
            {sheet.lines.map((line) => (
              <tr key={line.id}>
                <td>{line.productId}</td>
                <td>{line.name}</td>
                <td>{line.quantity}</td>
                <td>{currency(line.unitPrice)}</td>
                <td>{currency(total([line]))}</td>
                <td className="worksheet-no-print">
                  <button
                    className="button secondary small"
                    aria-label={`Remove worksheet line ${line.name}`}
                    onClick={() => {
                      setSheet(removeWorksheetLine(sheet, line.id));
                      setProblem(null);
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sheet.lines.length && <p>Add products to prepare this worksheet.</p>}
        <dl>
          <div>
            <dt>Subtotal</dt>
            <dd>{currency(amounts.total)}</dd>
          </div>
          <div>
            <dt>Rounding down</dt>
            <dd>−{currency(amounts.rounding)}</dd>
          </div>
          <div>
            <dt>Rounded worksheet total</dt>
            <dd>{currency(amounts.rounded)}</dd>
          </div>
        </dl>
        <footer>Invoice worksheet for review. Payment not recorded.</footer>
      </article>
      <div className="worksheet-actions">
        <button className="button secondary" disabled={!sheet.lines.length} onClick={exportCsv}>
          Export invoice.csv
        </button>
        <button
          className="button primary"
          disabled={!sheet.lines.length || !printReady}
          onClick={print}
        >
          Print worksheet
        </button>
      </div>
      <iframe
        ref={frame}
        className="worksheet-print-frame"
        title="Worksheet print document"
        sandbox="allow-same-origin allow-modals"
        srcDoc={printDocument}
        onLoad={() => setPrintReady(true)}
      />
    </>
  );
}
export default OfflineWorksheetPage;
