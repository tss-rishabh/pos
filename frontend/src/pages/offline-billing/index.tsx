import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Banknote,
  CloudCheck,
  CloudOff,
  CreditCard,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import { Empty, PageTitle } from '../../components/common';
import { Loader } from '../../components/loader';
import { Modal } from '../../components/modal';
import {
  desktopOfflineBridge,
  offlineBillingClient,
  OfflineBillingClientError,
  type OfflineBillingClient,
} from '../../offline/billing/bridge';
import type {
  CatalogProduct,
  OfflineReceipt,
  OfflineSale,
  OfflineStatus,
  ResolutionAction,
  Tender,
} from '../../offline/billing/contracts';
import { formatMoney, parseMoney, saleTotals } from '../../offline/billing/money';
import './styles.css';

const rupees = (paise: number) => `Rs. ${formatMoney(paise)}`;
const statusLabel: Record<OfflineSale['status'], string> = {
  queued: 'Waiting to sync',
  syncing: 'Syncing',
  synced: 'Synced',
  needs_manager: 'Needs manager',
  voided: 'Voided',
};
const statusTone: Record<OfflineSale['status'], string> = {
  queued: 'amber',
  syncing: 'amber',
  synced: 'green',
  needs_manager: 'red',
  voided: 'neutral',
};
function message(error: unknown) {
  return error instanceof OfflineBillingClientError || error instanceof Error
    ? error.message
    : 'Offline billing could not complete this request.';
}

interface CartLine {
  product: CatalogProduct;
  quantity: number;
}
type TenderMode = Tender['mode'];

/** Desktop offline billing (Phase D2). Web browsers have no bridge and must be
 * online to bill. */
export default function OfflineBillingPage() {
  const client = useMemo(() => {
    const bridge = desktopOfflineBridge();
    return bridge ? offlineBillingClient(bridge) : null;
  }, []);
  if (!client)
    return (
      <>
        <PageTitle title="Offline billing" />
        <Empty title="Offline billing needs the desktop app">
          Web browsers need an internet connection to bill. Use the Souled POS desktop app to keep
          billing during an outage.
        </Empty>
      </>
    );
  return <OfflineBilling client={client} />;
}

function OfflineBilling({ client }: { client: OfflineBillingClient }) {
  const [status, setStatus] = useState<OfflineStatus | null>(null),
    [sales, setSales] = useState<OfflineSale[]>([]),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<OfflineReceipt | null>(null),
    [resolving, setResolving] = useState<OfflineSale | null>(null),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [nextStatus, list] = await Promise.all([
        client.call('offline:status', {}),
        client.call('offline:sale:list', { limit: 100 }),
      ]);
      setStatus(nextStatus);
      setSales(list.sales);
    } catch (e) {
      setError(message(e));
    }
  }, [client]);
  useEffect(() => {
    void refresh();
    const unsubscribe = client.onStatusChanged(() => void refresh());
    const timer = setInterval(() => void refresh(), 30000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [client, refresh]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      void refresh();
    }
  }
  const operator = status?.operator ?? null;
  const canBill = Boolean(
    status?.available && !status.online && operator?.eligible && status.limits.allowed,
  );
  return (
    <>
      <PageTitle title="Offline billing">
        <button
          className="button secondary"
          disabled={busy || !status?.online}
          aria-busy={busy}
          onClick={() =>
            void run(async () => setStatus(await client.call('offline:sync:retry', {})))
          }
        >
          {!busy && <RefreshCw size={16} />}
          Sync now
        </button>
        <button
          className="button secondary"
          disabled={busy || !status?.online || !operator?.storeId}
          onClick={() =>
            void run(async () => void (await client.call('offline:catalog:refresh', {})))
          }
        >
          <RefreshCw size={16} />
          Refresh catalogue
        </button>
      </PageTitle>
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      {!status && !error && <Loader label="Loading offline billing…" />}
      {status && <StatusPanel status={status} />}
      {status && !status.online && canBill && operator?.storeId && status.counters.length > 0 && (
        <SaleComposer
          client={client}
          storeId={operator.storeId}
          counters={status.counters}
          busy={busy}
          onCompleted={(value) => {
            setReceipt(value);
            void refresh();
          }}
          onError={setError}
        />
      )}
      <section className="surface">
        <div className="surface-title">
          <h2>Offline sales on this device</h2>
          <span className="badge neutral">{sales.length}</span>
        </div>
        {sales.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Billed</th>
                  <th>Amount</th>
                  <th>Tender</th>
                  <th>Status</th>
                  <th>Invoice</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((sale) => (
                  <tr key={sale.saleId}>
                    <td className="mono">{sale.provisionalRef}</td>
                    <td>{new Date(sale.createdAt).toLocaleString()}</td>
                    <td>{rupees(sale.payablePaise)}</td>
                    <td>{sale.tender.mode.toUpperCase()}</td>
                    <td>
                      <span className={`badge ${statusTone[sale.status]}`}>
                        {statusLabel[sale.status]}
                      </span>
                      {sale.conflict && (
                        <small className="offline-conflict">{sale.conflict.message}</small>
                      )}
                    </td>
                    <td className="mono">{sale.invoiceNumber ?? '—'}</td>
                    <td className="offline-actions">
                      <button
                        className="button secondary"
                        onClick={() =>
                          void run(async () =>
                            setReceipt(
                              (await client.call('offline:sale:reprint', { saleId: sale.saleId }))
                                .receipt,
                            ),
                          )
                        }
                      >
                        <Printer size={15} />
                        Reprint
                      </button>
                      {sale.status === 'needs_manager' && (
                        <button
                          className="button secondary"
                          disabled={!operator?.manager}
                          title={
                            operator?.manager
                              ? undefined
                              : 'A store manager must resolve this sale.'
                          }
                          onClick={() => setResolving(sale)}
                        >
                          <ShieldCheck size={15} />
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No offline sales">
            Sales billed during an outage appear here until they sync.
          </Empty>
        )}
      </section>
      {receipt && <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />}
      {resolving && (
        <ResolveDialog
          sale={resolving}
          onClose={() => setResolving(null)}
          onResolve={(input) =>
            run(async () => {
              await client.call('offline:conflict:resolve', { saleId: resolving.saleId, ...input });
              setResolving(null);
            })
          }
        />
      )}
    </>
  );
}

/**
 * W27: a compact status strip, shown only when it matters — offline, unavailable, sales waiting
 * or needing a manager, a blocked limit or a sync error. While online with nothing pending the
 * page shows no status card (the header carries the connection state).
 */
function StatusPanel({ status }: { status: OfflineStatus }) {
  const limits = status.limits;
  const waiting = status.queue.queued + status.queue.syncing;
  const relevant =
    !status.available ||
    !status.online ||
    waiting > 0 ||
    status.queue.needsManager > 0 ||
    !limits.allowed ||
    Boolean(status.lastSyncError);
  if (!relevant) return null;
  return (
    <section
      className={`offline-status${status.online ? '' : ' offline'}`}
      aria-labelledby="offline-status-title"
    >
      {status.online && status.available ? (
        <CloudCheck size={20} aria-hidden="true" />
      ) : (
        <CloudOff size={20} aria-hidden="true" />
      )}
      <div>
        <h2 id="offline-status-title">
          {!status.available
            ? 'Offline billing unavailable'
            : status.online
              ? 'Offline sales waiting'
              : 'Working offline'}
        </h2>
        {status.unavailableReason && <p>{status.unavailableReason}</p>}
        {status.available && !status.online && (
          <p>
            {status.operator ? status.operator.message : 'Sign in online on this device first.'}
          </p>
        )}
        {status.available && (!status.online || !limits.allowed) && (
          <p role="status" className={limits.allowed ? '' : 'offline-limit-blocked'}>
            {limits.message}
          </p>
        )}
        <p className="offline-queue">
          Waiting {waiting} · Needs manager {status.queue.needsManager} · Synced{' '}
          {status.queue.synced} · Catalogue {status.catalog.products} products
          {status.catalog.refreshedAt
            ? ` (updated ${new Date(status.catalog.refreshedAt).toLocaleString()})`
            : ''}
        </p>
        {status.lastSyncError && <p className="offline-limit-blocked">{status.lastSyncError}</p>}
      </div>
    </section>
  );
}

function SaleComposer({
  client,
  storeId,
  counters,
  busy,
  onCompleted,
  onError,
}: {
  client: OfflineBillingClient;
  storeId: string;
  counters: { id: string; name: string }[];
  busy: boolean;
  onCompleted: (receipt: OfflineReceipt) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<CatalogProduct[]>([]),
    [lines, setLines] = useState<CartLine[]>([]),
    [mode, setMode] = useState<TenderMode>('cash'),
    [received, setReceived] = useState(''),
    [reference, setReference] = useState(''),
    [salespeople, setSalespeople] = useState<{ id: string; name: string }[]>([]),
    [salespersonId, setSalespersonId] = useState(''),
    [chosenCounter, setCounterId] = useState(counters[0]?.id ?? ''),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    client
      .call('offline:salespeople:list', { storeId })
      .then((result) => {
        if (active) setSalespeople(result.salespeople);
      })
      .catch((e: unknown) => onError(message(e)));
    return () => {
      active = false;
    };
  }, [client, storeId, onError]);
  const saleId = useRef<string>(crypto.randomUUID());
  const totals = useMemo(
    () =>
      saleTotals(
        lines.map((line) => ({
          unitPricePaise: line.product.unitPricePaise,
          quantity: line.quantity,
        })),
      ),
    [lines],
  );
  function add(product: CatalogProduct) {
    setLines((current) => {
      const found = current.find((line) => line.product.productId === product.productId);
      if (found)
        return current.map((line) =>
          line === found ? { ...line, quantity: Math.min(999, line.quantity + 1) } : line,
        );
      return [...current, { product, quantity: 1 }];
    });
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    try {
      if (/^[A-Za-z0-9-]{6,64}$/.test(text)) {
        const { product } = await client.call('offline:catalog:barcode', {
          storeId,
          barcode: text,
        });
        if (product) {
          add(product);
          setQuery('');
          setResults([]);
          return;
        }
      }
      setResults(
        (await client.call('offline:catalog:search', { storeId, query: text, limit: 20 })).products,
      );
    } catch (e) {
      onError(message(e));
    }
  }
  const counterId = counters.some((counter) => counter.id === chosenCounter)
    ? chosenCounter
    : (counters[0]?.id ?? '');
  async function complete() {
    if (!salespeople.some((person) => person.id === salespersonId)) {
      onError('Please Select The Salesperson.');
      return;
    }
    let tender: Tender;
    if (mode === 'cash') {
      const paid = parseMoney(received || formatMoney(totals.payablePaise));
      if (paid === null || paid < totals.payablePaise) {
        onError('Enter the cash received. It must cover the payable amount.');
        return;
      }
      tender = { mode: 'cash', receivedPaise: paid };
    } else {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{3,99}$/.test(reference.trim())) {
        onError('Enter the card or UPI reference shown on the terminal slip.');
        return;
      }
      tender = { mode, reference: reference.trim() };
    }
    setSaving(true);
    try {
      const result = await client.call('offline:sale:create', {
        saleId: saleId.current,
        storeId,
        counterId,
        lines: lines.map((line) => ({
          productId: line.product.productId,
          quantity: line.quantity,
        })),
        salespersonId,
        tender,
      });
      saleId.current = crypto.randomUUID();
      setLines([]);
      setReceived('');
      setReference('');
      setResults([]);
      onCompleted(result.receipt);
    } catch (e) {
      onError(message(e));
    } finally {
      setSaving(false);
    }
  }
  const change =
    mode === 'cash' && parseMoney(received) !== null
      ? Math.max(0, (parseMoney(received) ?? 0) - totals.payablePaise)
      : 0;
  return (
    <section className="surface offline-composer">
      <div className="surface-title">
        <h2>New offline sale</h2>
        <span className="badge amber">No coupons, wallet, points or cashback offline</span>
      </div>
      <form className="offline-search" onSubmit={(event) => void search(event)}>
        <input
          aria-label="Scan a barcode or search products"
          placeholder="Scan a barcode or search products"
          value={query}
          maxLength={100}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
        <button className="button secondary" type="submit">
          Find
        </button>
      </form>
      {results.length > 0 && (
        <ul className="offline-results">
          {results.map((product) => (
            <li key={product.productId}>
              <span>
                {product.name}
                <small>
                  {rupees(product.unitPricePaise)} · {product.stock} in stock
                </small>
              </span>
              <button
                className="button secondary"
                disabled={product.stock < 1}
                onClick={() => add(product)}
              >
                <Plus size={15} />
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {lines.length > 0 && (
        <table className="offline-lines">
          <tbody>
            {lines.map((line) => (
              <tr key={line.product.productId}>
                <td>{line.product.name}</td>
                <td>{rupees(line.product.unitPricePaise)}</td>
                <td className="offline-quantity">
                  <button
                    className="icon-button"
                    aria-label={`Decrease ${line.product.name}`}
                    onClick={() =>
                      setLines((current) =>
                        current
                          .map((item) =>
                            item === line ? { ...item, quantity: item.quantity - 1 } : item,
                          )
                          .filter((item) => item.quantity > 0),
                      )
                    }
                  >
                    <Minus size={14} />
                  </button>
                  <span>{line.quantity}</span>
                  <button
                    className="icon-button"
                    aria-label={`Increase ${line.product.name}`}
                    disabled={line.quantity >= Math.min(999, line.product.stock)}
                    onClick={() => add(line.product)}
                  >
                    <Plus size={14} />
                  </button>
                </td>
                <td>{rupees(line.product.unitPricePaise * line.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <label className="offline-field">
        Counter
        <select value={counterId} onChange={(event) => setCounterId(event.target.value)}>
          {counters.map((counter) => (
            <option key={counter.id} value={counter.id}>
              {counter.name}
            </option>
          ))}
        </select>
      </label>
      <label className="offline-field">
        Salesperson
        <select value={salespersonId} onChange={(event) => setSalespersonId(event.target.value)}>
          <option value="">Not Selected</option>
          {salespeople.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </label>
      <div className="offline-totals">
        <span>Subtotal {rupees(totals.grossPaise)}</span>
        <span>Rounding −{rupees(totals.roundingPaise)}</span>
        <strong>Payable {rupees(totals.payablePaise)}</strong>
      </div>
      <div className="offline-tender" role="radiogroup" aria-label="Payment method">
        {(
          [
            ['cash', 'Cash', Banknote],
            ['card', 'Card', CreditCard],
            ['upi', 'UPI', Smartphone],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={`button ${mode === value ? 'primary' : 'secondary'}`}
            onClick={() => setMode(value)}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {mode === 'cash' ? (
        <label className="offline-field">
          Cash received
          <input
            inputMode="decimal"
            placeholder={formatMoney(totals.payablePaise)}
            value={received}
            onChange={(event) => setReceived(event.target.value)}
          />
          {change > 0 && <small>Change {rupees(change)}</small>}
        </label>
      ) : (
        <label className="offline-field">
          {mode === 'card' ? 'Card' : 'UPI'} reference from the standalone terminal
          <input
            value={reference}
            maxLength={100}
            onChange={(event) => setReference(event.target.value)}
          />
        </label>
      )}
      <button
        className="button primary full"
        disabled={busy || saving || !lines.length || totals.payablePaise <= 0}
        aria-busy={saving}
        onClick={() => void complete()}
      >
        {saving ? 'Saving…' : 'Complete offline sale'}
      </button>
    </section>
  );
}

function ReceiptDialog({ receipt, onClose }: { receipt: OfflineReceipt; onClose: () => void }) {
  return (
    <Modal
      size="sm"
      className="offline-receipt"
      title={receipt.heading}
      closeLabel="Close receipt"
      onClose={onClose}
      footer={
        <button className="button primary" onClick={() => window.print()}>
          <Printer size={16} aria-hidden="true" />
          Print receipt
        </button>
      }
    >
      <p className="offline-receipt-brand">The Souled Store</p>
      <p className="offline-provisional">{receipt.provisionalNotice}</p>
      <p>
        {receipt.storeName ?? `Store ${receipt.storeId}`} ·{' '}
        {receipt.counterName ?? `Counter ${receipt.counterId}`}
      </p>
      <p className="mono">{receipt.provisionalRef}</p>
      <p>{new Date(receipt.createdAt).toLocaleString()}</p>
      <div>
        {receipt.lines.map((line) => (
          <div className="receipt-line" key={line.productId}>
            <span>
              {line.name} × {line.quantity}
            </span>
            <span>{rupees(line.unitPricePaise * line.quantity)}</span>
          </div>
        ))}
        <div className="receipt-line">
          <span>Rounding</span>
          <span>−{rupees(receipt.roundingPaise)}</span>
        </div>
        <div className="receipt-line grand-total">
          <strong>Total</strong>
          <strong>{rupees(receipt.payablePaise)}</strong>
        </div>
      </div>
      {receipt.tender.mode === 'cash' ? (
        <p>
          Cash {rupees(receipt.tender.receivedPaise)} · Change {rupees(receipt.tender.changePaise)}
        </p>
      ) : (
        <p>
          {receipt.tender.mode.toUpperCase()} reference {receipt.tender.reference}
        </p>
      )}
    </Modal>
  );
}

function ResolveDialog({
  sale,
  onClose,
  onResolve,
}: {
  sale: OfflineSale;
  onClose: () => void;
  onResolve: (input: {
    action: ResolutionAction;
    reason: string;
    tender?: Tender;
    orderId?: string;
  }) => Promise<void>;
}) {
  const unknown = sale.conflict?.code === 'OUTCOME_UNKNOWN';
  const [action, setAction] = useState<ResolutionAction>(unknown ? 'link-order' : 'correct-tender'),
    [orderId, setOrderId] = useState(''),
    [reason, setReason] = useState(''),
    [mode, setMode] = useState<TenderMode>(sale.tender.mode),
    [value, setValue] = useState(''),
    [error, setError] = useState('');
  function submit() {
    const trimmed = reason.trim();
    if (trimmed.length < 5) {
      setError('Enter a reason of at least five characters.');
      return;
    }
    if (action === 'link-order' && !/^[1-9]\d{0,19}$/.test(orderId.trim())) {
      setError('Enter the order ID you found in Orders for this sale.');
      return;
    }
    let tender: Tender | undefined;
    if (action === 'correct-tender') {
      if (mode === 'cash') {
        const paid = parseMoney(value || formatMoney(sale.payablePaise));
        if (paid === null || paid < sale.payablePaise) {
          setError('Cash received must cover the payable amount.');
          return;
        }
        tender = { mode: 'cash', receivedPaise: paid };
      } else {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{3,99}$/.test(value.trim())) {
          setError('Enter the corrected terminal reference.');
          return;
        }
        tender = { mode, reference: value.trim() };
      }
    }
    void onResolve({
      action,
      reason: trimmed,
      ...(tender ? { tender } : {}),
      ...(action === 'link-order' ? { orderId: orderId.trim() } : {}),
    });
  }
  return (
    <Modal
      size="sm"
      title={sale.provisionalRef}
      description={
        sale.conflict?.message ?? 'This sale needs a manager decision before it can sync.'
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit}>
            Save decision
          </button>
        </>
      }
    >
      {error && (
        <div role="alert" className="inline-error">
          {error}
        </div>
      )}
      <label className="offline-field">
        Decision
        <select
          value={action}
          onChange={(event) => setAction(event.target.value as ResolutionAction)}
        >
          {unknown ? (
            <>
              <option value="link-order">The order exists in Orders — link it</option>
              <option value="recreate">Orders has no order for this sale — create it</option>
            </>
          ) : (
            <>
              <option value="correct-tender">Correct the tender</option>
              <option value="accept">Accept the store’s current price/stock and sync</option>
            </>
          )}
          <option value="void">Void this sale (goods returned)</option>
        </select>
      </label>
      {action === 'link-order' && (
        <label className="offline-field">
          Order ID from Orders
          <input
            inputMode="numeric"
            value={orderId}
            maxLength={20}
            onChange={(event) => setOrderId(event.target.value)}
          />
        </label>
      )}
      {action === 'correct-tender' && (
        <>
          <label className="offline-field">
            Tender
            <select value={mode} onChange={(event) => setMode(event.target.value as TenderMode)}>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="upi">UPI</option>
            </select>
          </label>
          <label className="offline-field">
            {mode === 'cash' ? 'Cash received' : 'Terminal reference'}
            <input
              value={value}
              maxLength={100}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        </>
      )}
      <label className="offline-field">
        Reason
        <input value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
      </label>
    </Modal>
  );
}
