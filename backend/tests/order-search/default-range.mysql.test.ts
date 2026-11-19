import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sourceOrderDefaults } from '../../src/modules/order-history/search/default-ranges.js';
import {
  orderSearchInput,
  type SourceSearchScope,
} from '../../src/modules/order-history/search/contracts.js';
import { sourceNativeRepository } from '../../src/modules/order-history/search/native.js';
import { formatSourceOrder } from '../../src/modules/order-history/search/format.js';
import { searchWindow } from '../../src/modules/order-history/search/service.js';
import { orderSearchFixture } from './mysql-fixture.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const template = process.env.ORDER_SEARCH_MYSQL_TEST_URL;
/** Legacy `strftime("%m/%d/%Y %I:%M %p")` of a `YYYY-MM-DD HH:MM:SS` business timestamp. */
function legacyStamp(value: string) {
  const hour = Number(value.slice(11, 13));
  return (
    value.slice(5, 7) +
    '/' +
    value.slice(8, 10) +
    '/' +
    value.slice(0, 4) +
    ' ' +
    String(hour % 12 || 12).padStart(2, '0') +
    value.slice(13, 16) +
    (hour < 12 ? ' AM' : ' PM')
  );
}
const rendered = z.object({
  defaultRange: z.string().regex(/^\d\d\/\d\d\/\d{4} /),
  mro: z.array(z.string()),
  cases: z
    .array(
      z.object({
        type: z.string(),
        status: z.number(),
        range: z.string(),
        ajaxRange: z.string().nullable(),
        selected: z.boolean(),
      }),
    )
    .length(4),
});
const datatable = z.array(
  z.object({ response: z.object({ data: z.array(z.unknown()), recordsTotal: z.string() }) }),
);
describe.skipIf(!template)(
  'pinned OrdersView default form and midnight window on native MySQL',
  () => {
    let fixture: Awaited<ReturnType<typeof orderSearchFixture>>;
    beforeAll(async () => {
      fixture = await orderSearchFixture(template!);
      await fixture.fixture.create(['products', 'pos_terminal_payment_modes']);
      await fixture.fixture.insert('pos_user', { id: 9, is_active: 1, role: 1, user_type: 1 });
      await fixture.fixture.insert('stores', {
        id: 1,
        store_name: 'Synthetic midnight',
        location_code: 'SYN',
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await fixture.fixture.insert('store_counters', {
        id: 1,
        store_id: 1,
        counter_name: 'Synthetic counter',
        is_active: 1,
      });
      await fixture.fixture.insert('order_status', { id: 3, order_status: 'Delivered' });
      await fixture.fixture.insert('payment_status', { id: 4, payment_status: 'Paid' });
      await fixture.fixture.insert('payment_method', { id: 14, name: 'Cash' });
      await fixture.fixture.insert('users', {
        id: 7,
        firstname: 'Synthetic',
        lastname: 'Midnight',
        email: 'midnight@example.invalid',
        telephone: '555007',
      });
      for (const [id, ref, location] of [
        [501, 'SYN-FUTURE', 0],
        [502, 'SYN-ONLINE-FUTURE', null],
      ] as const)
        await fixture.fixture.insert('orders', {
          id,
          user_id: 7,
          order_ref_no: ref,
          order_status: 3,
          payment_status: 4,
          payment_method: 14,
          created_at: '2027-01-01 00:00:00',
          order_amt: 120,
          pay_amt: 119,
          location_id: location,
          location_type: '',
        });
      for (const id of [1, 2])
        await fixture.fixture.insert('order_stores', {
          id,
          order_id: 501,
          store_id: 1,
          counter_id: 1,
          offline_payment: 60,
          online_other_payment: 0,
          is_manually_paid: 1,
          is_offline_order: 0,
          is_shopify_order: 0,
        });
      await fixture.fixture.insert('has_products', { id: 1, order_id: 501, status: 'PLACED' });
    });
    /** Pinned `orders_datatable.py` over this fixture, replayed from `default-range-mysql`. */
    function source(orderType: 'N' | 'ST') {
      return datatable.parse(
        JSON.parse(
          goldenStdout(
            'order-search',
            'default-range-mysql',
            JSON.stringify({
              url: fixture.url,
              cases: [
                {
                  order_type: orderType,
                  ...(orderType === 'ST' ? { 'selected_stores[]': ['1'] } : {}),
                  order_date_range: '12/26/2026 11:59 PM - 01/01/2027 12:00 AM',
                  'search[value]': '',
                  'order[0][column]': '0',
                  'columns[0][data]': 'id',
                  'order[0][dir]': 'desc',
                  start: 0,
                  length: 100,
                  draw: 1,
                },
              ],
            }),
            undefined,
            fixturePlaceholders(fixture.url),
          ),
        ) as unknown,
      )[0]!.response;
    }
    async function rewrite(orderType: 'N' | 'ST') {
      const input = orderSearchInput.parse({
        orderType,
        storeIds: orderType === 'ST' ? ['1'] : [],
        placedFrom: '2026-12-26 23:59:00',
        placedTo: '2027-01-01 00:00:00',
        pageSize: 100,
      });
      const scope: SourceSearchScope = {
        contextStoreId: '1',
        checkedInStoreId: '1',
        allowedStores: ['1'],
        internal: true,
        franchiseViewer: false,
        binding: 'synthetic',
        effectiveType: orderType,
        selectedStores: input.storeIds,
        explicitIds: false,
        heLocationLabel: null,
      };
      const result = await sourceNativeRepository(fixture.db).search(
        scope,
        input,
        searchWindow(input),
      );
      return {
        count: result.count,
        rows: result.rows.map((row) => {
          const {
            rowKey: _key,
            actionStoreId: _store,
            ...value
          } = formatSourceOrder(row.fact, scope, row.rowKey);
          return value;
        }),
      };
    }
    it('includes the exact midnight end minute for N and returns the original single online row', async () => {
      const expected = source('N'),
        actual = await rewrite('N');
      expect(actual.rows).toEqual(expected.data);
      expect(actual.rows).toHaveLength(1);
      expect(actual.count).toBe(expected.recordsTotal);
    });
    it('reconstructs the original duplicate association rows for a store order at the end minute', async () => {
      const expected = source('ST'),
        actual = await rewrite('ST');
      expect(actual.count).toBe(expected.recordsTotal);
      expect(actual.rows).toEqual(expected.data);
      expect(actual.rows).toHaveLength(4);
    });
    afterAll(async () => {
      await fixture?.close();
    });
    it('renders the original GET default window that the rewrite defaults reproduce, kept across type-switch POSTs', () => {
      // 2026-11-17 11:30:20 in Asia/Kolkata; the capture froze datetime.now() at this wall time
      // and seeded the legacy `check_in_9` key with [1, "Synthetic midnight"].
      const now = Date.parse('2026-11-17T06:00:20Z');
      const result = rendered.parse(
        JSON.parse(
          goldenStdout(
            'order-search',
            'default-form',
            JSON.stringify({
              url: fixture.url,
              actor: 9,
              checkIn: [1, 'Synthetic midnight'],
              now: '2026-11-17T11:30:20',
            }),
            undefined,
            fixturePlaceholders(fixture.url),
          ),
        ) as unknown,
      );
      expect(result.mro).toEqual([
        'OrdersView',
        'LoginRequiredMixin',
        'AccessMixin',
        'View',
        'object',
      ]);
      const defaults = sourceOrderDefaults(now, 'Asia/Kolkata').store;
      expect(result.defaultRange).toBe(
        legacyStamp(defaults.placedFrom) + ' - ' + legacyStamp(defaults.placedTo),
      );
      expect(result.cases.map((value) => value.type)).toEqual(['N', 'ST', 'HE', 'N']);
      for (const item of result.cases)
        expect(item).toEqual({
          type: item.type,
          status: 200,
          range: result.defaultRange,
          ajaxRange: result.defaultRange,
          selected: true,
        });
    });
  },
);
