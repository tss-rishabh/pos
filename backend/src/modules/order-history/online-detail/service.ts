import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { orderRange } from '../contracts.js';
import { sourceOrderDefaults } from '../search/default-ranges.js';
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
import { historicalOnlineDetails, type HistoricalOnlineDetailPort } from './reader.js';
import { detailUnavailable } from './errors.js';

export function onlineOrderDetailService(
  config: Config,
  db: Databases,
  dependencies: { history?: HistoricalOnlineDetailPort; clock?: () => number } = {},
) {
  const clock = dependencies.clock ?? Date.now,
    authority = onlineDetailAuthority(config, db),
    history = dependencies.history ?? historicalOnlineDetails(config, undefined, clock);
  return {
    async read(
      user: Principal,
      storeId: string,
      orderId: string,
      raw: OnlineDetailSelection,
    ): Promise<OnlineOrderDetail> {
      const selection = onlineDetailSelection.parse(raw),
        readTime = clock();
      const selected = orderRange(
        { from: selection.from, to: selection.to },
        config.BUSINESS_TIMEZONE,
        readTime,
      );
      const original = await authority(user, storeId, orderId, selection);
      let fact: OnlineOrderDetail['fact'] | null = null,
        publication: OnlineOrderDetail['publication'] = null;
      if (selected.reader === 'primary') {
        const sourceEnd = !selected.explicit
          ? sourceOrderDefaults(readTime, selected.timeZone).store.placedTo
          : undefined;
        fact = await db
          .get('primary')
          .transaction(
            (tx) =>
              readNativeOnlineDetail(
                tx,
                orderId,
                selected,
                sourceEnd && sourceEnd >= selected.end ? sourceEnd : undefined,
              ),
            { isolationLevel: 'repeatable read', accessMode: 'read only' },
          );
        if (!fact && selected.explicit) throw detailUnavailable();
      }
      if (!fact) {
        const result = await history.read({
          orderId,
          customerId: original.customerId,
          ...(selected.reader === 'bigquery' ? { range: selected } : {}),
          cutoff: selected.cutoff,
          timeZone: selected.timeZone,
        });
        fact = result.fact;
        publication = result.publication;
      }
      assertDetailBinding(fact, original, selection);
      const [customer, products] = await Promise.all([
        readCurrentOrderCustomer(db, fact.customerId, config.BUSINESS_TIMEZONE, clock()),
        readCurrentOrderProducts(
          db,
          fact.lines.map((line) => line.productId),
          clock(),
        ),
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
        reader: publication ? 'bigquery' : 'primary',
        fetchedAt: new Date(clock()).toISOString(),
        fact,
        customer,
        products,
        publication,
      });
    },
  };
}
export type OnlineOrderDetailService = ReturnType<typeof onlineOrderDetailService>;
