/**
 * Return/exchange cell branch selection, exactly as the legacy templates choose it
 * (backend/parity/exchange-cell-guards.md).
 *
 * - `online`: `order/templates/order/online/_return_exchange_cells.html` (whole file).
 * - `store`: `order/templates/order/show.html:186-292` (the per-line return/exchange cells).
 *
 * The function is pure: it receives the per-line facts and returns what the template renders.
 * Texts are the template texts with surrounding whitespace removed. `&mdash;` is `—`.
 * A Django `None` interpolated into "Valid for … till {{ … }}" renders as `None`.
 */

export interface EligibilityEntry {
  /** API-v2 `is_applicable_for_return|exchange == 1`. */
  status: boolean;
  /** `applicable_for_*_message` when the flag is 2, otherwise ''. */
  reason: string;
  /** `estimate_return_date` / `estimate_exchange_date` (exchange: only when status is true). */
  upto: string | null;
}

export interface FailedExchangeFacts {
  /** `pos_exchange_log.store_id` of the retryable FAILED_NEEDS_MANUAL_FIX row. */
  storeId: string;
  /** `stores.store_name` of that store, '' when unknown. */
  storeName: string;
  /** `pos_exchange_log.new_size`. */
  newSize: string;
}

export interface ExchangeCellFacts {
  variant: 'online' | 'store';
  /** Store template only: `order_stores.is_shopify_order` of the first order store. */
  shopifyOrder: boolean;
  /**
   * Legacy `is_return and is_exchange`: the operator is checked in and the eligibility call
   * returned at least one line. False renders "Check-in first …".
   */
  eligibilityLoaded: boolean;
  /** CURRENT `products.prod_type` of `hp.product` (never a snapshot). */
  productType: number | null;
  /** `has_products.status`. */
  lineStatus: string | null;
  /** `is_return[hp.id]`; null when the line is absent from the eligibility response. */
  return: EligibilityEntry | null;
  /** `is_exchange[hp.id]`; null when the line is absent from the eligibility response. */
  exchange: EligibilityEntry | null;
  /** `Helpers.can_super_admin_override_return` (helpers/helpers.py:1780). */
  superAdminReturnOverride: boolean;
  /** Present only when `pos_exchange_retryable` holds (order/views.py:327-328). */
  failedExchange: FailedExchangeFacts | null;
  /** The operator's check-in store id (`get_exchange_context`, order/views.py:313). */
  checkinStoreId: string | null;
  /** `exchange_feature_enabled` from the check-in store (order/views.py:338-340). */
  exchangeFeatureEnabled: boolean;
  /** `request.user.role`. */
  operatorRole: number;
}

export type CellAction =
  /** `.btn-mark-return`, `click-type="normal"` (or no click-type in the online template). */
  | 'return'
  /** `#force-return.btn-mark-return`, `click-type="extreme"` (store template only). */
  | 'force-return'
  /** `.btn-mark-exchange` for a new exchange. */
  | 'exchange'
  /** `.btn-mark-exchange[is-retry=1]` for a retryable failed exchange. */
  | 'retry-exchange'
  /** `.btn-extend-return-time` (roles 1-3). */
  | 'extend-return';

export interface CellText {
  text: string;
  /** `plain` = `<small>`, `danger` = `text-danger`, `strong-danger` = `text-danger text-bold`, `badge` = `badge-warning`. */
  style: 'plain' | 'danger' | 'strong-danger' | 'badge';
}

export interface CellPart {
  actions: CellAction[];
  texts: CellText[];
  /** The non-interactive warning icon button of the online return fallback. */
  warningIcon: boolean;
}

export type CellBranch =
  | 'store-product-type-8'
  | 'check-in-first'
  | 'failed-exchange'
  | 'merged'
  | 'already-returned'
  | 'already-exchanged'
  | 'split'
  /** Store template: the line has no eligibility entry, so the loop renders no cells. */
  | 'no-cells';

export type ExchangeSubBranch =
  | 'product-type-8'
  | 'eligible'
  | 'feature-disabled'
  | 'reason'
  | 'already-returned'
  | 'already-exchanged'
  | 'not-applicable';

export type ReturnSubBranch =
  | 'eligible'
  | 'super-admin-override'
  | 'reason'
  | 'already-returned'
  | 'already-exchanged'
  | 'force-return'
  | 'not-applicable';

export interface ExchangeCell {
  branch: CellBranch;
  /** Store template: the extra Shopify notice column rendered before the cells. */
  notice: CellText | null;
  /** One part = a `colspan="2"` cell; two parts = return cell then exchange cell. */
  parts: CellPart[];
  returnBranch: ReturnSubBranch | null;
  exchangeBranch: ExchangeSubBranch | null;
}

const RETURNED = 'PRODUCT_RETURNED';
const EXCHANGED = ['EXCHANGE_INITIATED', 'EXCHANGE_COMPLETED'];
const DASH = '—';

const text = (value: string, style: CellText['style'] = 'plain'): CellText => ({
  text: value,
  style,
});
const part = (actions: CellAction[], texts: CellText[], warningIcon = false): CellPart => ({
  actions,
  texts,
  warningIcon,
});
/** Django renders a `None` variable as "None". */
const shown = (value: string | null) => (value === null ? 'None' : value);

/** `hp.return_exchange_merged` (order/views.py:534) / `value.merged` (order/views.py:388-389). */
export function returnExchangeMerged(
  returnEntry: EligibilityEntry | null,
  exchangeEntry: EligibilityEntry | null,
): boolean {
  return Boolean(
    returnEntry?.status && exchangeEntry?.status && returnEntry.upto === exchangeEntry.upto,
  );
}

/** `hp.failed_exchange_wrong_store` (order/views.py:331-333). */
export function failedExchangeWrongStore(
  failed: FailedExchangeFacts | null,
  checkinStoreId: string | null,
): boolean {
  return Boolean(
    failed && checkinStoreId && checkinStoreId !== '0' && failed.storeId !== checkinStoreId,
  );
}

function failedExchangePart(facts: ExchangeCellFacts, failed: FailedExchangeFacts): CellPart {
  if (!facts.exchangeFeatureEnabled)
    return part(
      [],
      [
        text(
          `Item returned, replacement order failed ${DASH} contact tech support to retry`,
          'danger',
        ),
      ],
    );
  if (failedExchangeWrongStore(failed, facts.checkinStoreId))
    return part(
      [],
      [
        text(
          `Item returned, replacement order failed ${DASH} retry from ${failed.storeName || 'the store it was started at'}`,
          'danger',
        ),
      ],
    );
  return part(
    ['retry-exchange'],
    [
      text(
        `Item returned, replacement order failed ${DASH} tap to retry (size ${failed.newSize})`,
        'danger',
      ),
    ],
  );
}

function mergedPart(facts: ExchangeCellFacts): CellPart {
  const upto = shown(facts.return?.upto ?? null);
  return facts.exchangeFeatureEnabled
    ? part(['return', 'exchange'], [text(`Valid for return/exchange till ${upto}`)])
    : part(['return'], [text(`Valid for return till ${upto}`)]);
}

/** The return-reason text plus the "closed" extension prompt (both templates). */
function reasonTexts(
  facts: ExchangeCellFacts,
  reason: string,
): { actions: CellAction[]; texts: CellText[] } {
  const texts = [text(reason)];
  const actions: CellAction[] = [];
  if (reason.includes('closed')) {
    if ([1, 2, 3].includes(facts.operatorRole)) actions.push('extend-return');
    else
      texts.push(
        text(
          'Would you like to extend the return date? If so, please request upper management to log in and check here.',
          'danger',
        ),
      );
  }
  return { actions, texts };
}

function returnPart(facts: ExchangeCellFacts): { part: CellPart; branch: ReturnSubBranch } {
  const entry = facts.return;
  if (entry?.status)
    return {
      part: part(['return'], [text(`Valid for return till ${shown(entry.upto)}`)]),
      branch: 'eligible',
    };
  if (facts.superAdminReturnOverride)
    return {
      part: part(['return'], entry?.reason ? [text(`Override: ${entry.reason}`, 'danger')] : []),
      branch: 'super-admin-override',
    };
  const online = facts.variant === 'online';
  if (entry?.reason) {
    const prompt = reasonTexts(facts, entry.reason);
    return { part: part(prompt.actions, prompt.texts, online), branch: 'reason' };
  }
  if (facts.lineStatus === RETURNED)
    return { part: part([], [text('Already Returned')], online), branch: 'already-returned' };
  if (online)
    return { part: part([], [text('Not applicable for return')], true), branch: 'not-applicable' };
  if (EXCHANGED.includes(facts.lineStatus ?? ''))
    return { part: part([], [text('Already Exchanged')]), branch: 'already-exchanged' };
  if (facts.lineStatus === 'DELIVERED' && facts.productType !== 8)
    return { part: part(['force-return'], []), branch: 'force-return' };
  return { part: part([], [text('Not applicable for return', 'badge')]), branch: 'not-applicable' };
}

function exchangePart(facts: ExchangeCellFacts): { part: CellPart; branch: ExchangeSubBranch } {
  const entry = facts.exchange;
  // Online template only: checked first, so it wins over an eligible exchange.
  if (facts.variant === 'online' && facts.productType === 8)
    return { part: part([], [text('Not Applicable For Exchange')]), branch: 'product-type-8' };
  if (entry?.status && facts.exchangeFeatureEnabled)
    return {
      part: part(['exchange'], [text(`Valid for exchange till ${shown(entry.upto)}`)]),
      branch: 'eligible',
    };
  if (entry?.status)
    return {
      part: part([], [text('Not applicable for exchange', 'badge')]),
      branch: 'feature-disabled',
    };
  if (entry?.reason) return { part: part([], [text(entry.reason)]), branch: 'reason' };
  if (facts.lineStatus === RETURNED)
    return { part: part([], [text('Already Returned')]), branch: 'already-returned' };
  if (EXCHANGED.includes(facts.lineStatus ?? ''))
    return { part: part([], [text('Already Exchanged')]), branch: 'already-exchanged' };
  return {
    part: part([], [text('Not applicable for exchange', 'badge')]),
    branch: 'not-applicable',
  };
}

export function exchangeCell(facts: ExchangeCellFacts): ExchangeCell {
  const notice =
    facts.variant === 'store' && facts.shopifyOrder
      ? text('Shopify Order not eligible for return')
      : null;
  const cell = (
    branch: CellBranch,
    parts: CellPart[],
    returnBranch: ReturnSubBranch | null = null,
    exchangeBranch: ExchangeSubBranch | null = null,
  ): ExchangeCell => ({ branch, notice, parts, returnBranch, exchangeBranch });

  if (facts.variant === 'store' && facts.productType === 8)
    return cell('store-product-type-8', [
      part([], [text('Not Applicable For Return')]),
      part([], [text('Not Applicable For Exchange')]),
    ]);
  if (!facts.eligibilityLoaded)
    return cell('check-in-first', [
      part([], [text('Check-in first to check return status', 'strong-danger')]),
      part([], [text('Check-in first to check exchange status', 'strong-danger')]),
    ]);
  if (facts.variant === 'store' && !facts.return && !facts.exchange) return cell('no-cells', []);
  if (facts.failedExchange)
    return cell('failed-exchange', [failedExchangePart(facts, facts.failedExchange)]);
  if (returnExchangeMerged(facts.return, facts.exchange))
    return cell('merged', [mergedPart(facts)]);
  const noEligibility =
    !facts.return?.status &&
    !facts.exchange?.status &&
    !facts.return?.reason &&
    !facts.exchange?.reason;
  if (noEligibility && facts.lineStatus === RETURNED)
    return cell('already-returned', [part([], [text('Already Returned')])]);
  if (noEligibility && EXCHANGED.includes(facts.lineStatus ?? ''))
    return cell('already-exchanged', [part([], [text('Already Exchanged')])]);
  const returned = returnPart(facts),
    exchanged = exchangePart(facts);
  return cell('split', [returned.part, exchanged.part], returned.branch, exchanged.branch);
}

/** True when the cell offers the given action. */
export function cellOffers(cell: ExchangeCell, action: CellAction): boolean {
  return cell.parts.some((value) => value.actions.includes(action));
}
