import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { Temporal } from '@js-temporal/polyfill';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orderSearchFixture } from '../order-search/mysql-fixture.js';
import { onlineOrderDetailService } from '../../src/modules/order-history/online-detail/service.js';
import { onlineOrderDetail } from '../../src/modules/order-history/online-detail/contracts.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import type { Principal } from '../../src/domain/access.js';
import { splitMigration } from '../../src/db/migrations.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { buildApp } from '../../src/app.js';
import { readNativeOnlineDetail } from '../../src/modules/order-history/online-detail/native.js';
import { orderRange } from '../../src/modules/order-history/contracts.js';
import { goldenStdout } from '../golden/load.js';
import { fixturePlaceholders } from '../golden/fixture-placeholders.js';

const connection = process.env.ORDER_SEARCH_MYSQL_TEST_URL;
describe.skipIf(!connection)('native source-family order details', () => {
  let native: Awaited<ReturnType<typeof orderSearchFixture>>,
    app: Awaited<ReturnType<typeof buildApp>>;
  let today: string, yesterday: string, now: number;
  let preview:
    | Awaited<
        ReturnType<typeof import('../../../frontend/node_modules/vite/dist/node/index.js').preview>
      >
    | undefined;
  let browserOrigin: string | undefined;
  const user: Principal = {
    id: '9',
    role: 1,
    userType: 1,
    name: 'Synthetic operator',
    email: 'operator@example.invalid',
    storeIds: ['1'],
  };
  beforeAll(async () => {
    native = await orderSearchFixture(connection!);
    await native.fixture.create([
      'products',
      'order_platform',
      'pos_transaction_logs',
      'hyperlocal_fd_logs',
      'user_eav',
    ]);
    for (const path of [
      'migrations/0002_auth_sessions.sql',
      'migrations/0003_login_challenges.sql',
      'src/modules/administration/mfa-migration.sql',
    ])
      for (const statement of splitMigration(readFileSync(path, 'utf8')))
        await native.connection.query(statement);
    for (const id of [1, 2]) {
      await native.fixture.insert('stores', {
        id,
        store_name: 'Synthetic detail store ' + id,
        location_code: 'SYN' + id,
        is_active: 1,
        type: 'STORE',
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', {
        id,
        store_id: id,
        counter_name: 'Synthetic detail counter ' + id,
        is_active: 1,
      });
    }
    await native.fixture.insert('pos_user', {
      id: 9,
      role: 1,
      user_type: 1,
      is_active: 1,
      is_staff: 1,
      username: 'synthetic-detail-operator',
    });
    await native.fixture.insert('users', {
      id: 7,
      firstname: 'Synthetic',
      lastname: 'Customer',
      email: 'customer@example.invalid',
      telephone: '555007',
      tss_money: 0.49,
      tss_points: 25.49,
    });
    await native.fixture.insert('user_eav', {
      entity: 'customer@example.invalid',
      attribute: 'EXCLUSIVE_EXPIRY',
      value: '2027-12-31T23:59:00',
      is_active: 1,
    });
    await native.fixture.insert('products', {
      id: 101,
      product: 'Synthetic detail product',
      parent_prod_id: 0,
    });
    await native.fixture.insert('order_platform', {
      id: 1,
      name: 'Standard',
      platform: 'STANDARD',
    });
    await native.fixture.insert('order_platform', {
      id: 4,
      name: 'Hyperlocal',
      platform: 'HYPERLOCAL',
    });
    await native.fixture.insert('order_platform', { id: 5, name: 'Express', platform: 'EXPRESS' });
    for (const [id, label] of [
      [1, 'Order Placed'],
      [3, 'Delivered'],
    ] as const)
      await native.fixture.insert('order_status', { id, order_status: label, display_name: label });
    await native.fixture.insert('payment_status', { id: 4, payment_status: 'Paid' });
    await native.fixture.insert('payment_method', { id: 14, name: 'Cash' });
    now = Date.now();
    const day = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO('Asia/Kolkata')
      .toPlainDate();
    today = day.toString();
    yesterday = day.subtract({ days: 1 }).toString();
    for (const [id, type, date] of [
      [501, 'N', today],
      [502, 'HL', today],
      [503, 'HE', today],
      [504, 'N', yesterday],
    ] as const) {
      await native.fixture.insert('orders', {
        id,
        user_id: 7,
        order_ref_no: 'SYN-DETAIL-' + id,
        order_status: 3,
        payment_status: 4,
        payment_method: 14,
        created_at: date + ' 10:00:00',
        order_amt: 120.49,
        pay_amt: 119.49,
        tss_money_used: 1,
        tss_points_used: 0.01,
        voucher_amt_used: null,
        coupon_amt_used: 0,
        location_id: type === 'HL' ? 1 : null,
        location_type: type === 'HL' ? 'SW' : '',
        next_location_ids: '',
        is_transfer: 0,
        is_split_order: 0,
        is_global_order: 0,
        hl_parent_order_id: 0,
      });
      await native.fixture.insert('has_products', {
        id,
        order_id: id,
        prod_id: 101,
        qty: 2,
        price: 59.745,
        gst: 5,
        status: 'PLACED',
        order_platform_id: type === 'HE' ? 5 : type === 'HL' ? 4 : 1,
      });
    }
    await native.fixture.insert('orders', {
      id: '9007199254740993',
      user_id: 7,
      order_ref_no: 'SYN-WIDE-DETAIL',
      order_status: 3,
      payment_status: 4,
      payment_method: 14,
      created_at: today + ' 10:00:00',
      order_amt: 25.49,
      pay_amt: 25.49,
      location_id: null,
      location_type: '',
      next_location_ids: '',
      is_transfer: 0,
      is_split_order: 0,
      is_global_order: 0,
      hl_parent_order_id: 0,
    });
    await native.fixture.insert('has_products', {
      id: '9007199254740995',
      order_id: '9007199254740993',
      prod_id: 101,
      qty: 1,
      price: 25.49,
      gst: 5,
      status: 'PLACED',
      order_platform_id: 1,
    });
    await native.fixture.insert('express_line_item', {
      id: 1,
      order_id: 503,
      has_product_id: 503,
      store_id: 1,
      status: 'ACCEPTED',
    });
    await native.fixture.insert('pos_transaction_logs', {
      id: 1,
      order_id: 501,
      store_id: 1,
      order_status: 3,
      payment_status: 4,
      user_id: 7,
      pos_user_id: 9,
      pay_dict: "{'Cash': 119.49, 'tss money': 1.0}",
      comment: 'Synthetic payment recorded',
      created_at: today + ' 11:00:00',
    });
    await checkInService(native.db, native.config).set(user, '1', '1');
    if (process.env.ORDER_DETAIL_BROWSER_TEST === 'true') {
      const reservation = createServer();
      await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
      const address = reservation.address();
      if (!address || typeof address === 'string')
        throw new Error('Owned browser port unavailable');
      browserOrigin = `http://127.0.0.1:${address.port}`;
      await new Promise<void>((done, reject) =>
        reservation.close((error) => (error ? reject(error) : done())),
      );
      app = await buildApp({ ...native.config, WEB_ORIGIN: browserOrigin }, { logger: false });
      const apiOrigin = await app.listen({ host: '127.0.0.1', port: 0 });
      const vite = await import('../../../frontend/node_modules/vite/dist/node/index.js');
      preview = await vite.preview({
        root: '../frontend',
        configFile: '../frontend/vite.config.ts',
        preview: {
          host: '127.0.0.1',
          port: address.port,
          strictPort: true,
          proxy: {
            '/api': { target: apiOrigin, ws: true },
            '/ws': { target: apiOrigin, ws: true },
          },
        },
      });
    } else app = await buildApp(native.config, { logger: false });
  });
  afterAll(async () => {
    await preview?.close();
    await app?.close();
    await native?.close();
  });
  async function cookie() {
    const sessions = mysqlSessions(native.db);
    const value = await sessions.create(user.id, Date.now() + 600000);
    return 'pos_session=' + seal({ id: user.id, ...value }, native.config.SESSION_SECRET);
  }
  it('reads an N order with no fabricated store association, exact line money and bound current customer', async () => {
    const detail = await onlineOrderDetailService(native.config, native.db, {
      clock: () => now,
    }).read(user, '1', '501', { type: 'N' });
    expect(detail).toMatchObject({
      type: 'N',
      storeId: '1',
      reader: 'primary',
      publication: null,
      fact: {
        orderId: '501',
        customerId: '7',
        amount: '120.49',
        payAmount: '119.49',
        storeIds: [],
        lines: [{ id: '501', productId: '101', quantity: '2', amount: '59.745', gst: '5' }],
      },
      customer: {
        freshness: 'current',
        id: '7',
        money: '0.49',
        points: '25.49',
        membership: { active: true },
      },
    });
    expect(detail.fact.timeline).toHaveLength(2);
    expect(detail.fact.timeline[1]?.payments).toEqual([
      { method: 'Cash', value: '119.49' },
      { method: 'tss money', value: '1.0' },
    ]);
  });
  it('matches literal original timeline and native source line/wallet values on the same physical fixture', async () => {
    const detail = await onlineOrderDetailService(native.config, native.db, {
      clock: () => now,
    }).read(user, '1', '501', { type: 'N' });
    const result = z
      .object({
        amount: z.number(),
        payAmount: z.number(),
        customerId: z.string(),
        wallet: z.object({ money: z.string(), points: z.string() }),
        lines: z.array(z.record(z.string(), z.unknown())),
        timeline: z.array(
          z.object({
            comment: z.string(),
            createdAt: z.string(),
            payments: z.record(z.string(), z.unknown()),
          }),
        ),
      })
      .parse(
        JSON.parse(
          goldenStdout(
            'order-history',
            'online-detail-mysql.timeline',
            JSON.stringify({ url: native.url, orderId: '501' }),
            undefined,
            fixturePlaceholders(native.url),
          ),
        ) as unknown,
      );
    expect(Number(detail.fact.amount)).toBe(result.amount);
    expect(Number(detail.fact.payAmount)).toBe(result.payAmount);
    expect(detail.fact.customerId).toBe(result.customerId);
    expect({ money: detail.customer.money, points: detail.customer.points }).toEqual(result.wallet);
    expect(
      detail.fact.lines.map(({ express: _express, ...line }) => ({
        ...line,
        parentProductId: detail.products.items.find((product) => product.id === line.productId)!
          .parentId,
        name: detail.products.items.find((product) => product.id === line.productId)!.name,
        amount: Number(line.amount),
        gst: Number(line.gst),
      })),
    ).toEqual(result.lines);
    expect(
      detail.fact.timeline.map((event) => ({
        comment: event.comment,
        createdAt: event.createdAt,
        payments: Object.fromEntries(
          event.payments.map((payment) => [
            payment.method,
            payment.value === null
              ? null
              : /^-?[0-9]+(?:\.[0-9]+)?$/.test(payment.value)
                ? Number(payment.value)
                : payment.value,
          ]),
        ),
      })),
    ).toEqual(result.timeline);
  });
  it('reads current product names/parent SKU separately from qualified historical and HP financial values', async () => {
    const range = orderRange({ from: yesterday, to: yesterday }, 'Asia/Kolkata', now);
    // Owned publication snapshot preparation, not an application historical fallback.
    const archived = await native.db
      .get('primary')
      .transaction((tx) => readNativeOnlineDetail(tx, '504', { ...range, reader: 'primary' }), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    if (!archived) throw new Error('Owned historical snapshot unavailable');
    expect(archived.lines[0]).not.toHaveProperty('name');
    expect(archived.lines[0]).not.toHaveProperty('parentProductId');
    await native.fixture.insert('products', {
      id: 102,
      product: 'Synthetic current parent',
      parent_prod_id: 0,
    });
    try {
      await native.connection.query(
        "UPDATE products SET product='Renamed current product',parent_prod_id=102,price=999,gst=18 WHERE id=101",
      );
      await native.connection.query('UPDATE orders SET order_amt=777,pay_amt=888 WHERE id=504');
      await native.connection.query('UPDATE has_products SET price=888,gst=99 WHERE order_id=504');
      const current = await onlineOrderDetailService(native.config, native.db, {
        clock: () => now,
      }).read(user, '1', '501', { type: 'N' });
      expect(current.products).toMatchObject({
        freshness: 'current',
        items: [{ id: '101', parentId: '102', name: 'Renamed current product' }],
      });
      expect(current.fact.lines[0]).toMatchObject({ amount: '59.745', gst: '5' });
      const at = new Date(now).toISOString();
      const historical = await onlineOrderDetailService(native.config, native.db, {
        clock: () => now,
        history: {
          read: async () => ({
            fact: archived,
            publication: {
              generationId: '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
              sourceSnapshotId: 'owned-dimension-contract-boundary',
              sourceSnapshotAt: at,
              sourceCdcWatermark: at,
              publishedAt: at,
            },
          }),
        },
      }).read(user, '1', '504', { type: 'N', from: yesterday, to: yesterday });
      expect(historical.reader).toBe('bigquery');
      expect(historical.products.items[0]).toMatchObject({
        name: 'Renamed current product',
        parentId: '102',
      });
      expect(historical.fact).toMatchObject({
        amount: '120.49',
        payAmount: '119.49',
        lines: [{ amount: '59.745', gst: '5' }],
      });
      const source = z
        .object({
          lines: z.array(
            z.object({
              name: z.string(),
              parentProductId: z.string(),
              amount: z.number(),
              gst: z.number(),
            }),
          ),
        })
        .parse(
          JSON.parse(
            goldenStdout(
              'order-history',
              'online-detail-mysql.current-names',
              JSON.stringify({ url: native.url, orderId: '501' }),
              undefined,
              fixturePlaceholders(native.url),
            ),
          ) as unknown,
        );
      expect(source.lines[0]).toEqual({
        name: 'Renamed current product',
        parentProductId: '102',
        amount: 59.745,
        gst: 5,
      });
    } finally {
      await native.connection.query(
        "UPDATE products SET product='Synthetic detail product',parent_prod_id=0,price=0,gst=0 WHERE id=101",
      );
      await native.connection.query(
        'UPDATE orders SET order_amt=120.49,pay_amt=119.49 WHERE id=504',
      );
      await native.connection.query(
        'UPDATE has_products SET price=59.745,gst=5 WHERE order_id=504',
      );
      await native.connection.query('DELETE FROM products WHERE id=102');
    }
  });
  it('rechecks current customer and actor authority after an external historical-read boundary', async () => {
    const range = orderRange({ from: yesterday, to: yesterday }, 'Asia/Kolkata', now);
    const fact = await native.db
      .get('primary')
      .transaction((tx) => readNativeOnlineDetail(tx, '504', { ...range, reader: 'primary' }), {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      });
    if (!fact) throw new Error('Owned historical snapshot unavailable');
    const at = new Date(now).toISOString(),
      publication = {
        generationId: '4918d168-c62e-4ed7-b8ae-89b0a5e70019',
        sourceSnapshotId: 'owned-authority-contract-boundary',
        sourceSnapshotAt: at,
        sourceCdcWatermark: at,
        publishedAt: at,
      };
    try {
      const rebound = onlineOrderDetailService(native.config, native.db, {
        clock: () => now,
        history: {
          read: async () => {
            await native.connection.query('UPDATE orders SET user_id=8 WHERE id=504');
            return { fact, publication };
          },
        },
      });
      await expect(rebound.read(user, '1', '504', { type: 'N' })).rejects.toMatchObject({
        status: 403,
        code: 'ORDER_DETAIL_SCOPE_CHANGED',
      });
      await native.connection.query('UPDATE orders SET user_id=7 WHERE id=504');
      const revoked = onlineOrderDetailService(native.config, native.db, {
        clock: () => now,
        history: {
          read: async () => {
            await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=9');
            return { fact, publication };
          },
        },
      });
      await expect(revoked.read(user, '1', '504', { type: 'N' })).rejects.toMatchObject({
        status: 401,
      });
    } finally {
      await native.connection.query('UPDATE orders SET user_id=7 WHERE id=504');
      await native.connection.query('UPDATE pos_user SET is_active=1 WHERE id=9');
    }
  });
  it('includes only the active store-page N midnight endpoint, preserving explicit calendar validation', async () => {
    const tomorrow = Temporal.PlainDate.from(today).add({ days: 1 }).toString();
    await native.fixture.insert('orders', {
      id: 505,
      user_id: 7,
      order_ref_no: 'SYN-MIDNIGHT-DETAIL',
      order_status: 3,
      payment_status: 4,
      payment_method: 14,
      created_at: tomorrow + ' 00:00:00',
      order_amt: 25.49,
      pay_amt: 25.49,
      location_id: null,
      location_type: '',
      next_location_ids: '',
      is_transfer: 0,
      is_split_order: 0,
      is_global_order: 0,
      hl_parent_order_id: 0,
    });
    const clock = Temporal.PlainDate.from(today)
      .toPlainDateTime('23:59:55')
      .toZonedDateTime('Asia/Kolkata').epochMilliseconds;
    const service = onlineOrderDetailService(native.config, native.db, { clock: () => clock });
    expect((await service.read(user, '1', '505', { type: 'N' })).fact.createdAt).toBe(
      tomorrow + ' 00:00:00',
    );
    await native.connection.query('UPDATE orders SET created_at=? WHERE id=505', [
      tomorrow + ' 00:00:01',
    ]);
    await expect(service.read(user, '1', '505', { type: 'N' })).rejects.toMatchObject({
      code: 'ORDER_DETAIL_PUBLICATION_REQUIRED',
    });
    await expect(
      service.read(user, '1', '505', { type: 'N', from: today, to: tomorrow }),
    ).rejects.toMatchObject({ status: 400 });
    await native.connection.query('DELETE FROM orders WHERE id=505');
  });
  it('uses actual native sessions and HTTP route validation without an injected principal/service', async () => {
    const session = await cookie();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/stores/1/orders/501/details?type=N',
      headers: { cookie: session, 'x-operator-id': '9' },
    });
    expect(response.statusCode).toBe(200);
    expect(onlineOrderDetail.parse(response.json()).fact.orderId).toBe('501');
    expect(response.headers['cache-control']).toBe('no-store');
    for (const query of ['type=ST', 'type=N&customerId=8', 'type=N&from=' + today])
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/api/v1/stores/1/orders/501/details?' + query,
            headers: { cookie: session, 'x-operator-id': '9' },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/stores/1/orders/501/details?type=N',
          headers: { cookie: session, 'x-operator-id': '10' },
        })
      ).statusCode,
    ).toBe(409);
  });
  it('requires actual delivery type, current check-in and owning store for HL/HE', async () => {
    const service = onlineOrderDetailService(native.config, native.db, { clock: () => now });
    expect((await service.read(user, '1', '502', { type: 'HL' })).fact.delivery.ownerStoreId).toBe(
      '1',
    );
    expect(
      (await service.read(user, '1', '503', { type: 'HE' })).fact.lines[0]?.express[0]?.storeId,
    ).toBe('1');
    await expect(service.read(user, '1', '501', { type: 'HL' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.read(user, '2', '502', { type: 'HL' })).rejects.toMatchObject({
      status: 409,
    });
    await native.connection.query(
      "UPDATE pos_rewrite_operator_checkins SET expires_at='2000-01-01 00:00:00' WHERE operator_id='9'",
    );
    await expect(service.read(user, '1', '503', { type: 'HE' })).rejects.toMatchObject({
      status: 409,
    });
    await checkInService(native.db, native.config).set(user, '1', '1');
  });
  it('refuses unavailable historical details rather than reading their order amounts or lines from MySQL', async () => {
    const service = onlineOrderDetailService(native.config, native.db, { clock: () => now });
    await expect(service.read(user, '1', '504', { type: 'N' })).rejects.toMatchObject({
      status: 503,
      code: 'ORDER_DETAIL_PUBLICATION_REQUIRED',
    });
    await expect(
      service.read(user, '1', '504', { type: 'N', from: yesterday, to: yesterday }),
    ).rejects.toMatchObject({ status: 503, code: 'ORDER_DETAIL_PUBLICATION_REQUIRED' });
    await expect(
      service.read(user, '1', '504', { type: 'N', from: today, to: today }),
    ).rejects.toMatchObject({ status: 404 });
    await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=9');
    await expect(service.read(user, '1', '501', { type: 'N' })).rejects.toMatchObject({
      status: 401,
    });
    await native.connection.query('UPDATE pos_user SET is_active=1 WHERE id=9');
  });
  it.skipIf(process.env.ORDER_DETAIL_BROWSER_TEST !== 'true')(
    'loads actual routed App with native cookie, exact wide IDs, reload/new tab and closed workspace guards',
    async () => {
      if (!browserOrigin) throw new Error('Native browser fixture unavailable');
      const { chromium } = await import('../../../frontend/node_modules/playwright-core/index.js');
      const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      const executablePath =
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
        (process.platform === 'darwin' && existsSync(chrome) ? chrome : undefined);
      const browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
      try {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const session = (await cookie()).slice('pos_session='.length);
        await context.addCookies([
          {
            name: 'pos_session',
            value: session,
            url: browserOrigin,
            httpOnly: true,
            sameSite: 'Lax',
          },
        ]);
        const page = await context.newPage();
        let detailRequests = 0;
        page.on('request', (request) => {
          if (
            new URL(request.url()).pathname.endsWith('/details') &&
            new URL(request.url()).pathname.startsWith('/api/')
          )
            detailRequests++;
        });
        const path = '/orders/details/N/9007199254740993?operatorId=9&storeId=1';
        const response = page.waitForResponse(
          (value) =>
            new URL(value.url()).pathname === '/api/v1/stores/1/orders/9007199254740993/details' &&
            value.status() === 200,
        );
        await page.goto(browserOrigin + path);
        await response;
        await page.getByRole('heading', { name: 'Order 9007199254740993', exact: true }).waitFor();
        expect(
          await page.getByRole('cell', { name: '9007199254740995', exact: true }).count(),
        ).toBe(1);
        const reloaded = page.waitForResponse(
          (value) =>
            new URL(value.url()).pathname === '/api/v1/stores/1/orders/9007199254740993/details' &&
            value.status() === 200,
        );
        await page.reload();
        await reloaded;
        await page.getByRole('heading', { name: 'Order 9007199254740993', exact: true }).waitFor();
        const before = detailRequests;
        await page.goto(
          browserOrigin + '/orders/details/N/9007199254740993?operatorId=9&storeId=2',
        );
        await page.getByRole('alert').filter({ hasText: 'different operator or store' }).waitFor();
        expect(detailRequests).toBe(before);
        expect(await page.getByRole('region', { name: 'Current customer profile' }).count()).toBe(
          0,
        );
        await page.goto(
          browserOrigin + '/orders/details/N/9007199254740993?operatorId=10&storeId=1',
        );
        await page.getByRole('alert').filter({ hasText: 'different operator or store' }).waitFor();
        expect(detailRequests).toBe(before);
        const opened = await context.newPage();
        const actual = opened.waitForResponse(
          (value) =>
            new URL(value.url()).pathname === '/api/v1/stores/1/orders/9007199254740993/details' &&
            value.status() === 200,
        );
        await opened.goto(browserOrigin + path);
        await actual;
        await opened
          .getByRole('heading', { name: 'Order 9007199254740993', exact: true })
          .waitFor();
        await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=9');
        const denied = opened.waitForResponse(
          (value) =>
            new URL(value.url()).pathname === '/api/v1/stores/1/orders/9007199254740993/details' &&
            value.status() === 401,
        );
        await opened.getByRole('button', { name: 'Refresh details', exact: true }).click();
        await denied;
        await opened
          .getByRole('region', { name: 'Current customer profile' })
          .waitFor({ state: 'hidden' });
        await native.connection.query('UPDATE pos_user SET is_active=1 WHERE id=9');
        await context.close();
      } finally {
        await browser.close();
      }
    },
    20000,
  );
});
