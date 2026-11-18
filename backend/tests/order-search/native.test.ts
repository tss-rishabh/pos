import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { orderRange } from '../../src/modules/order-history/contracts.js';
import {
  orderSearchInput,
  sourceRowSchema,
  type OrderSearchRequest,
  type SourceSearchScope,
} from '../../src/modules/order-history/search/contracts.js';
import { formatSourceOrder } from '../../src/modules/order-history/search/format.js';
import { sourceNativeRepository } from '../../src/modules/order-history/search/native.js';
import { sourceIndex, sourceSelect } from '../../src/modules/order-history/search/reducer.js';
import { sourceQueueRepository } from '../../src/modules/order-history/search/queue.js';
import { orderSearchService } from '../../src/modules/order-history/search/service.js';
import { sourceSearchAuthority } from '../../src/modules/order-history/search/scope.js';
import type { Principal } from '../../src/domain/access.js';
import type { SourceHistorySearchPort } from '../../src/modules/order-history/search/warehouse.js';
import { readOrderSearchOptions } from '../../src/modules/order-history/search/options.js';
import {
  searchContactKeys,
  searchContactSelection,
} from '../../src/modules/order-history/search/contacts.js';
import { options as warehouseOptions, fact as warehouseFact } from './fixtures.js';
import { orderSearchFixture } from './mysql-fixture.js';
const template = process.env.ORDER_SEARCH_MYSQL_TEST_URL;
const now = Date.parse('2026-11-17T06:00:00Z'),
  range = orderRange({}, 'Asia/Kolkata', now);
const scope = (raw: OrderSearchRequest): SourceSearchScope => {
  const input = orderSearchInput.parse(raw);
  return {
    contextStoreId: '1',
    checkedInStoreId: '1',
    allowedStores: ['1', '2', '11'],
    internal: true,
    globalReader: true,
    binding: 'synthetic',
    effectiveType: input.inQueue || input.notPacked ? 'HL' : input.orderType,
    selectedStores: input.storeIds,
    explicitIds: !input.inQueue && !input.notPacked && input.orderIds.length > 0,
    heLocationLabel:
      input.orderType === 'HE' && input.storeIds.length
        ? 'L' + input.storeIds[0] + ' (Synthetic ' + input.storeIds[0] + ')'
        : null,
  };
};
const vectors: OrderSearchRequest[] = [
  { orderType: 'ST', storeIds: ['1'] },
  { orderType: 'ST', storeIds: ['1', '2'] },
  { orderType: 'ST', storeIds: ['2'] },
  { orderType: 'ST', orderIds: ['101', '102'] },
  { orderType: 'ST', storeIds: [] },
  { orderType: 'ST', storeIds: ['1'], pageSize: 2, page: 2 },
  { orderType: 'ST', storeIds: ['1'], page: 999 },
  { orderType: 'ST', storeIds: ['1'], paymentMethodIds: ['14'] },
  { orderType: 'ST', storeIds: ['1'], paymentStatusIds: ['4'] },
  { orderType: 'ST', storeIds: ['1'], orderStatusIds: ['3'] },
  { orderType: 'ST', storeIds: ['1'], search: '10' },
  { orderType: 'ST', storeIds: ['1'], search: '%' },
  { orderType: 'ST', storeIds: ['1'], search: '_007' },
  { orderType: 'ST', storeIds: ['1'], mobile: '555001' },
  { orderType: 'ST', storeIds: ['1'], mobile: '555007' },
  { orderType: 'ST', storeIds: ['1'], mobile: '555001', email: 'synthetic8@example.invalid' },
  { orderType: 'ST', storeIds: ['1'], email: 'SYNTHÉTIC7@example.invalid' },
  {
    orderType: 'ST',
    storeIds: ['1'],
    placedFrom: '2026-11-17 10:01:00',
    placedTo: '2026-11-17 10:03:00',
  },
  ...(
    [
      'id',
      'user_id',
      'user__firstname',
      'order_amt',
      'order_statuses',
      'created_at',
      'payment_methods__name',
      'payment_statuses__payment_status',
    ] as const
  ).flatMap((field) =>
    (['asc', 'desc'] as const).map((direction) => ({
      orderType: 'ST' as const,
      storeIds: ['1'],
      sort: { field, direction },
    })),
  ),
  { orderType: 'N' },
  { orderType: 'HL' },
  { orderType: 'HL', orderIds: ['201', '202'] },
  { orderType: 'HE', storeIds: ['1'] },
  { orderType: 'HE', storeIds: ['2'] },
  { orderType: 'ST', storeIds: ['1'], paymentStatusIds: ['0'] },
  { orderType: 'HL', inQueue: true },
  { orderType: 'HL', notPacked: true },
  { orderType: 'ST', inQueue: true, notPacked: true },
];
const original = z.object({
  response: z.object({
    draw: z.number(),
    recordsTotal: z.string(),
    recordsFiltered: z.string(),
    data: z.array(sourceRowSchema.omit({ rowKey: true, actionStoreId: true })),
  }),
  queries: z.number(),
});
describe.skipIf(!template)('pinned Django datatable and optimized native search', () => {
  let native: Awaited<ReturnType<typeof orderSearchFixture>>;
  beforeAll(async () => {
    native = await orderSearchFixture(template!);
    for (const id of ['1', '2', '11']) {
      await native.fixture.insert('stores', {
        id,
        store_name: 'Synthetic ' + id,
        location_code: 'L' + id,
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', {
        id,
        store_id: id,
        counter_name: 'Counter ' + id,
        is_active: 1,
      });
    }
    for (const [id, first, last, email, phone] of [
      ['7', 'Éclair', 'Synthetic', 'synthétic7@example.invalid', '555007'],
      ['8', 'Zebra', 'Synthetic', 'synthetic8@example.invalid', '555008'],
    ])
      await native.fixture.insert('users', {
        id: id!,
        firstname: first!,
        lastname: last!,
        email: email!,
        telephone: phone!,
      });
    for (const [id, label] of [
      ['0', 'Draft'],
      ['1', 'Order Placed'],
      ['3', 'Delivered'],
      ['4', 'Cancelled'],
      ['6', 'Returned'],
    ])
      await native.fixture.insert('order_status', {
        id: id!,
        order_status: label!,
        display_name: 'Different display',
      });
    for (const [id, label] of [
      ['1', 'Pending'],
      ['4', 'Paid'],
    ])
      await native.fixture.insert('payment_status', { id: id!, payment_status: label! });
    for (const [id, name] of [
      ['3', 'COD'],
      ['14', 'Cash'],
      ['16', 'Online'],
    ])
      await native.fixture.insert('payment_method', { id: id!, name: name! });
    for (const [id, owner, method, status, payment, minute, amount, location, kind, ref] of [
      ['101', '7', '14', '3', '4', '01', 120, '0', '', 'AB-CD-EF-GH'],
      ['102', '8', '14', '1', '1', '02', 300, '0', '', 'short'],
      ['103', '7', '16', '3', '4', '03', 12, '0', '', ''],
      ['104', '999', '3', '3', '1', '04', 12, '0', '', 'ORPHAN-USER'],
      ['105', '7', '14', '0', '1', '05', 0, '0', '', 'DRAFT'],
      ['106', '7', '3', '1', '0', '06', 30, '0', '', 'NULL-REL'],
      ['107', '7', '3', '3', '4', '07', 70, '0', '', 'NO-STORE'],
      ['201', '7', '3', '1', '1', '08', 20, '1', 'SW', 'HL-OWN'],
      ['202', '8', '3', '1', '1', '09', 20, '2', 'SW', 'HL-OTHER'],
      ['301', '7', '3', '3', '4', '10', 60, '1', 'SW', 'EXPRESS'],
      ['9007199254740993', '7', '14', '3', '4', '11', 9.75, '0', '', 'FULL-WIDTH'],
    ] as const)
      await native.fixture.insert('orders', {
        id,
        user_id: owner,
        payment_method: method,
        order_status: status,
        payment_status: payment,
        created_at: `2026-11-17 10:${minute}:00`,
        order_amt: amount,
        pay_amt: amount - 1,
        location_id: location === '0' ? null : location,
        location_type: kind,
        order_ref_no: ref,
        phone_no: id === '101' ? '555001' : '',
        is_global_order: id === '107' ? 1 : 0,
      });
    for (const [id, order, store, cash, other, manual, offline, shopify] of [
      ['1', '101', '1', 10, 2, 0, 1, 0],
      ['2', '101', '2', 5, 0, 1, 0, 1],
      ['3', '102', '1', 0, 0, 1, 0, 0],
      ['4', '102', '1', 0, 0, 1, 0, 0],
      ['5', '102', '2', 0, 0, 1, 0, 0],
      ['6', '103', '2', 0, 0, 1, 0, 0],
      ['7', '104', '1', 0, 0, 1, 0, 0],
      ['8', '105', '1', 0, 0, 1, 0, 0],
      ['9', '106', '1', 0, 0, 1, 0, 0],
      ['10', '9007199254740993', '1', 100, 0, 1, 0, 0],
    ] as const)
      await native.fixture.insert('order_stores', {
        id,
        order_id: order,
        store_id: store,
        counter_id: store,
        offline_payment: cash,
        online_other_payment: other,
        is_manually_paid: manual,
        is_offline_order: offline,
        is_shopify_order: shopify,
      });
    for (const [id, order, status] of [
      ['1', '101', 'DELIVERED'],
      ['2', '102', 'PROCESSING'],
      ['3', '102', 'PLACED'],
      ['4', '301', 'PRODUCT_RETURNED'],
    ])
      await native.fixture.insert('has_products', { id: id!, order_id: order!, status: status! });
    for (const [id, order, platform, active, mode, ref] of [
      ['1', '101', 'txn_created', 0, 1, 'inactive'],
      ['2', '101', 'TXN_CREATED', 1, 1, 'UPLOADED'],
      ['3', '101', 'txn_completed', 1, 10, 'COMPLETED'],
      ['4', '101', 'txn_cancelled', 1, 1, 'CANCELLED'],
      ['5', '102', 'txn_completed', 1, 999, 'FALLBACK'],
    ])
      await native.fixture.insert('pos_terminal_transactions', {
        id: String(id),
        order_id: String(order),
        platform: String(platform),
        is_active: Number(active),
        payment_mode: Number(mode),
        plutus_id: String(ref),
      });
    for (const [id, order, platform, active, mode, ref] of [
      ['1', '101', 'txn_created', 0, 1003, 'inactive'],
      ['2', '101', 'txn_created', 1, 1003, 'PAYTM-UP'],
      ['3', '102', 'txn_completed', 1, 1004, 'PAYTM-UPI'],
    ])
      await native.fixture.insert('pos_paytm_transactions', {
        id: String(id),
        order_id: String(order),
        platform: String(platform),
        is_active: Number(active),
        payment_mode: Number(mode),
        paytm_mid: String(ref),
      });
    for (const [id, store] of [
      ['1', '1'],
      ['2', '1'],
      ['3', '2'],
    ])
      await native.fixture.insert('express_line_item', {
        id: id!,
        order_id: '301',
        store_id: store!,
      });
    await native.fixture.insert('hyperlocal_order_log', {
      id: '1',
      order_id: '201',
      action: 'ACCEPTED',
      is_pack: 0,
      is_rto: 0,
      is_refunded: 0,
    });
  }, 40000);
  afterAll(async () => {
    await native?.close();
  });
  it('matches the captured original response for the first source vector in real MySQL', async () => {
    // Captured pinned-source datatable response for vectors[0]; the other 42 vectors
    // had no capture when the Python oracle was removed (see parity/w2-followups.md).
    const captured = z
      .object({ response: original.shape.response })
      .passthrough()
      .parse(
        JSON.parse(
          readFileSync('../frontend/tests/order-search/source-snapshot.json', 'utf8'),
        ) as unknown,
      );
    const reader = sourceNativeRepository(native.db);
    for (let index = 0; index < 1; index++) {
      const raw = vectors[index]!,
        input = orderSearchInput.parse(raw),
        selection = scope(raw),
        queue =
          input.inQueue || input.notPacked
            ? await sourceQueueRepository(native.db)(selection, input)
            : undefined,
        result = await reader.search(
          selection,
          input,
          range,
          queue?.orders.map((row) => row.id),
        );
      const data = result.rows.map((row) => {
        const {
          rowKey: _rowKey,
          actionStoreId: _action,
          ...value
        } = formatSourceOrder(row.fact, selection, row.rowKey);
        return value;
      });
      expect(
        { draw: input.draw, recordsTotal: result.count, recordsFiltered: result.count, data },
        'source vector ' + index,
      ).toEqual(captured.response);
    }
  }, 30000);
  it('preserves the original reverse-join multiplication and raw-case HasProduct revert rule', async () => {
    const input = orderSearchInput.parse({ orderType: 'ST', storeIds: ['1'] }),
      result = await sourceNativeRepository(native.db).search(scope(input), input, range);
    expect(result.rows.filter((row) => row.fact.id === '101')).toHaveLength(2);
    expect(result.rows.filter((row) => row.fact.id === '102')).toHaveLength(6);
    expect(result.rows.find((row) => row.fact.id === '102')!.fact.isRevert).toBe(false);
    expect(result.rows.find((row) => row.fact.id === '104')!.fact.isRevert).toBe(true);
  });
  it('historical reducer matches native collation ordering, multiplicity and page fallback on the same facts', async () => {
    const reader = sourceNativeRepository(native.db),
      all = await reader.facts(scope({ orderType: 'ST', orderIds: ['101'] }), range, [
        '101',
        '102',
        '103',
        '104',
        '106',
        '9007199254740993',
        '201',
        '202',
        '301',
      ]);
    for (const raw of vectors.filter(
      (value) => value.orderType === 'ST' && !value.mobile && !value.email,
    )) {
      const input = orderSearchInput.parse(raw),
        selection = scope(raw),
        queue =
          input.inQueue || input.notPacked
            ? await sourceQueueRepository(native.db)(selection, input)
            : undefined,
        expected = await reader.search(
          selection,
          input,
          range,
          queue?.orders.map((row) => row.id),
        ),
        actual = sourceSelect(
          all.map((value) => sourceIndex(value)),
          selection,
          input,
          { orderPhone: '', userPhone: '', email: '' },
          queue ? new Set(queue.orders.map((row) => row.id)) : undefined,
        );
      expect(actual.count).toBe(expected.count);
      expect(actual.rows.map((row) => row.rowKey)).toEqual(expected.rows.map((row) => row.rowKey));
    }
  }, 15000);
  it('uses actual Latin1/utf8mb3 weights for historical phone/email equality instead of LOWER substitutions', async () => {
    const reader = sourceNativeRepository(native.db, searchContactKeys(warehouseOptions)),
      all = await reader.facts(scope({ orderType: 'ST', orderIds: ['101'] }), range, [
        '101',
        '102',
        '103',
        '104',
        '106',
        '9007199254740993',
      ]),
      weights = searchContactSelection(native.db, warehouseOptions);
    for (const raw of [
      ...vectors.filter((value) => value.mobile || value.email),
      { orderType: 'ST' as const, storeIds: ['1'], mobile: '555001 ' },
      { orderType: 'ST' as const, storeIds: ['1'], email: 'SYNTHETIC7@EXAMPLE.INVALID   ' },
    ]) {
      const input = orderSearchInput.parse(raw),
        selection = scope(raw),
        expected = await reader.search(selection, input, range),
        actual = sourceSelect(
          all.map((value) => sourceIndex(value)),
          selection,
          input,
          await weights(input),
        );
      expect(actual.count).toBe(expected.count);
      expect(actual.rows.map((row) => row.rowKey)).toEqual(expected.rows.map((row) => row.rowKey));
    }
  });
  it('checks candidate association/provider/queue indexes with representative local EXPLAINs', async () => {
    const proposals = [
      [
        'order_stores',
        'ix_candidate_order_store',
        '(order_id,store_id,id)',
        'SELECT id FROM order_stores WHERE order_id=101 AND store_id=1 ORDER BY id',
      ],
      [
        'orders',
        'ix_candidate_order_date',
        '(created_at,id)',
        "SELECT id FROM orders WHERE created_at>='2026-11-17 00:00:00' AND created_at<'2026-11-18 00:00:00' ORDER BY created_at,id",
      ],
      [
        'pos_terminal_transactions',
        'ix_candidate_provider_order',
        '(order_id,is_active,platform,id)',
        "SELECT id FROM pos_terminal_transactions WHERE order_id=101 AND is_active=1 AND platform='txn_created' ORDER BY id",
      ],
      [
        'hyperlocal_order_log',
        'ix_candidate_queue',
        '(order_id,action,is_pack,is_rto,is_refunded)',
        "SELECT id FROM hyperlocal_order_log WHERE order_id=201 AND action='ACCEPTED' AND is_pack=0 AND is_rto=0 AND is_refunded=0",
      ],
    ] as const;
    for (const [table, index, columns, query] of proposals) {
      const [before] = await native.connection.query(query);
      await native.connection.query(`CREATE INDEX ${index} ON ${table} ${columns}`);
      const [after] = await native.connection.query(query);
      expect(after).toEqual(before);
      const [explained] = await native.connection.query(
        `EXPLAIN SELECT * FROM (${query.replace('FROM ' + table, 'FROM ' + table + ' FORCE INDEX (' + index + ')')}) AS candidate_fixture`,
      );
      expect(JSON.stringify(explained)).toContain(index);
    }
  });
  const actor: Principal = {
    id: '1',
    role: 2,
    userType: 1,
    storeIds: ['1'],
    name: 'Synthetic operator',
    email: '',
  };
  async function currentActor() {
    await native.connection.query('DELETE FROM pos_user');
    await native.connection.query('DELETE FROM user_stores');
    await native.connection.query('DELETE FROM pos_rewrite_operator_checkins');
    await native.fixture.insert('pos_user', {
      id: '1',
      username: 'synthetic',
      password: 'synthetic-password-hash',
      role: 2,
      user_type: 1,
      is_active: 1,
    });
    await native.fixture.insert('user_stores', { id: '1', django_user_id: '1', store_id: '1' });
    await native.connection.query(
      "INSERT INTO pos_rewrite_operator_checkins(operator_id,store_id,counter_id,expires_at,checked_in_at) VALUES('1',1,NULL,'2099-01-01 00:00:00','2026-11-17 00:00:00')",
    );
  }
  it('uses writer-current store/type authority even with IDs and denies franchise online bypass', async () => {
    await currentActor();
    const capture = sourceSearchAuthority(native.config, native.db);
    await expect(
      capture(actor, '1', orderSearchInput.parse({ storeIds: ['2'], orderIds: ['101'] })),
    ).rejects.toMatchObject({ code: 'ORDER_SEARCH_SCOPE_DENIED' });
    await native.connection.query('UPDATE pos_user SET role=1,user_type=2 WHERE id=1');
    await native.connection.query("UPDATE stores SET category='FRANCHISE' WHERE id=1");
    await expect(
      capture(
        { ...actor, role: 1, userType: 2 },
        '1',
        orderSearchInput.parse({ orderType: 'N', orderIds: ['107'] }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_SEARCH_SCOPE_DENIED' });
    await native.connection.query("UPDATE stores SET category='IN_HOUSE' WHERE id=1");
    await currentActor();
  });
  it('retains concrete source bypass evidence while requiring store/Express ownership for explicit IDs', async () => {
    await currentActor();
    const cases: OrderSearchRequest[] = [
      { orderType: 'ST', orderIds: ['103'] },
      { orderType: 'HE', storeIds: ['1'], orderIds: ['101'] },
    ];
    const capture = sourceSearchAuthority(native.config, native.db),
      reader = sourceNativeRepository(native.db);
    for (const raw of cases) {
      const input = orderSearchInput.parse(raw),
        selection = await capture(actor, '1', input);
      expect((await reader.search(selection, input, range)).count).toBe('0');
    }
  });
  it('documents and corrects a split order substituting another store counter/payment flags', async () => {
    await currentActor();
    await native.connection.query(
      'UPDATE order_stores SET store_id=IF(id=1,2,1),counter_id=IF(id=1,2,1) WHERE id IN(1,2)',
    );
    try {
      const raw: OrderSearchRequest = { orderType: 'ST', storeIds: ['1'], orderIds: ['101'] },
        input = orderSearchInput.parse(raw);
      const selection = await sourceSearchAuthority(native.config, native.db)(actor, '1', input),
        result = await sourceNativeRepository(native.db).search(selection, input, range);
      for (const row of result.rows) {
        const value = formatSourceOrder(row.fact, selection, row.rowKey);
        expect(value.store_name).toBe('Synthetic 1 (Counter 1)');
        expect(value.is_offline_order).toBe(false);
        expect(value.actionStoreId).toBe('1');
      }
    } finally {
      await native.connection.query(
        'UPDATE order_stores SET store_id=IF(id=1,1,2),counter_id=IF(id=1,1,2) WHERE id IN(1,2)',
      );
    }
  });
  it('corrects substring transfer leakage and refuses unproven warehouse/store ID coincidence', async () => {
    const discover = sourceQueueRepository(native.db),
      selection = scope({ orderType: 'HL', inQueue: true }),
      input = orderSearchInput.parse({ orderType: 'HL', inQueue: true });
    await native.connection.query(
      "UPDATE orders SET is_transfer=1,next_location_ids='[11]' WHERE id=202",
    );
    expect((await discover(selection, input)).orders.map((row) => row.id)).not.toContain('202');
    await native.connection.query("UPDATE orders SET next_location_ids='[1,11]' WHERE id=202");
    expect((await discover(selection, input)).orders.map((row) => row.id)).toContain('202');
    await native.fixture.insert('hyperlocal_locations', {
      id: '1',
      store_id: '2',
      location_code: 'OTHER-WH',
    });
    await native.connection.query("UPDATE orders SET location_type='NW' WHERE id=201");
    await expect(discover(selection, input)).rejects.toMatchObject({
      code: 'ORDER_SEARCH_DATA_INVALID',
    });
    await native.connection.query("UPDATE orders SET location_type='SW' WHERE id=201");
    await native.connection.query(
      'UPDATE orders SET is_transfer=0,next_location_ids=NULL WHERE id=202',
    );
  });
  it('routes every old live-queue fact through BigQuery and fails the full queue on missing evidence', async () => {
    await currentActor();
    await native.connection.query(
      "UPDATE orders SET created_at='2026-11-16 10:00:00' WHERE id=201",
    );
    const calls: string[] = [];
    const missing: SourceHistorySearchPort = {
      async range() {
        throw new Error('Unexpected range');
      },
      async ids(_scope, ids, cutoff) {
        calls.push(...ids);
        expect(cutoff).toBe('2026-11-17 00:00:00');
        return {
          indexes: [],
          generationId: '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
          async facts() {
            return [];
          },
        };
      },
    };
    const service = orderSearchService(native.config, native.db, readOrderSearchOptions({}), {
      history: missing,
      clock: () => now,
    });
    await expect(
      service.search(actor, '1', {
        inQueue: true,
        orderIds: ['101'],
        from: '2026-11-01',
        to: '2026-11-01',
      }),
    ).rejects.toMatchObject({ code: 'ORDER_QUEUE_HISTORY_UNAVAILABLE' });
    expect(calls).toEqual(['201']);
    await native.connection.query(
      "UPDATE orders SET created_at='2026-11-17 10:08:00' WHERE id=201",
    );
  });
  it('combines immutable old header facts with revalidated live queue status and location dimensions', async () => {
    await currentActor();
    await native.connection.query(
      "UPDATE orders SET created_at='2026-11-16 10:00:00' WHERE id=201",
    );
    try {
      const fact = {
        ...warehouseFact,
        id: '201',
        stores: [],
        locationId: '2',
        locationType: 'SW',
        locationStoreId: '2',
        locationLabel: 'L2 (Synthetic 2)',
      };
      const history: SourceHistorySearchPort = {
        async range() {
          throw new Error('Unexpected range');
        },
        async ids() {
          return {
            indexes: [sourceIndex(fact)],
            generationId: '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
            async facts() {
              return [fact];
            },
          };
        },
      };
      const response = await orderSearchService(
        native.config,
        native.db,
        readOrderSearchOptions({}),
        { history, clock: () => now },
      ).search(actor, '1', { inQueue: true, orderStatusIds: ['1'] });
      expect(response.reader).toBe('mixed');
      expect(response.data[0]).toMatchObject({
        id: '201',
        location_code: 'L1 (Synthetic 1)',
        order_statuses: 'Order Placed',
        order_amt: warehouseFact.orderAmount,
        pay_amount: warehouseFact.payAmount,
      });
    } finally {
      await native.connection.query(
        "UPDATE orders SET created_at='2026-11-17 10:08:00' WHERE id=201",
      );
    }
  });
  it('returns the source contradictory empty store selection without fabricating a warehouse result', async () => {
    await currentActor();
    let calls = 0;
    const history: SourceHistorySearchPort = {
      async range() {
        calls++;
        throw new Error('No selected store must not query facts.');
      },
      async ids() {
        calls++;
        throw new Error('No selected store must not query facts.');
      },
    };
    const result = await orderSearchService(native.config, native.db, readOrderSearchOptions({}), {
      history,
      clock: () => now,
    }).search(actor, '1', { orderType: 'ST', storeIds: [], from: '2026-11-16', to: '2026-11-16' });
    expect(result).toMatchObject({
      emptySelection: true,
      recordsTotal: '0',
      data: [],
      generationId: null,
    });
    expect(calls).toBe(0);
  });
  it('rechecks assignments after asynchronous history and never returns stale-scope facts', async () => {
    await currentActor();
    const history: SourceHistorySearchPort = {
      async ids() {
        throw new Error('Unexpected point');
      },
      async range() {
        await native.connection.query('DELETE FROM user_stores WHERE django_user_id=1');
        return {
          indexes: [],
          generationId: '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
          async facts() {
            return [];
          },
        };
      },
    };
    const service = orderSearchService(native.config, native.db, readOrderSearchOptions({}), {
      history,
      clock: () => now,
    });
    await expect(
      service.search(actor, '1', { storeIds: ['1'], from: '2026-11-16', to: '2026-11-16' }),
    ).rejects.toMatchObject({ status: 403 });
    await currentActor();
  });
});
