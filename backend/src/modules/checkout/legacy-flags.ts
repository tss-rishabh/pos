import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import { Store } from '../../db/legacy-schema.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';

/**
 * Legacy settings flags resolved per request (backend/parity/legacy-flags.md).
 * Source: backend-pos-web@78d5b63 `POSAdmin/settings.py` and `CreateOrderView` (`order/views.py:1562-1567`,
 * `:1634-1639`), which passes them into the `create_order.html` context.
 */
export type LegacyFlagConfig = Pick<
  Config,
  | 'GLOBAL_SHOW_COUPON_MODULE'
  | 'GLOBAL_SHOW_PG_DISCOUNT_MODULE'
  | 'ENABLE_OLD_PG_DISCOUNT'
  | 'ENABLE_NEW_PG_DISCOUNT'
  | 'ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT'
  | 'TEN_PER_SWITCH'
  | 'EXCHANGE_ENABLED_STORE_IDS'
>;

export interface CheckoutFlags {
  /** `create_order.html:260`: the coupon block. */
  showCouponModule: boolean;
  /** `create_order.html:302`: the whole PG-discount block. */
  showPgDiscountModule: boolean;
  /** `create_order.html:303`: old PG discount control inside the PG block. */
  enableOldPgDiscount: boolean;
  /** `create_order.html:329`: new (store) PG discount control inside the PG block. */
  enableNewPgDiscount: boolean;
  /** `create_order.html:287`: voucher → TSS Money check & convert control. */
  enableVoucherToMoney: boolean;
  /** `create_order.html:538-545`: cashback eligibility row (`TEN_PER_SWITCH`). */
  tenPerSwitch: boolean;
}

/**
 * `show_coupon_module = GLOBAL_SHOW_COUPON_MODULE or (store.category == "IN_HOUSE" and
 * request.user.user_type == 1)`; the PG module uses the same formula with its own global flag.
 * The store is the checkout store, the user type is the operator's `pos_user.user_type`.
 */
export function checkoutFlags(
  config: LegacyFlagConfig,
  storeCategory: string | null,
  operatorUserType: number | null,
): CheckoutFlags {
  const inHouseAdmin = storeCategory === 'IN_HOUSE' && operatorUserType === 1;
  return {
    showCouponModule: config.GLOBAL_SHOW_COUPON_MODULE !== 0 || inHouseAdmin,
    showPgDiscountModule: config.GLOBAL_SHOW_PG_DISCOUNT_MODULE !== 0 || inHouseAdmin,
    enableOldPgDiscount: config.ENABLE_OLD_PG_DISCOUNT !== 0,
    enableNewPgDiscount: config.ENABLE_NEW_PG_DISCOUNT !== 0,
    enableVoucherToMoney: config.ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT !== 0,
    tenPerSwitch: config.TEN_PER_SWITCH !== 0,
  };
}

/**
 * `get_exchange_context` (`order/views.py:338-340`): computed from the operator's CHECK-IN store,
 * not the order's store. Legacy enforces it in templates only.
 */
export function exchangeFeatureEnabled(
  config: Pick<Config, 'EXCHANGE_ENABLED_STORE_IDS'>,
  checkinStoreId: string | null,
): boolean {
  const setting = config.EXCHANGE_ENABLED_STORE_IDS;
  if (setting.all) return true;
  if (!checkinStoreId || !/^\d+$/.test(checkinStoreId)) return false;
  const normalized = String(BigInt(checkinStoreId));
  // Legacy `checkin_store_id and ...`: a falsy (0) check-in store never enables exchanges.
  return normalized !== '0' && setting.storeIds.includes(normalized);
}

/** Resolves the flags for one checkout request from the checkout store and the operator. */
export function checkoutFlagsReader(db: Databases, config: LegacyFlagConfig) {
  return async (user: Pick<Principal, 'userType'>, storeId: string): Promise<CheckoutFlags> => {
    const [store] = await db
      .get('primary')
      .select({ category: Store.category })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .limit(1);
    return checkoutFlags(config, store?.category ?? null, user.userType);
  };
}
