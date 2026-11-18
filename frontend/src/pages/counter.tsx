import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CloudUpload,
  Minus,
  Plus,
  ScanBarcode,
  Search,
  ShoppingBag,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { Principal, Product } from '../api/types';
import { db, type LocalDraft, type Operation } from '../offline/database';
import { queueDraft } from '../offline/sync';
import { useLocalDrafts, useProducts } from '../hooks/use-pos';
import { useWorkspace } from '../state/workspace';
import { currency, total } from '../lib/format';
import { Empty, ErrorState, Loading, PageTitle } from '../components/common';
import {
  CheckoutReview,
  InvoiceActions,
  clearRecovery,
  type ConfirmedPayment,
  type CheckoutClearance,
} from './checkout';
import { completeSale } from '../offline/complete-sale';
import { prepareReview } from '../offline/review-snapshot';
import { recoveryFor } from './checkout/client';
import { clearReviewedDraft } from '../offline/clear-reviewed-draft';
import { CashTools } from './checkout/offline-cash/cash-tools';
import type { LocalCashReceipt } from '../offline/cash/storage-types';
import { recordPerformancePhase } from '../offline/performance/storage';
import { captureOperatorScope } from '../api/client';
import { addProduct, commitScannedProduct, resolveBarcode } from './counter-catalog/barcode';
import './counter-catalog/style.css';
import { DraftQuantity, commitDraftQuantity } from './counter-catalog/quantity';
import { productDetailPath, useCartProductLinks } from './counter-catalog/detail-links';
import {
  AutomaticInvoicePreview,
  createAutomaticInvoiceRequest,
  type AutomaticInvoiceRequest,
} from './invoice-documents';
import { CashierShortcutHelp } from './cashier-shortcuts/help';
import { useCashierShortcutPreference } from './cashier-shortcuts/preference';
import { MotivationalQuote } from '../components/motivational-quote';
import { clearOrderCopyOrigin, orderCopyRequiresOnlineReview } from './order-copy';
import {
  bindCashierShortcuts,
  cashierShortcutScope,
  invokeCashierShortcut,
  type CashierShortcut,
  type CashierShortcutRequest,
} from './cashier-shortcuts/shortcuts';

const tones = ['peach', 'sage', 'blue', 'sand', 'rose', 'lilac'];
export function ProductTile({
  product,
  index,
  onAdd,
  troubleshooting = false,
}: {
  product: Product;
  index: number;
  onAdd: () => void;
  troubleshooting?: boolean;
}) {
  return (
    <article className="counter-product-card">
      <button
        className="product-tile"
        onClick={onAdd}
        disabled={product.stock <= 0}
        aria-label={`Add ${product.name} to sale`}
      >
        <div className={`product-art ${tones[index % tones.length]}`}>
          {product.image ? (
            <img loading="lazy" src={product.image} alt="" />
          ) : (
            <ShoppingBag size={54} strokeWidth={1} />
          )}
          <span className={`stock-label ${product.stock < 5 ? 'stock-low' : ''}`}>
            {product.stock === 0
              ? 'Out of stock'
              : product.stock < 5
                ? `Only ${product.stock} left`
                : `${product.stock} in stock`}
          </span>
          <span className="add-product">
            <Plus size={17} />
          </span>
        </div>
        <div className="product-copy">
          <small>{product.erpName || `SKU ${product.id}`}</small>
          <h3>{product.name}</h3>
          <div>
            <strong>{currency(product.price)}</strong>
            <span>GST {product.gst}%</span>
          </div>
        </div>
      </button>
      <nav className="counter-product-actions" aria-label={`Actions for ${product.name}`}>
        <a
          href={productDetailPath(product)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View details for ${product.name}`}
        >
          Product details
        </a>
        {troubleshooting && product.stock > 0 && product.barcode !== null && (
          <a
            href={`/catalog/products/${product.id}#product-troubleshooting`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Troubleshoot ${product.name}`}
          >
            Troubleshoot product
          </a>
        )}
      </nav>
    </article>
  );
}
export function CounterPage({
  user,
  operations,
  online,
  sync,
}: {
  user: Principal;
  operations: Operation[];
  online: boolean;
  sync: () => Promise<void>;
}) {
  const { storeId, counterId } = useWorkspace();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [includeOutOfStock, setIncludeOutOfStock] = useState(false);
  const deferred = useDeferredValue(search);
  const drafts = useLocalDrafts(user.id, storeId).filter((c) => c.counterId === counterId);
  const [activeId, setActive] = useState(''),
    [message, setMessage] = useState(''),
    [problem, setProblem] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [review, setReview] = useState<LocalDraft | null>(null);
  const [reviewOpening, setReviewOpening] = useState(false);
  const [cashOpen, setCashOpen] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState<string>();
  const [lastPaid, setLastPaid] = useState<{ storeId: string; orderId: string } | null>(null);
  const [automaticInvoice, setAutomaticInvoice] = useState<AutomaticInvoiceRequest | null>(null);
  const [shortcutsEnabled, setShortcutsEnabled] = useCashierShortcutPreference(user.id);
  const [shortcutRequest, setShortcutRequest] = useState<CashierShortcutRequest>();
  const [, refreshCopyOrigin] = useState(0);
  useEffect(() => {
    const refresh = () => refreshCopyOrigin((value) => value + 1);
    window.addEventListener('storage', refresh);
    window.addEventListener('pos-order-copy-marker-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('pos-order-copy-marker-changed', refresh);
    };
  }, []);
  const shortcutRoot = useRef<HTMLDivElement>(null),
    openingReview = useRef(false),
    shortcutAction = useRef<(action: CashierShortcut) => boolean>(() => false);
  const cart = drafts.find((c) => c.id === activeId) || drafts[0];
  const cartProductLinks = useCartProductLinks(
    user.id,
    storeId,
    cart?.lines.map((line) => line.productId) || [],
  );
  const recoveredCheckoutId = cart ? recoveryFor(user.id, cart.id)?.checkoutId : undefined;
  const copiedOriginNeedsOnline = Boolean(
    recoveredCheckoutId && orderCopyRequiresOnlineReview(user.id, storeId, recoveredCheckoutId),
  );
  const draftId =
    cart?.ownerId === user.id && cart.storeId === storeId && cart.counterId === counterId
      ? cart.id
      : undefined;
  const activeDraftId = useRef(activeId),
    workspaceScope = useRef(''),
    timingDraftId = useRef(draftId),
    timingAlive = useRef(true),
    measuredProductRead = useRef('');
  activeDraftId.current = activeId;
  workspaceScope.current = `${user.id}:${storeId}:${counterId}`;
  timingDraftId.current = draftId;
  const productTimingKey = JSON.stringify([
      user.id,
      storeId,
      counterId,
      draftId,
      deferred,
      includeOutOfStock,
    ]),
    currentProductTimingKey = useRef(productTimingKey);
  currentProductTimingKey.current = productTimingKey;
  useEffect(() => {
    const root = shortcutRoot.current;
    if (!root || !shortcutsEnabled) return;
    return bindCashierShortcuts(root, (action) => shortcutAction.current(action));
  }, [shortcutsEnabled, user.id, storeId, counterId, draftId]);
  useEffect(() => {
    timingAlive.current = true;
    return () => {
      timingAlive.current = false;
    };
  }, []);
  const recordProductRead = useCallback(
    (milliseconds: number) => {
      if (!draftId || !timingAlive.current || currentProductTimingKey.current !== productTimingKey)
        return;
      measuredProductRead.current = productTimingKey;
      void recordPerformancePhase(
        { ownerId: user.id, storeId, counterId, draftId },
        'product_main_list',
        milliseconds,
      ).catch(() => {});
    },
    [user.id, storeId, counterId, draftId, productTimingKey],
  );
  const products = useProducts(user.id, storeId, deferred, includeOutOfStock, recordProductRead);
  useEffect(() => {
    if (
      !draftId ||
      products.isFetching ||
      products.isError ||
      !products.data ||
      measuredProductRead.current === productTimingKey
    )
      return;
    // A fresh draft can reuse the query cache without another HTTP request.
    // Measure that read itself, never an earlier draft's network duration.
    const startedAt = performance.now(),
      cached = client.getQueryData([user.id, 'products', storeId, deferred, includeOutOfStock]);
    if (cached) recordProductRead(performance.now() - startedAt);
  }, [
    client,
    user.id,
    storeId,
    deferred,
    includeOutOfStock,
    draftId,
    productTimingKey,
    products.data,
    products.isFetching,
    products.isError,
    recordProductRead,
  ]);
  const create = async () => {
    if (!storeId || !counterId) return;
    const scope = `${user.id}:${storeId}:${counterId}`,
      signal = captureOperatorScope(user.id);
    signal.throwIfAborted();
    const now = Date.now();
    const value: LocalDraft = {
      id: crypto.randomUUID(),
      ownerId: user.id,
      storeId,
      counterId,
      customerId: null,
      lines: [],
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    await db.drafts.put(value);
    if (!signal.aborted && workspaceScope.current === scope) setActive(value.id);
  };
  useEffect(() => {
    if (!counterId || !storeId) return;
    let alive = true;
    void db
      .transaction('rw', db.drafts, async () => {
        const existing = await db.drafts
          .where('[ownerId+storeId]')
          .equals([user.id, storeId])
          .filter((c) => c.counterId === counterId)
          .first();
        if (existing) {
          if (alive) setActive(existing.id);
          return;
        }
        const now = Date.now(),
          id = crypto.randomUUID();
        await db.drafts.put({
          id,
          ownerId: user.id,
          storeId,
          counterId,
          customerId: null,
          lines: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
        });
        if (alive) setActive(id);
      })
      .catch(setProblem);
    return () => {
      alive = false;
    };
  }, [user.id, storeId, counterId]);
  async function update(change: (draft: LocalDraft) => LocalDraft, measureAdd = false) {
    if (!cart) return;
    const startedAt = performance.now(),
      owner = { ownerId: user.id, storeId, counterId, draftId: cart.id };
    try {
      let updated = false;
      await db.transaction('rw', db.drafts, async () => {
        const latest = await db.drafts.get([user.id, cart.id]);
        if (latest) {
          await db.drafts.put({ ...change(latest), updatedAt: Date.now() });
          updated =
            latest.ownerId === owner.ownerId &&
            latest.storeId === owner.storeId &&
            latest.counterId === owner.counterId &&
            latest.id === owner.draftId;
        }
      });
      const milliseconds = performance.now() - startedAt;
      if (
        measureAdd &&
        updated &&
        draftId === owner.draftId &&
        timingAlive.current &&
        timingDraftId.current === owner.draftId &&
        workspaceScope.current === `${owner.ownerId}:${owner.storeId}:${owner.counterId}`
      )
        void recordPerformancePhase(owner, 'add_to_cart', milliseconds).catch(() => {});
      setProblem(null);
      setMessage('');
    } catch (e) {
      setProblem(e);
    }
  }
  const add = (product: Product) => void update((draft) => addProduct(draft, product), true);
  const scanIdentity = JSON.stringify([user.id, storeId, counterId, draftId]);
  const currentScanIdentity = useRef(scanIdentity);
  currentScanIdentity.current = scanIdentity;
  const scanController = useRef<AbortController | null>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    setScanning(false);
    return () => {
      scanController.current?.abort();
      scanController.current = null;
    };
  }, [scanIdentity]);
  async function scanBarcode(input: string) {
    if (scanController.current || !draftId || !storeId || !counterId) return;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    const identity = scanIdentity;
    const isCurrent = () => currentScanIdentity.current === identity && !controller.signal.aborted;
    try {
      const signal = AbortSignal.any([
        controller.signal,
        captureOperatorScope(user.id),
        AbortSignal.timeout(12000),
      ]);
      const startedAt = performance.now();
      const product = await resolveBarcode(user.id, storeId, input, signal);
      const scope = { ownerId: user.id, storeId, counterId, draftId };
      await commitScannedProduct(scope, product, signal, isCurrent, input);
      if (!isCurrent()) return;
      void recordPerformancePhase(scope, 'add_to_cart', performance.now() - startedAt).catch(
        () => {},
      );
      setSearch('');
      setProblem(null);
      setMessage('');
    } catch (error) {
      if (isCurrent()) setProblem(error);
    } finally {
      if (scanController.current === controller) {
        scanController.current = null;
        setScanning(false);
      }
    }
  }
  async function save() {
    if (!cart) return;
    setBusy(true);
    try {
      await queueDraft(cart);
      setMessage(
        online
          ? 'Sale queued for sync.'
          : 'Sale saved on this device. It will sync when you reconnect.',
      );
      setProblem(null);
      if (online) await sync();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  }
  async function paymentConfirmed(snapshot: LocalDraft, receipt: ConfirmedPayment) {
    const completedScope = `${snapshot.ownerId}:${snapshot.storeId}:${snapshot.counterId}`;
    if (snapshot.ownerId !== user.id || workspaceScope.current !== completedScope) return;
    const signal = captureOperatorScope(snapshot.ownerId);
    try {
      signal.throwIfAborted();
      const result = await completeSale(snapshot, receipt);
      if (signal.aborted || workspaceScope.current !== completedScope) return;
      const copiedCheckoutId = recoveryFor(snapshot.ownerId, snapshot.id)?.checkoutId;
      if (copiedCheckoutId)
        clearOrderCopyOrigin(snapshot.ownerId, snapshot.storeId, copiedCheckoutId);
      clearRecovery(snapshot.ownerId, snapshot.id);
      setReview((current) => (current?.id === snapshot.id ? null : current));
      const currentDraft = !activeDraftId.current || activeDraftId.current === snapshot.id;
      if (currentDraft) {
        setActive(result.preservedDraftId || '');
        if (!result.alreadyCompleted && !result.preservedDraftId) await create();
        if (signal.aborted || workspaceScope.current !== completedScope) return;
        setLastPaid({ storeId: snapshot.storeId, orderId: receipt.orderId });
        setMessage(
          result.preservedDraftId
            ? 'Payment confirmed. Changes made in another window are kept in a new sale.'
            : 'Payment confirmed. Your sale is complete.',
        );
        if (!result.alreadyCompleted) {
          try {
            setAutomaticInvoice(createAutomaticInvoiceRequest(user, snapshot.storeId, receipt));
          } catch {
            setAutomaticInvoice(null);
          }
        }
      }
      await client.invalidateQueries({ queryKey: [user.id, 'orders'] });
      await client.invalidateQueries({ queryKey: [user.id, 'products', snapshot.storeId] });
    } catch (error) {
      if (!signal.aborted && workspaceScope.current === completedScope) setProblem(error);
    }
  }
  async function checkoutCleared(snapshot: LocalDraft, clearance: CheckoutClearance) {
    try {
      const result = await clearReviewedDraft(snapshot, clearance);
      clearOrderCopyOrigin(snapshot.ownerId, snapshot.storeId, clearance.checkoutId);
      clearRecovery(snapshot.ownerId, snapshot.id);
      setReview((current) => (current?.id === snapshot.id ? null : current));
      if (
        workspaceScope.current ===
          `${snapshot.ownerId}:${snapshot.storeId}:${snapshot.counterId}` &&
        (!activeDraftId.current || activeDraftId.current === snapshot.id)
      ) {
        setActive((current) =>
          !current || current === snapshot.id ? result.replacementDraftId : current,
        );
        setMessage(
          result.preservedDraftId
            ? 'Checkout cleared. Changes made in another window are kept in a new sale.'
            : 'Checkout cleared. Ready for a new sale.',
        );
        setProblem(null);
      }
    } catch (error) {
      setProblem(error);
      throw error;
    }
  }
  async function openReview(action?: CashierShortcut) {
    if (!cart || openingReview.current || reviewOpening || cashOpen) return;
    const scope = `${cart.ownerId}:${cart.storeId}:${cart.counterId}`,
      signal = captureOperatorScope(cart.ownerId);
    if (scope !== workspaceScope.current) return;
    if (signal.aborted) return;
    openingReview.current = true;
    setReviewOpening(true);
    try {
      const result = await prepareReview(cart, recoveryFor(user.id, cart.id));
      if (signal.aborted || workspaceScope.current !== scope) return;
      setRecoveryNotice(
        result.changed
          ? 'You are resuming the original checkout. Newer changes to this local cart will be kept as another sale after payment.'
          : undefined,
      );
      setReview(result.snapshot);
      setShortcutRequest(
        action ? { id: crypto.randomUUID(), action, requestedAt: Date.now() } : undefined,
      );
      setProblem(null);
    } catch (error) {
      setProblem(error);
    } finally {
      openingReview.current = false;
      setReviewOpening(false);
    }
  }
  function cashCompleted(snapshot: LocalDraft, receipt: LocalCashReceipt) {
    clearRecovery(snapshot.ownerId, snapshot.id);
    setReview((current) => (current?.id === snapshot.id ? null : current));
    if (
      workspaceScope.current !== `${snapshot.ownerId}:${snapshot.storeId}:${snapshot.counterId}` ||
      (activeDraftId.current && activeDraftId.current !== snapshot.id)
    )
      return;
    setActive((current) =>
      !current || current === snapshot.id ? receipt.replacementDraftId : current,
    );
    setLastPaid(null);
    setAutomaticInvoice(null);
    setProblem(null);
    setMessage(
      receipt.preservedDraftId
        ? 'Cash received. Later changes are kept in a new sale; your cash receipt is saved.'
        : 'Cash received. Your cash receipt is saved on this device.',
    );
  }
  const pending = operations.find((o) => o.draftId === cart?.id);
  const allProducts = products.data?.pages.flatMap((p) => p.data) || [];
  const cached = products.data?.pages.some((p) => p.cached);
  shortcutAction.current = (action) => {
    const root = shortcutRoot.current,
      scope = root && cashierShortcutScope(root);
    if (!root || !scope || cashOpen || automaticInvoice) return false;
    if (review) {
      if (invokeCashierShortcut(scope, action)) return true;
      if (action === 'fast-cash' && online) {
        setShortcutRequest({ id: crypto.randomUUID(), action, requestedAt: Date.now() });
        return true;
      }
      return false;
    }
    if (openingReview.current || busy) return false;
    if (action === 'barcode' || action === 'new-sale') return invokeCashierShortcut(root, action);
    if (action === 'refresh') {
      void products.refetch();
      return true;
    }
    if (!cart?.lines.length) return false;
    void openReview(action).catch(setProblem);
    return true;
  };
  return (
    <div ref={shortcutRoot} className="counter-workspace">
      <PageTitle eyebrow="YOUR STORE, IN FLOW" title="The counter">
        <CashierShortcutHelp enabled={shortcutsEnabled} onChange={setShortcutsEnabled} />
        <div className="date-label">
          {new Intl.DateTimeFormat('en-IN', {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
          }).format(new Date())}
          <span>Let’s make it a good one.</span>
        </div>
      </PageTitle>
      {lastPaid && (
        <section className="surface paid-sale" role="status">
          <strong>Order {lastPaid.orderId} · Payment confirmed</strong>
          <InvoiceActions ownerId={user.id} storeId={lastPaid.storeId} orderId={lastPaid.orderId} />
        </section>
      )}
      <div className="counter-layout">
        <section className="catalog-panel">
          <div className="panel-toolbar">
            <div className="search">
              <Search size={18} />
              <input
                data-cashier-action="barcode"
                aria-keyshortcuts="B"
                aria-label="Search products or scan a barcode"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products or scan a barcode"
                disabled={scanning}
                aria-busy={scanning}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (e.repeat || scanController.current) return;
                  const entered = e.currentTarget.value;
                  if (/^[\d_]+$/.test(entered.trim())) {
                    void scanBarcode(entered);
                  } else if (
                    entered === deferred &&
                    !products.isFetching &&
                    !products.isError &&
                    allProducts.length === 1
                  ) {
                    add(allProducts[0]!);
                    setSearch('');
                  }
                }}
              />
              <ScanBarcode size={20} />
              <kbd>↵</kbd>
            </div>
          </div>
          <div className="catalog-heading">
            <div>
              <span className="pill active">Store catalog</span>
              <label className="caption">
                <input
                  type="checkbox"
                  checked={includeOutOfStock}
                  onChange={(event) => setIncludeOutOfStock(event.target.checked)}
                />{' '}
                Show out of stock
              </label>
              <span className="muted">{allProducts.length} loaded</span>
            </div>
            <span className="caption">
              {cached
                ? 'Cached catalog · confirm prices at checkout'
                : 'Choose a product to start a sale'}
            </span>
          </div>
          {products.isPending ? (
            <Loading />
          ) : products.isError ? (
            <ErrorState error={products.error} retry={() => void products.refetch()} />
          ) : allProducts.length === 0 ? (
            <Empty title="No products found">Try another product name or barcode.</Empty>
          ) : (
            <div className="product-grid">
              {allProducts.map((p, i) => (
                <ProductTile
                  key={p.id}
                  product={p}
                  index={i}
                  onAdd={() => add(p)}
                  troubleshooting={user.role === 1 && user.userType === 1}
                />
              ))}
            </div>
          )}
          {products.hasNextPage && (
            <button
              className="button secondary load-more"
              disabled={products.isFetchingNextPage}
              onClick={() => void products.fetchNextPage()}
            >
              Load more products
            </button>
          )}
          <div className="catalog-footer">
            <ScanBarcode size={15} />
            <span>Barcode scanners work in the search field.</span>
            <span>Prices confirmed at checkout</span>
          </div>
          <MotivationalQuote user={user} online={online} />
        </section>
        <aside className="sale-panel" data-cart-id={cart?.id}>
          <div className="sale-tabs">
            {drafts.map((d, i) => (
              <button
                key={d.id}
                onClick={() => setActive(d.id)}
                className={cart?.id === d.id ? 'selected' : ''}
              >
                Sale {String(i + 1).padStart(2, '0')}
                {d.lines.length > 0 && <span>{d.lines.reduce((n, l) => n + l.quantity, 0)}</span>}
              </button>
            ))}
            <button
              className="new-tab"
              aria-label="New sale"
              aria-keyshortcuts="T"
              data-cashier-action="new-sale"
              onClick={() => void create().catch(setProblem)}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="sale-top">
            <div>
              <div className="eyebrow">CURRENT SALE</div>
              <h2>A little retail therapy.</h2>
            </div>
            <ShoppingBag size={23} />
          </div>
          <div className="customer-row">
            <span className="customer-avatar">
              <UserRound size={18} />
            </span>
            <div>
              <strong>Walk-in customer</strong>
              <small>No customer attached</small>
            </div>
          </div>
          <div className="cart-lines">
            {!cart?.lines.length ? (
              <Empty title="A fresh start">Add a product from the catalog to begin.</Empty>
            ) : (
              cart.lines.map((line) => (
                <div className="cart-line" key={line.productId}>
                  <div className="line-art">
                    <ShoppingBag size={22} />
                  </div>
                  <div className="line-copy">
                    <strong>
                      <a
                        href={
                          cartProductLinks?.get(line.productId) ||
                          `/catalog/products/${line.productId}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {line.name}
                      </a>
                    </strong>
                    <small>{line.barcode || `SKU ${line.productId}`}</small>
                    <div className="quantity">
                      <button
                        aria-label={`Decrease ${line.name}`}
                        onClick={() =>
                          void update((d) => ({
                            ...d,
                            lines: d.lines
                              .map((l) =>
                                l.productId === line.productId
                                  ? { ...l, quantity: l.quantity - 1 }
                                  : l,
                              )
                              .filter((l) => l.quantity > 0),
                          }))
                        }
                      >
                        <Minus size={13} />
                      </button>
                      <DraftQuantity
                        key={scanIdentity + ':' + line.productId}
                        name={line.name}
                        quantity={line.quantity}
                        onCommit={async (quantity) => {
                          if (!draftId) return;
                          const identity = scanIdentity;
                          await commitDraftQuantity(
                            { ownerId: user.id, storeId, counterId, draftId },
                            line.productId,
                            quantity,
                            captureOperatorScope(user.id),
                            () => currentScanIdentity.current === identity,
                          );
                        }}
                      />
                      <button
                        aria-label={`Increase ${line.name}`}
                        disabled={line.quantity >= 999}
                        onClick={() =>
                          void update((d) => ({
                            ...d,
                            lines: d.lines.map((l) =>
                              l.productId === line.productId
                                ? { ...l, quantity: l.quantity + 1 }
                                : l,
                            ),
                          }))
                        }
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="line-end">
                    <strong>{currency(total([line]))}</strong>
                    <button
                      className="icon-button"
                      aria-label={`Remove ${line.name}`}
                      onClick={() =>
                        void update((d) => ({
                          ...d,
                          lines: d.lines.filter((l) => l.productId !== line.productId),
                        }))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="sale-bottom">
            {pending && (
              <div
                className={`sync-message ${pending.state === 'conflict' || pending.state === 'rejected' ? 'error-text' : ''}`}
              >
                <CloudUpload size={15} />
                {pending.state === 'conflict'
                  ? 'Cart changed elsewhere. Review sync conflict.'
                  : pending.state === 'rejected'
                    ? pending.message
                    : 'Saved locally · sync pending'}
              </div>
            )}
            {message && (
              <div role="status" className="sync-message">
                <Check size={15} />
                {message}
              </div>
            )}
            {problem !== null && (
              <div role="alert" className="inline-error">
                {problem instanceof Error ? problem.message : 'Could not save this sale.'}
              </div>
            )}
            <div className="subtotal">
              <span>Items</span>
              <span>{cart?.lines.reduce((n, l) => n + l.quantity, 0) || 0}</span>
            </div>
            <div className="grand-total">
              <span>Estimated total</span>
              <strong>{currency(total(cart?.lines || []))}</strong>
            </div>
            <p className="price-note">
              Review the final total before payment. Offline cash uses saved prices.
            </p>
            <button
              className="button primary full"
              disabled={!cart?.lines.length || reviewOpening || cashOpen}
              onClick={() => void openReview()}
            >
              Review sale
              <ArrowRight size={19} />
            </button>
            <button
              className="button secondary full"
              disabled={!cart?.lines.length || busy || !!pending}
              onClick={() => void save()}
            >
              <CloudUpload size={16} />
              {busy ? 'Saving…' : online ? 'Save sale' : 'Save on this device'}
            </button>
            <div className="safe-local">
              <span className="status-dot" /> Cart changes are saved on this device
            </div>
            <CashTools
              user={user}
              storeId={storeId}
              counterId={counterId}
              draft={cart}
              online={online}
              reviewBusy={Boolean(review) || reviewOpening}
              onlineReviewRequired={copiedOriginNeedsOnline}
              onOpenChange={setCashOpen}
              onCompleted={cashCompleted}
            />
          </div>
        </aside>
      </div>
      {review && (
        <CheckoutReview
          key={review.id}
          user={user}
          draft={review}
          online={online}
          recoveryNotice={recoveryNotice}
          shortcutRequest={shortcutRequest}
          onClose={() => setReview(null)}
          onPaymentConfirmed={(receipt) => void paymentConfirmed(review, receipt)}
          onCheckoutCleared={(clearance) => checkoutCleared(review, clearance)}
        />
      )}
      {automaticInvoice && (
        <AutomaticInvoicePreview
          key={automaticInvoice.id}
          user={user}
          request={automaticInvoice}
          online={online}
          onClose={() => setAutomaticInvoice(null)}
        />
      )}
    </div>
  );
}
