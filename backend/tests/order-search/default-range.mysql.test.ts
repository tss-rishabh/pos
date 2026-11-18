import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createClient } from 'redis';
import { ordersService } from '../../src/modules/orders.js';
import type { Principal } from '../../src/domain/access.js';
import {
  sourceOrderDefaults,
  sourceSearchReadPlan,
} from '../../src/modules/order-history/search/default-ranges.js';
import {
  orderSearchInput,
  type SourceSearchScope,
} from '../../src/modules/order-history/search/contracts.js';
import { sourceNativeRepository } from '../../src/modules/order-history/search/native.js';
import { sourceIndex, sourceSelect } from '../../src/modules/order-history/search/reducer.js';
import { formatSourceOrder } from '../../src/modules/order-history/search/format.js';
import { orderSearchFixture } from './mysql-fixture.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';
const template = process.env.ORDER_SEARCH_MYSQL_TEST_URL,
  python = process.env.ORDER_SEARCH_ORACLE_PYTHON;
describe.skipIf(!template)('native midnight source-window supplement', () => {
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
    await fixture.fixture.insert('users', {
      id: 7,
      firstname: 'Synthetic',
      lastname: 'Midnight',
      email: 'midnight@example.invalid',
      telephone: '555007',
    });
    await fixture.fixture.insert('order_status', { id: 3, order_status: 'Delivered' });
    await fixture.fixture.insert('payment_status', { id: 4, payment_status: 'Paid' });
    await fixture.fixture.insert('payment_method', { id: 14, name: 'Cash' });
    await fixture.fixture.insert('orders', {
      id: 501,
      user_id: 7,
      order_ref_no: 'SYN-FUTURE',
      order_status: 3,
      payment_status: 4,
      payment_method: 14,
      created_at: '2027-01-01 00:00:00',
      order_amt: 120,
      pay_amt: 119,
      location_id: 0,
      location_type: '',
    });
    await fixture.fixture.insert('orders', {
      id: 502,
      user_id: 7,
      order_ref_no: 'SYN-ONLINE-FUTURE',
      order_status: 3,
      payment_status: 4,
      payment_method: 14,
      created_at: '2027-01-01 00:00:00',
      order_amt: 120,
      pay_amt: 119,
      location_id: null,
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
  afterAll(async () => {
    await fixture?.close();
  });
  // The Redis-backed default-form oracle was not captured; it still needs the live interpreter.
  it.skipIf(!process.env.ORDER_DEFAULT_FORM_REDIS_URL || !python)(
    'runs actual original GET/POST and rendered form with unchanged type-switch placement',
    async () => {
      const redis = createClient({ url: process.env.ORDER_DEFAULT_FORM_REDIS_URL! });
      await redis.connect();
      try {
        await redis.set('check_in_9', JSON.stringify([1, 'Synthetic midnight']));
        const raw: unknown = JSON.parse(
          execFileSync(python!, ['-B', 'tests/order-search/default-form-source.py'], {
            input: JSON.stringify({
              url: fixture.url,
              redis: process.env.ORDER_DEFAULT_FORM_REDIS_URL,
              actor: 9,
            }),
            encoding: 'utf8',
            timeout: 30000,
          }),
        );
        const result = z
          .object({
            defaultRange: z.string().regex(/^\d\d\/\d\d\/\d{4} /),
            mro: z.array(z.string()),
            cases: z
              .array(
                z.object({
                  type: z.string(),
                  status: z.number(),
                  range: z.string(),
                  ajaxRange: z.string(),
                  selected: z.boolean(),
                }),
              )
              .length(4),
          })
          .parse(raw);
        expect(result.mro).toEqual([
          'OrdersView',
          'LoginRequiredMixin',
          'AccessMixin',
          'View',
          'object',
        ]);
        expect(result.cases.map((value) => value.type)).toEqual(['N', 'ST', 'HE', 'N']);
        for (const item of result.cases)
          expect(item).toEqual({
            type: item.type,
            status: 200,
            range: result.defaultRange,
            ajaxRange: result.defaultRange,
            selected: true,
          });
      } finally {
        await redis.del('check_in_9');
        await redis.quit();
      }
    },
  );
  it('retains the source store-page future endpoint for N without widening its cap or global authority', async () => {
    const now = Date.parse('2026-12-31T18:29:55Z');
    const input = orderSearchInput.parse({
      ...sourceOrderDefaults(now, 'Asia/Kolkata').store,
      orderType: 'N',
      from: '2026-12-26',
      to: '2027-01-01',
    });
    const scope: SourceSearchScope = {
      contextStoreId: '1',
      checkedInStoreId: '1',
      allowedStores: ['1'],
      internal: true,
      globalReader: true,
      binding: 'synthetic',
      effectiveType: 'N',
      selectedStores: ['1'],
      explicitIds: false,
      heLocationLabel: null,
    };
    const plan = sourceSearchReadPlan(input, 'Asia/Kolkata', now);
    const facts = await sourceNativeRepository(fixture.db).currentFacts(
      scope,
      input,
      plan.current!,
      20000,
    );
    const selected = sourceSelect(
      facts.map((value) => sourceIndex(value)),
      scope,
      input,
      { orderPhone: '', userPhone: '', email: '' },
    );
    const actual = selected.rows.map((row) => {
      const {
        rowKey: _key,
        actionStoreId: _store,
        ...value
      } = formatSourceOrder(
        facts.find((fact) => fact.id === row.index.id)!,
        scope,
        row.rowKey,
      );
      return value;
    });
    const original: unknown = JSON.parse(
      goldenStdout(
        'order-search',
        'default-range-mysql',
        JSON.stringify({
          url: fixture.url,
          cases: [
            {
              order_type: 'N',
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
    );
    const expected = z
      .array(
        z.object({ response: z.object({ data: z.array(z.unknown()), recordsTotal: z.string() }) }),
      )
      .parse(original)[0]!.response;
    expect(actual).toEqual(expected.data);
    expect(actual).toHaveLength(1);
    expect(selected.count).toBe(expected.recordsTotal);
    await fixture.connection.query(
      "UPDATE orders SET created_at='2027-01-01 00:00:01' WHERE id=502",
    );
    expect(
      await sourceNativeRepository(fixture.db).currentFacts(scope, input, plan.current!, 20000),
    ).toEqual([]);
    await fixture.connection.query(
      "UPDATE orders SET created_at='2027-01-01 00:00:00' WHERE id=502",
    );
    expect(
      await sourceNativeRepository(fixture.db).currentFacts(
        { ...scope, globalReader: false },
        input,
        plan.current!,
        20000,
      ),
    ).toEqual([]);
    expect(() =>
      sourceSearchReadPlan(
        orderSearchInput.parse({ ...input, placedTo: '2027-01-01 00:01:00' }),
        'Asia/Kolkata',
        now,
      ),
    ).toThrow();
    expect(() =>
      sourceSearchReadPlan(
        orderSearchInput.parse({ ...input, intent: 'report' }),
        'Asia/Kolkata',
        now,
      ),
    ).toThrow();
  });
  it('opens only the source-admitted midnight point through authorized undated detail', async () => {
    const user: Principal = {
      id: '9',
      name: 'Synthetic',
      email: 'operator@example.invalid',
      role: 1,
      userType: 1,
      storeIds: ['1'],
    };
    const atMidnight = ordersService(fixture.db, undefined, undefined, () =>
      Date.parse('2026-12-31T18:29:55Z'),
    );
    expect((await atMidnight.detail(user, '1', '501')).id).toBe('501');
    await fixture.connection.query(
      "UPDATE orders SET created_at='2027-01-01 00:00:01' WHERE id=501",
    );
    await expect(atMidnight.detail(user, '1', '501')).rejects.toMatchObject({ status: 503 });
    let reads = 0;
    const crossing = ordersService(fixture.db, undefined, undefined, () =>
      Date.parse(reads++ === 0 ? '2026-12-31T18:29:59Z' : '2026-12-31T18:30:30Z'),
    );
    await expect(crossing.detail(user, '1', '501')).rejects.toMatchObject({ status: 503 });
    await fixture.connection.query(
      "UPDATE orders SET created_at='2027-01-01 00:00:00' WHERE id=501",
    );
    const ordinary = ordersService(fixture.db, undefined, undefined, () =>
      Date.parse('2026-12-31T06:00:00Z'),
    );
    await expect(ordinary.detail(user, '1', '501')).rejects.toMatchObject({ status: 503 });
    await expect(
      atMidnight.detail(user, '1', '501', { from: '2026-12-31', to: '2026-12-31' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      atMidnight.detail(user, '1', '501', { from: '2027-01-01', to: '2027-01-01' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      atMidnight.detail(user, '1', '501', { from: '2026-12-30', to: '2026-12-30' }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('includes the exact future minute without a future publication and reconstructs original duplicate association rows', async () => {
    const now = Date.parse('2026-12-31T18:29:55Z'),
      defaults = sourceOrderDefaults(now, 'Asia/Kolkata');
    const input = orderSearchInput.parse({
      ...defaults.store,
      from: '2026-12-26',
      to: '2027-01-01',
      storeIds: ['1'],
      pageSize: 100,
    });
    const scope: SourceSearchScope = {
      contextStoreId: '1',
      checkedInStoreId: '1',
      allowedStores: ['1'],
      internal: true,
      globalReader: true,
      binding: 'synthetic',
      effectiveType: 'ST',
      selectedStores: ['1'],
      explicitIds: false,
      heLocationLabel: null,
    };
    const plan = sourceSearchReadPlan(input, 'Asia/Kolkata', now);
    expect(plan.historical?.to).toBe('2026-12-31');
    expect(plan.current?.reader).toBe('primary');
    const facts = await sourceNativeRepository(fixture.db).currentFacts(
      scope,
      input,
      plan.current!,
      20000,
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.stores).toHaveLength(2);
    const selected = sourceSelect(
      facts.map((value) => sourceIndex(value)),
      scope,
      input,
      { orderPhone: '', userPhone: '', email: '' },
    );
    const actual = selected.rows.map((row) => {
      const {
        rowKey: _key,
        actionStoreId: _store,
        ...value
      } = formatSourceOrder(
        facts.find((fact) => fact.id === row.index.id)!,
        scope,
        row.rowKey,
      );
      return value;
    });
    const original: unknown = JSON.parse(
      goldenStdout(
        'order-search',
        'default-range-mysql',
        JSON.stringify({
          url: fixture.url,
          cases: [
            {
              order_type: 'ST',
              'selected_stores[]': ['1'],
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
    );
    const expected = z
      .array(
        z.object({ response: z.object({ data: z.array(z.unknown()), recordsTotal: z.string() }) }),
      )
      .parse(original)[0]!.response;
    expect(selected.count).toBe(expected.recordsTotal);
    expect(actual).toEqual(expected.data);
    expect(actual).toHaveLength(4);
    const denied = await sourceNativeRepository(fixture.db).currentFacts(
      { ...scope, selectedStores: ['2'], allowedStores: ['2'] },
      input,
      plan.current!,
      20000,
    );
    expect(denied).toEqual([]);
  });
});
