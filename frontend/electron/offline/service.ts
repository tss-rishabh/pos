import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIMITS,
  advanceWindow,
  evaluateLimits,
  resetWindow,
  type ClockSession,
} from '../../src/offline/billing/limits';
import { formatMoney, parseMoney, saleTotals } from '../../src/offline/billing/money';
import { deviceShortCode, provisionalReference } from '../../src/offline/billing/reference';
import {
  PROVISIONAL_NOTICE,
  conflictCodeSchema,
  type CatalogProduct,
  type IpcParsedRequest,
  type OfflineReceipt,
  type OfflineSale,
  type OfflineStatus,
} from '../../src/offline/billing/contracts';
import type { OfflineSaleUpload } from '../../src/offline/billing/sync-contract';
import type { CachedOperator, OfflineStore, QueueEntry } from './database';
import type { ServerApi } from './server';

/** Errors returned to the renderer: fixed code and a non-sensitive message. */
export class OfflineBillingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OfflineLogEvent {
  eventId: string;
  traceId: string;
  outcome: 'succeeded' | 'failed' | 'skipped';
  code?: string;
  count?: number;
  durationMs?: number;
}
export interface OfflineServiceDeps {
  store: OfflineStore;
  server: ServerApi;
  deviceId: string;
  now(): number;
  mono(): number;
  netOnline(): boolean;
  hasSessionCookie(): Promise<boolean>;
  log(event: OfflineLogEvent): void;
  changed(): void;
}

const MANAGER_ROLES = new Set([1, 2, 3, 4]);
const MAX_CATALOG_PAGES = 300;

export function isManager(operator: Pick<CachedOperator, 'role'>): boolean {
  return MANAGER_ROLES.has(operator.role);
}

export function offlineBillingService(deps: OfflineServiceDeps) {
  const { store, server } = deps;
  const deviceShort = deviceShortCode(deps.deviceId);
  let clock: ClockSession | null = null,
    reachable = false,
    syncing = false,
    lastSyncAt: number | null = null,
    lastSyncError: string | null = null,
    refreshing = false;
  store.recoverInterrupted();

  /** Persist monotonic elapsed time (called every minute and before decisions). */
  function tick() {
    const window = store.window();
    if (!window) return;
    const next = advanceWindow(window, { wallMs: deps.now(), monoMs: deps.mono() }, clock);
    clock = next.session;
    store.setWindow(next.state);
  }
  function limitStatus() {
    tick();
    return evaluateLimits(store.limits() ?? DEFAULT_LIMITS, store.window(), store.unsyncedCount());
  }
  /** A successful server contact restarts the window only once nothing is queued. */
  function recordContact() {
    const now = deps.now();
    store.setMeta('last_contact_at', String(now));
    if (store.unsyncedCount() === 0) {
      store.setWindow(resetWindow(now));
      clock = { lastMonoMs: deps.mono() };
    }
  }
  async function eligibility(storeId?: string, counterId?: string) {
    const operator = store.deviceOperator(),
      now = deps.now();
    const deny = (message: string) => ({ operator, eligible: false, message });
    if (!operator)
      return deny('Sign in and check in online on this device before billing offline.');
    if (operator.sessionExpiresAt <= now)
      return deny('Your session on this device has ended. Sign in online to continue.');
    if (!(await deps.hasSessionCookie()))
      return deny('You are signed out on this device. Sign in online to continue.');
    if (!operator.checkIn || !operator.checkIn.counterId || operator.checkIn.expiresAt <= now)
      return deny('Check in to a store counter online before billing offline.');
    if (
      (storeId && storeId !== operator.checkIn.storeId) ||
      (counterId && counterId !== operator.checkIn.counterId)
    )
      return deny('Offline billing is limited to the store counter you checked in to.');
    return { operator, eligible: true, message: 'Ready to bill offline.' };
  }
  function online() {
    return deps.netOnline() && reachable;
  }
  async function status(): Promise<OfflineStatus> {
    const limits = limitStatus(),
      access = await eligibility(),
      catalog = store.catalogInfo(),
      lastContact = store.getMeta('last_contact_at');
    return {
      available: true,
      unavailableReason: null,
      online: online(),
      lastContactAt: lastContact === null ? null : Number(lastContact),
      operator: access.operator
        ? {
            id: access.operator.id,
            name: access.operator.name,
            manager: isManager(access.operator),
            storeId: access.operator.checkIn?.storeId ?? null,
            counterId: access.operator.checkIn?.counterId ?? null,
            eligible: access.eligible,
            message: access.message,
          }
        : null,
      limits,
      catalog: {
        storeId: catalog?.storeId ?? null,
        products: catalog?.products ?? 0,
        refreshedAt: catalog?.refreshedAt ?? null,
      },
      queue: store.counts(),
      syncing,
      lastSyncAt,
      lastSyncError,
    };
  }
  function receipt(sale: OfflineSale): OfflineReceipt {
    return {
      ...sale,
      ...store.scopeNames(sale.storeId, sale.counterId),
      heading: sale.invoiceNumber
        ? `Invoice ${sale.invoiceNumber}`
        : `Provisional receipt ${sale.provisionalRef}`,
      provisionalNotice: sale.invoiceNumber
        ? `Provisional reference ${sale.provisionalRef}`
        : PROVISIONAL_NOTICE,
    };
  }
  function publicSale(entry: QueueEntry): OfflineSale {
    const { nextAttemptAt: _next, ...sale } = entry;
    return sale;
  }

  async function refreshCatalog(traceId: string): Promise<number> {
    const operator = store.deviceOperator();
    if (!operator?.checkIn)
      throw new OfflineBillingError('CHECK_IN_REQUIRED', 'Check in to a store first.');
    if (!online())
      throw new OfflineBillingError('OFFLINE', 'Connect to refresh the product catalogue.');
    if (refreshing) return store.catalogInfo()?.products ?? 0;
    refreshing = true;
    const started = deps.mono();
    try {
      const storeId = operator.checkIn.storeId,
        products: CatalogProduct[] = [];
      let after = '0';
      for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
        const result = await server.catalogPage(traceId, storeId, after);
        for (const item of result.data) {
          const price = parseMoney(item.price);
          if (price === null || price === 0) continue;
          products.push({
            productId: item.id,
            name: item.name,
            barcode: item.barcode,
            unitPricePaise: price,
            stock: item.stock,
          });
        }
        if (!result.nextCursor) break;
        after = result.nextCursor;
      }
      store.transaction(() => store.replaceCatalog(storeId, products, deps.now()));
      deps.log({
        eventId: 'offline.catalog.refreshed',
        traceId,
        outcome: 'succeeded',
        count: products.length,
        durationMs: Math.round(deps.mono() - started),
      });
      deps.changed();
      return products.length;
    } finally {
      refreshing = false;
    }
  }

  /** Online contact: verify the session (expiry/revocation), cache operator,
   * check-in and limits, then upload queued sales oldest first. */
  async function heartbeat(traceId: string, options: { catalog?: boolean } = {}) {
    if (!deps.netOnline()) {
      if (reachable) {
        reachable = false;
        deps.changed();
      }
      return;
    }
    const wasReachable = reachable;
    reachable = await server.reachable(traceId);
    if (reachable !== wasReachable) deps.changed();
    if (!reachable) return;
    const session = await server.session(traceId).catch(() => undefined);
    if (session === undefined) return;
    if (session === null) {
      store.forgetDeviceOperator();
      recordContact();
      deps.changed();
      return;
    }
    const previous = store.deviceOperator();
    const checkIn = await server.checkIn(traceId, session.user.id).catch(() => null);
    const limits = await server.settings(traceId, session.user.id).catch(() => null);
    const stores = await server.stores(traceId).catch(() => []);
    const counters = checkIn ? await server.counters(traceId, checkIn.storeId).catch(() => []) : [];
    store.transaction(() => {
      store.saveOperator({
        id: session.user.id,
        name: session.user.name,
        role: session.user.role,
        userType: session.user.userType,
        storeIds: session.user.storeIds,
        checkIn,
        sessionExpiresAt: session.sessionExpiresAt ?? deps.now() + 3600000,
        verifiedAt: deps.now(),
      });
      if (limits) store.setLimits(limits);
      if (checkIn) store.saveScopeNames(stores, checkIn.storeId, counters, deps.now());
    });
    await sync(traceId);
    recordContact();
    const catalog = store.catalogInfo();
    if (
      checkIn &&
      (options.catalog ||
        previous?.id !== session.user.id ||
        catalog?.storeId !== checkIn.storeId ||
        deps.now() - (catalog?.refreshedAt ?? 0) > 30 * 60000)
    )
      await refreshCatalog(traceId).catch(() => {
        deps.log({
          eventId: 'offline.catalog.refreshed',
          traceId,
          outcome: 'failed',
          code: 'CATALOG_UNAVAILABLE',
        });
      });
    deps.changed();
  }

  function uploadBody(sale: QueueEntry): OfflineSaleUpload {
    const resolution =
      sale.resolution && sale.resolution.action !== 'void'
        ? {
            action: sale.resolution.action,
            managerId: sale.resolution.managerId,
            reason: sale.resolution.reason,
          }
        : null;
    return {
      saleId: sale.saleId,
      provisionalRef: sale.provisionalRef,
      deviceId: deps.deviceId,
      billedBy: sale.operatorId,
      billedAt: sale.createdAt,
      lines: sale.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        unitPrice: formatMoney(line.unitPricePaise),
      })),
      payable: formatMoney(sale.payablePaise),
      tender:
        sale.tender.mode === 'cash'
          ? { mode: 'cash', received: formatMoney(sale.tender.receivedPaise) }
          : { mode: sale.tender.mode, reference: sale.tender.reference },
      resolution,
    };
  }

  async function sync(traceId: string) {
    if (syncing || !online()) return;
    const operator = store.deviceOperator();
    if (!operator) return;
    syncing = true;
    deps.changed();
    let uploaded = 0;
    const started = deps.mono();
    try {
      for (const sale of store.due(deps.now())) {
        const uploader =
          operator.id === sale.operatorId ||
          isManager(operator) ||
          sale.resolution?.managerId === operator.id;
        if (!uploader) continue;
        store.transaction(() => store.markSyncing(sale.saleId, deps.now()));
        const outcome = await server.upload(
          traceId,
          operator.id,
          sale.storeId,
          sale.counterId,
          uploadBody(sale),
        );
        const now = deps.now();
        if (outcome.kind === 'synced') {
          store.transaction(() =>
            store.markSynced(sale.saleId, outcome.orderId, outcome.invoiceNumber, now),
          );
          uploaded++;
        } else if (outcome.kind === 'conflict' || outcome.kind === 'rejected') {
          const code = conflictCodeSchema.catch('REJECTED').parse(outcome.code);
          store.transaction(() => store.markConflict(sale.saleId, code, outcome.message, now));
        } else {
          const delay = Math.min(300000, 5000 * 2 ** Math.min(sale.attempts, 6));
          store.transaction(() =>
            store.markRetry(
              sale.saleId,
              outcome.kind === 'unauthorized' ? 'AUTH_REQUIRED' : outcome.code,
              now + delay,
              now,
            ),
          );
          lastSyncError =
            outcome.kind === 'unauthorized'
              ? 'Sign in again to sync offline sales.'
              : 'Sync paused; it will retry automatically.';
          if (outcome.kind === 'unauthorized' || outcome.code === 'NETWORK_UNAVAILABLE') break;
        }
        deps.changed();
      }
      lastSyncAt = deps.now();
      if (store.counts().queued === 0) lastSyncError = null;
      deps.log({
        eventId: 'offline.sync.completed',
        traceId,
        outcome: 'succeeded',
        count: uploaded,
        durationMs: Math.round(deps.mono() - started),
      });
    } finally {
      syncing = false;
      deps.changed();
    }
  }

  return {
    tick,
    heartbeat,
    status,
    refreshCatalog,
    setReachable(value: boolean) {
      reachable = value;
    },
    online,
    async searchCatalog(input: IpcParsedRequest<'offline:catalog:search'>) {
      const access = await eligibility(input.storeId);
      if (!access.eligible) throw new OfflineBillingError('OFFLINE_NOT_ELIGIBLE', access.message);
      return store.search(input.storeId, input.query, input.limit);
    },
    async byBarcode(input: IpcParsedRequest<'offline:catalog:barcode'>) {
      const access = await eligibility(input.storeId);
      if (!access.eligible) throw new OfflineBillingError('OFFLINE_NOT_ELIGIBLE', access.message);
      return store.byBarcode(input.storeId, input.barcode);
    },
    async createSale(input: IpcParsedRequest<'offline:sale:create'>, traceId: string) {
      const existing = store.sale(input.saleId);
      if (existing) {
        if (existing.storeId !== input.storeId || existing.counterId !== input.counterId)
          throw new OfflineBillingError(
            'SALE_ID_CONFLICT',
            'This sale identifier is already used.',
          );
        const sale = publicSale(existing);
        return { sale, receipt: receipt(sale) };
      }
      if (online())
        throw new OfflineBillingError(
          'ONLINE_BILLING_REQUIRED',
          'The store service is reachable. Bill this sale from the counter.',
        );
      const access = await eligibility(input.storeId, input.counterId);
      if (!access.eligible || !access.operator)
        throw new OfflineBillingError('OFFLINE_NOT_ELIGIBLE', access.message);
      const operator = access.operator;
      tick();
      const created = store.transaction(() => {
        const limits = evaluateLimits(
          store.limits() ?? DEFAULT_LIMITS,
          store.window(),
          store.unsyncedCount(),
        );
        if (!limits.allowed)
          throw new OfflineBillingError(limits.reason ?? 'LIMIT_REACHED', limits.message);
        const lines = input.lines.map((line) => {
          const product = store.product(input.storeId, line.productId);
          if (!product)
            throw new OfflineBillingError(
              'PRODUCT_NOT_CACHED',
              'A product is not in this device’s catalogue.',
            );
          if (product.stock < line.quantity)
            throw new OfflineBillingError(
              'STOCK_UNAVAILABLE',
              `Only ${Math.max(0, product.stock)} of ${product.name} are available on this device.`,
            );
          return {
            productId: product.productId,
            name: product.name,
            unitPricePaise: product.unitPricePaise,
            quantity: line.quantity,
          };
        });
        const totals = saleTotals(lines);
        if (totals.payablePaise <= 0)
          throw new OfflineBillingError(
            'PAYABLE_REQUIRED',
            'Offline sales must have an amount to collect.',
          );
        if (input.tender.mode === 'cash' && input.tender.receivedPaise < totals.payablePaise)
          throw new OfflineBillingError(
            'INSUFFICIENT_CASH',
            'Cash received must cover the payable amount.',
          );
        const sequence = store.nextSequence();
        const provisionalRef = provisionalReference({
          storeId: input.storeId,
          counterId: input.counterId,
          deviceShort,
          sequence,
        });
        store.insertSale({
          saleId: input.saleId,
          provisionalRef,
          sequence,
          storeId: input.storeId,
          counterId: input.counterId,
          operatorId: operator.id,
          operatorName: operator.name,
          createdAt: deps.now(),
          ...totals,
          lines,
          tender: input.tender,
        });
        for (const line of lines)
          store.decrementStock(input.storeId, line.productId, line.quantity);
        return store.sale(input.saleId);
      });
      if (!created) throw new OfflineBillingError('SALE_NOT_SAVED', 'The sale could not be saved.');
      deps.log({ eventId: 'offline.sale.created', traceId, outcome: 'succeeded' });
      deps.changed();
      const sale = publicSale(created);
      return { sale, receipt: receipt(sale) };
    },
    list(input: IpcParsedRequest<'offline:sale:list'>) {
      return store.list(input.status, input.limit).map(publicSale);
    },
    reprint(saleId: string) {
      const sale = store.sale(saleId);
      if (!sale)
        throw new OfflineBillingError('SALE_NOT_FOUND', 'This offline sale was not found.');
      return receipt(publicSale(sale));
    },
    async retry(traceId: string) {
      await heartbeat(traceId);
      return status();
    },
    async resolve(input: IpcParsedRequest<'offline:conflict:resolve'>, traceId: string) {
      const sale = store.sale(input.saleId);
      if (!sale)
        throw new OfflineBillingError('SALE_NOT_FOUND', 'This offline sale was not found.');
      if (sale.status !== 'needs_manager')
        throw new OfflineBillingError('NO_CONFLICT', 'This sale has no conflict to resolve.');
      const access = await eligibility();
      const manager = access.operator;
      if (
        !manager ||
        manager.sessionExpiresAt <= deps.now() ||
        !isManager(manager) ||
        !(await deps.hasSessionCookie())
      )
        throw new OfflineBillingError(
          'MANAGER_REQUIRED',
          'A store manager must be signed in on this device to resolve this sale.',
        );
      if (input.tender?.mode === 'cash' && input.tender.receivedPaise < sale.payablePaise)
        throw new OfflineBillingError(
          'INSUFFICIENT_CASH',
          'Cash received must cover the payable amount.',
        );
      const resolvedAt = deps.now();
      store.transaction(() => {
        if (input.tender)
          store.writeTender(sale.saleId, input.tender, sale.payablePaise, resolvedAt);
        store.resolve(sale.saleId, {
          action: input.action,
          managerId: manager.id,
          reason: input.reason,
          resolvedAt,
        });
      });
      deps.log({
        eventId: 'offline.conflict.resolved',
        traceId,
        outcome: 'succeeded',
        code: input.action,
      });
      deps.changed();
      if (input.action !== 'void') void sync(randomUUID()).catch(() => undefined);
      const updated = store.sale(sale.saleId);
      if (!updated)
        throw new OfflineBillingError('SALE_NOT_FOUND', 'This offline sale was not found.');
      return publicSale(updated);
    },
  };
}
export type OfflineBillingService = ReturnType<typeof offlineBillingService>;
