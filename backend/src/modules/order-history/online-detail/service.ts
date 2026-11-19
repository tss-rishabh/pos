import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import {
  onlineDetailSelection,
  onlineOrderDetail,
  type OnlineDetailSelection,
  type OnlineOrderDetail,
} from './contracts.js';
import { onlineDetailAuthority, assertDetailBinding } from './authority.js';
import {
  readNativeOnlineDetail,
  readCurrentOrderCustomer,
  readCurrentOrderProducts,
} from './native.js';
import { readOnlineDetailContext } from './context.js';
import { detailUnavailable } from './errors.js';

/**
 * Legacy `ShowOnlineOrderDetailsView.get` (`order/views.py:504-680`): the order is read by id
 * from the primary database for any order date, as legacy reads it. There is no warehouse
 * path: legacy never reads order details from BigQuery.
 */
export function onlineOrderDetailService(
  config: Config,
  db: Databases,
  dependencies: { clock?: () => number } = {},
) {
  const clock = dependencies.clock ?? Date.now,
    authority = onlineDetailAuthority(config, db);
  return {
    async read(
      user: Principal,
      storeId: string,
      orderId: string,
      raw: OnlineDetailSelection,
    ): Promise<OnlineOrderDetail> {
      const selection = onlineDetailSelection.parse(raw);
      const original = await authority(user, storeId, orderId, selection);
      const fact = await db
        .get('primary')
        .transaction((tx) => readNativeOnlineDetail(tx, orderId, config.BUSINESS_TIMEZONE), {
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        });
      if (!fact) throw detailUnavailable();
      assertDetailBinding(fact, original, selection);
      const [customer, products, context] = await Promise.all([
        readCurrentOrderCustomer(db, fact.customerId, config.BUSINESS_TIMEZONE, clock()),
        readCurrentOrderProducts(
          db,
          fact.lines.map((line) => line.productId),
          clock(),
        ),
        readOnlineDetailContext(db, user, fact, selection.type === 'HE' ? storeId : null),
      ]);
      const current = await authority(user, storeId, orderId, selection);
      if (current.binding !== original.binding)
        throw new AppError(
          403,
          'ORDER_DETAIL_SCOPE_CHANGED',
          'Your order-viewing permissions changed. Refresh this order.',
        );
      return onlineOrderDetail.parse({
        type: selection.type,
        storeId,
        reader: 'primary',
        fetchedAt: new Date(clock()).toISOString(),
        fact,
        customer,
        products,
        context,
      });
    },
  };
}
export type OnlineOrderDetailService = ReturnType<typeof onlineOrderDetailService>;
