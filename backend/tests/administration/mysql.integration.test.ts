import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import sharp from 'sharp';
import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  Country,
  HoldStockStore,
  MUser,
  POSFranchise,
  PosHyperlocalSlot,
  PosHoldStockLog,
  PosMachine,
  PosPaytmMachine,
  PosTutorial,
  PosUser,
  PriceList,
  Product,
  ProductBarcode,
  ProductInventoryLog,
  ProductStore,
  SalesPerson,
  StockStorage,
  Store,
  StoreCounter,
  StoreSalesPerson,
  StoreStorage,
  TssSetting,
  UserStore,
} from '../../src/db/legacy-schema.js';
import { AppError } from '../../src/domain/errors.js';
import { verifyDjangoPassword } from '../../src/auth/crypto.js';
import { profileMediaService } from '../../src/auth/profile-media.js';
import type { Principal } from '../../src/domain/access.js';
import { registerAdministration } from '../../src/modules/administration/index.js';
import { catalogService } from '../../src/modules/catalog.js';
import {
  legacyFixtureRecord,
  legacyFixtureTableSql,
} from '../../tools/administration/mysql-fixture.js';
import type {
  DocumentationMediaStore,
  ReservedMedia,
} from '../../src/modules/administration/media-storage.js';
import { settingsService } from '../../src/modules/administration/settings.js';
import { readSettingsOptions } from '../../src/modules/administration/settings-options.js';
import { recordingJobProducer } from '../../src/jobs/module-runtime.js';
import type {
  SettingsEffect,
  SettingsEffectDelivery,
} from '../../src/modules/administration/settings-domain.js';
import { createSettingsDelivery } from '../../src/modules/administration/settings-adapters.js';
import { inventoryService } from '../../src/modules/administration/inventory.js';
import { assertCurrentStoreAccess } from '../../src/modules/administration/authorization.js';
import type { StockProcedureInput } from '../../src/modules/administration/stock-procedure.js';
import { operatorMfaService } from '../../src/modules/administration/mfa.js';
import { testAuthRedis, testSessions } from '../helpers/auth-sessions.js';
import { checkInRedis } from '../helpers/check-ins.js';
import {
  deliverablePincodes,
  locationZones,
} from '../../src/modules/administration/location-schema.js';
import type { SlackOAuthProvider } from '../../src/modules/administration/slack-provider.js';
import { imageReservationInput } from '../../src/modules/administration/image-lifecycle/domain.js';
import { operatorAdminProfileInput } from '../../src/modules/administration/operator-admin-domain.js';
import { goldenStdout } from '../golden/load.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { useAdministrationEphemeralStore } from '../../src/modules/administration/ephemeral-runtime.js';

const template = process.env.ADMINISTRATION_MYSQL_TEST_URL;
const ephemeral = memoryEphemeralStore();
describe.skipIf(!template)('administration routes against isolated MySQL', () => {
  const tables: MySqlTable[] = [
    Country,
    HoldStockStore,
    MUser,
    POSFranchise,
    PosHyperlocalSlot,
    PosHoldStockLog,
    PosMachine,
    PosPaytmMachine,
    PosTutorial,
    PosUser,
    PriceList,
    Product,
    ProductBarcode,
    ProductInventoryLog,
    ProductStore,
    SalesPerson,
    StockStorage,
    Store,
    StoreCounter,
    StoreSalesPerson,
    StoreStorage,
    TssSetting,
    UserStore,
    deliverablePincodes,
    locationZones,
  ];
  let connection: Connection, db: Databases, app: FastifyInstance, schemaName: string;
  let actor: Principal = {
    id: '1',
    name: 'Fixture administrator',
    email: 'fixture@example.test',
    role: 1,
    userType: 1,
    storeIds: ['1', '2'],
  };
  let services: ReturnType<typeof registerAdministration>;
  const slackProvider: SlackOAuthProvider = {
    authorize(state) {
      return (
        'https://slack.com/oauth/v2/authorize?' +
        new URLSearchParams({
          client_id: '1234.5678',
          scope: 'incoming-webhook',
          redirect_uri: 'https://pos.example.test/api/v1/admin/slack/oauth/callback',
          state,
        })
      );
    },
    async exchange() {
      return {
        ok: true,
        webhook: 'https://hooks.slack.com/services/T0123456789/B0123456789/privateFixtureWebhook',
        channel: '#fixture-sales',
      };
    },
  };
  let applicationConfig: ReturnType<typeof readConfig>;
  let deliveryFailure = false;
  let settingsAvailable = true;
  const settingsFailures = new Set<SettingsEffect['kind']>();
  const settingsDeliveries: { effect: SettingsEffect }[] = [];
  const settingsDelivery: SettingsEffectDelivery = {
    supports: () => settingsAvailable,
    async deliver(effect, signal) {
      signal?.throwIfAborted();
      settingsDeliveries.push({ effect });
      if (settingsFailures.has(effect.kind)) throw new Error('private-canary@example.test');
    },
  };
  const moduleRuntime = { jobs: recordingJobProducer(), ephemeral: memoryEphemeralStore() };
  let mediaVerificationFailure = false,
    mediaDeletionFailure = false;
  const mediaDeletes: string[] = [],
    mediaVerifications: ReservedMedia[] = [];
  let storeImageBytes: Buffer,
    originalStoreImageBytes: Buffer,
    storeImageDeletionFailure = false;
  const storeImageDeletes: string[] = [],
    storeImageVerifications: ReservedMedia[] = [];
  const storeImageStore: DocumentationMediaStore = {
    keyFor(input) {
      return `uploads/stores/stores_image/${input.id}.png`;
    },
    assertKey(key) {
      if (!/^uploads\/stores\/stores_image\/[0-9a-f-]+\.png$/.test(key))
        throw new AppError(403, 'DOCUMENTATION_ASSET_SCOPE_DENIED', 'Image scope denied.');
    },
    async upload(input) {
      this.assertKey(input.objectKey);
      return { url: 'https://upload.example.test/', fields: { key: input.objectKey } };
    },
    async verify(input) {
      storeImageVerifications.push(input);
    },
    async stream(key) {
      this.assertKey(key);
      return {
        body: Readable.from([storeImageBytes]),
        contentType: 'image/png',
        size: storeImageBytes.length,
      };
    },
    async remove(key) {
      this.assertKey(key);
      if (storeImageDeletionFailure) throw new Error('private-store-image-canary@example.test');
      storeImageDeletes.push(key);
    },
    close() {},
  };
  const operatorImageStore: DocumentationMediaStore = {
    ...storeImageStore,
    keyFor(input) {
      return `uploads/users/${input.kind === 'image' ? 'profile_image' : 'cover_image'}/${input.id}.png`;
    },
    assertKey(key) {
      if (!/^uploads\/users\/(?:profile_image|cover_image)\/[0-9a-f-]+\.png$/.test(key))
        throw new AppError(403, 'PROFILE_ASSET_SCOPE_DENIED', 'Image scope denied.');
    },
  };
  const media: DocumentationMediaStore = {
    keyFor(input) {
      return `fixtures/tutorials/${input.kind}/${input.id}.${input.contentType === 'application/pdf' ? 'pdf' : 'png'}`;
    },
    assertKey(key) {
      if (!key.startsWith('fixtures/tutorials/'))
        throw new AppError(
          403,
          'DOCUMENTATION_ASSET_SCOPE_DENIED',
          'Attachment is outside the guide media location.',
        );
    },
    async upload(input) {
      return { url: 'https://upload.example.test/', fields: { key: input.objectKey } };
    },
    async verify(input) {
      mediaVerifications.push(input);
      if (mediaVerificationFailure)
        throw new AppError(
          400,
          'DOCUMENTATION_UPLOAD_MISMATCH',
          'Upload does not match its reservation.',
        );
    },
    async stream(key, kind) {
      this.assertKey(key);
      const bytes = Buffer.from(kind === 'document' ? '%PDF-fixture' : 'fixture-media');
      return {
        body: Readable.from([bytes]),
        contentType: kind === 'document' ? 'application/pdf' : 'image/png',
        size: bytes.length,
      };
    },
    async remove(key) {
      this.assertKey(key);
      if (mediaDeletionFailure) throw new Error('private-canary@example.test');
      mediaDeletes.push(key);
    },
    close() {},
  };
  const deliveries: { products: string[]; context: { operatorId: string; storeId?: string } }[] =
    [];
  const describeTable = (table: MySqlTable) => getTableConfig(table);
  async function seed(
    table: MySqlTable,
    values: Record<string, string | number | bigint | boolean | null>,
  ) {
    const config = describeTable(table),
      record = legacyFixtureRecord(table, values);
    const entries = Object.entries(record),
      names = entries.map(([name]) => name);
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(config.name)} (${names.map((name) => mysql.escapeId(name)).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      entries.map(([, value]) => value),
    );
  }
  beforeAll(async () => {
    originalStoreImageBytes = await sharp({
      create: { width: 4, height: 4, channels: 4, background: '#e2a65a' },
    })
      .png()
      .toBuffer();
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_administration_test'
    )
      throw new Error(
        'Administration integration tests require the explicit isolated local schema template.',
      );
    schemaName = `pos_rewrite_administration_test_${process.pid}_${crypto.randomUUID().slice(0, 8)}`;
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
    await connection.changeUser({ database: schemaName });
    for (const table of tables) {
      const config = describeTable(table);
      if (config.name === 'pricelist') {
        await connection.query(
          'CREATE TABLE pricelist (product_id BIGINT NOT NULL,pricelist_id INT NOT NULL,location_id INT NOT NULL DEFAULT 0,price DECIMAL(10,2) NOT NULL,PRIMARY KEY(product_id,pricelist_id,location_id)) ENGINE=InnoDB',
        );
        continue;
      }
      await connection.query(legacyFixtureTableSql(table));
    }
    await connection.query(
      'ALTER TABLE pos_user MODIFY last_login DATETIME(6) NULL, MODIFY date_joined DATETIME(6) NOT NULL',
    );
    url.pathname = '/' + schemaName;
    const config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'administration-test-fixture-secret-'.repeat(2),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_PRIMARY_READER_URL: url.href,
      MYSQL_WRITER_URL: url.href,
      MYSQL_DATA_READER_URL: url.href,
    });
    applicationConfig = config;
    db = createDatabases(config);
    app = Fastify({ logger: false });
    await app.register(cookie);
    app.decorateRequest('principal', null);
    app.addHook('preHandler', async (request) => {
      request.principal = actor;
    });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof AppError)
        return reply
          .code(error.status)
          .send({ error: { code: error.code, message: error.message } });
      if (error instanceof ZodError)
        return reply.code(400).send({ error: { code: 'INVALID_REQUEST' } });
      return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
    });
    useAdministrationEphemeralStore(ephemeral);
    // Check-ins are the legacy check_in_* keys on an in-process Redis port.
    checkInRedis();
    services = registerAdministration(app, config, db, {
      ephemeral,
      defaultStoreOperatorIds: ['2'],
      mediaStore: media,
      storeImageStore,
      operatorImageStore,
      operatorImageReservations: testAuthRedis,
      slackOAuth: slackProvider,
      productSync: async (products, context) => {
        deliveries.push({ products: [...products], context });
        return !deliveryFailure;
      },
      procedureVerified: false,
      settingsDelivery,
      moduleRuntime,
    });
    await app.ready();
  });
  beforeEach(async () => {
    for (const key of await ephemeral.scanKeys('*')) await ephemeral.del(key);
    const checkInKeys = await checkInRedis().scanKeys('check_in_*');
    if (checkInKeys.length) await checkInRedis().del(checkInKeys);
    storeImageBytes = originalStoreImageBytes;
    storeImageDeletes.length = 0;
    storeImageVerifications.length = 0;
    storeImageDeletionFailure = false;
    mediaVerificationFailure = false;
    mediaDeletionFailure = false;
    mediaDeletes.length = 0;
    mediaVerifications.length = 0;
    deliveryFailure = false;
    deliveries.length = 0;
    settingsAvailable = true;
    settingsFailures.clear();
    settingsDeliveries.length = 0;
    for (const table of [...tables].reverse())
      await connection.query('DELETE FROM ' + mysql.escapeId(describeTable(table).name));
    for (const id of [1, 2])
      await seed(Store, {
        id,
        store_name: `Fixture Store ${id}`,
        type: 'STORE',
        category: 'IN_HOUSE',
        location_code: `LOC-${id}`,
        is_active: true,
      });
    for (const [id, role, userType] of [
      [1, 1, 1],
      [2, 2, 1],
      [3, 3, 1],
      [4, 4, 1],
      [5, 5, 1],
      [6, 5, 2],
    ])
      await seed(PosUser, {
        id: id!,
        first_name: 'Fixture',
        last_name: 'Person',
        username: `fixture${id}`,
        email: `fixture${id}@example.test`,
        phone: `98765432${String(id).padStart(2, '0')}`,
        contact_email: `contact${id}@example.test`,
        role: role!,
        user_type: userType!,
        otp_method: 2,
        is_active: true,
      });
    await seed(StoreCounter, {
      id: 1,
      store_id: 1,
      counter_name: 'C1',
      counter_type: 'IN_STORE',
      is_active: true,
    });
    await seed(StoreCounter, {
      id: 2,
      store_id: 2,
      counter_name: 'C1',
      counter_type: 'IN_STORE',
      is_active: true,
    });
    await seed(UserStore, { django_user_id: 2, store_id: 1 });
    await seed(UserStore, { django_user_id: 3, store_id: 1 });
    await seed(UserStore, { django_user_id: 4, store_id: 1 });
    await seed(UserStore, { django_user_id: 4, store_id: 2 });
    await seed(TssSetting, { platform: 'STORE_LOCATION_CODE', value: '["LOC-1","LOC-2","LOC-3"]' });
    actor = {
      id: '1',
      name: 'Fixture administrator',
      email: 'fixture@example.test',
      role: 1,
      userType: 1,
      storeIds: ['1', '2'],
    };
  });
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (connection) {
      await connection.query('DROP DATABASE ' + mysql.escapeId(schemaName));
      await connection.end();
    }
  });
  it('limits franchise role-one store enumeration to assigned franchise stores across search, status and cursor pages', async () => {
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 1n));
    await db.get('writer').update(Store).set({ category: 'FRANCHISE' }).where(eq(Store.id, 1n));
    for (const id of [3, 4, 5])
      await seed(Store, {
        id,
        store_name: `Fixture Store ${id}`,
        type: 'STORE',
        category: 'FRANCHISE',
        location_code: `LOC-${id}`,
        is_active: id !== 5,
      });
    for (const id of [1, 2, 4, 5]) await seed(UserStore, { django_user_id: 1, store_id: id });
    actor = { ...actor, userType: 2, storeIds: ['1', '2', '4', '5'] };
    const first = await app.inject('/api/v1/admin/stores?limit=1');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ data: [{ id: '1' }], nextCursor: '1' });
    const next = await app.inject('/api/v1/admin/stores?after=1&limit=1');
    expect(next.json()).toMatchObject({ data: [{ id: '4' }], nextCursor: null });
    expect((await app.inject('/api/v1/admin/stores?search=LOC-2')).json()).toEqual({
      data: [],
      nextCursor: null,
    });
    expect((await app.inject('/api/v1/admin/stores?search=LOC-3')).json()).toEqual({
      data: [],
      nextCursor: null,
    });
    expect((await app.inject('/api/v1/admin/stores?active=false')).json()).toMatchObject({
      data: [{ id: '5' }],
      nextCursor: null,
    });
    actor = { ...actor, storeIds: [] };
    expect((await app.inject('/api/v1/admin/stores?active=all')).json()).toEqual({
      data: [],
      nextCursor: null,
    });
    await db.get('writer').update(PosUser).set({ user_type: 1 }).where(eq(PosUser.id, 1n));
    actor = { ...actor, userType: 1 };
    const internal = (await app.inject('/api/v1/admin/stores?active=all')).json<{
      data: { id: string }[];
    }>();
    expect(internal.data.map((store) => store.id)).toEqual(['1', '2', '3', '4', '5']);
  });
  it('creates counters serially, counting archived counters as the source does', async () => {
    await connection.query('UPDATE store_counters SET is_active=0 WHERE id=1');
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/stores/1/counters',
        payload: { description: 'Fixture' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/admin/stores/1/counters',
        payload: { description: 'Fixture' },
      }),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(responses.map((r) => r.json<{ name: string }>().name).sort()).toEqual(['C2', 'C3']);
  });
  it('prefixes storage names and refuses to archive stock-containing storage', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/storages',
      payload: { storage_name: 'Back', storage_desc: 'Fixture storage', storage_type: 'STORAGE' },
    });
    expect(created.statusCode).toBe(201);
    const storage = created.json<{ id: string; name: string }>();
    expect(storage.name).toBe('FIXTURE-STRG-BACK');
    await seed(StockStorage, { product_id: 1001, store_id: 1, storage_id: storage.id, stock: 2 });
    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/1/storages/${storage.id}/status`,
      payload: { active: false },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('STORAGE_CONTAINS_STOCK');
  });
  it('preserves out-of-scope operator store assignments on empty replacement', async () => {
    actor = { ...actor, id: '2', role: 2, storeIds: ['1'] };
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operators/4/stores',
      payload: { storeIds: [] },
    });
    expect(response.statusCode).toBe(200);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT store_id FROM user_stores WHERE django_user_id=4 ORDER BY store_id',
    );
    expect(rows.map((row) => String(row.store_id))).toEqual(['2']);
    expect(response.json<{ message: string }>().message).toBe(
      'Store has been deleted for the selected user.',
    );
  });
  it('adds normalized location codes without concurrent lost updates and rejects duplicates', async () => {
    const responses = await Promise.all(
      [' a1 ', 'b2'].map((code) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/admin/store-location-codes',
          payload: { code },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT value FROM tss_settings WHERE platform=?',
      ['STORE_LOCATION_CODE'],
    );
    expect(JSON.parse(String(rows[0]?.value))).toEqual(['A1', 'B2', 'LOC-1', 'LOC-2', 'LOC-3']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/store-location-codes',
          payload: { code: 'a1' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/store-location-codes',
          payload: { code: 'ABCDE' },
        })
      ).statusCode,
    ).toBe(400);
    actor = { ...actor, id: '2', role: 2, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/store-location-codes',
          payload: { code: 'C3' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('keeps out-of-scope salesperson assignments and refuses a second active store', async () => {
    await seed(SalesPerson, {
      id: 1,
      employee_id: 'FIX-1',
      first_name: 'Fixture',
      last_name: 'Salesperson',
      email: 'fixture@example.test',
      phone: '9876543210',
      is_active: 1,
      user_type: 1,
    });
    await seed(StoreSalesPerson, { salesperson_id: 1, store_id: 2, is_active: 1 });
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/salespeople/1/stores',
      payload: { storeIds: ['1'], activeStoreId: '1' },
    });
    expect(conflict.statusCode).toBe(409);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/salespeople/1/stores',
      payload: { storeIds: ['1'], activeStoreId: null },
    });
    expect(response.statusCode).toBe(200);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT store_id,is_active FROM store_salesperson WHERE salesperson_id=1 ORDER BY store_id',
    );
    expect(rows.map((row) => [String(row.store_id), row.is_active])).toEqual([
      ['1', '0'],
      ['2', '1'],
    ]);
  });
  it('serializes concurrent salesperson identity creation', async () => {
    const payload = {
      employeeId: 'FIXTURE-NEW',
      firstName: 'Fixture',
      lastName: 'Salesperson',
      email: 'new@example.test',
      phone: '9876543299',
      userType: 1,
      active: true,
    };
    const results = await Promise.all(
      [1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/admin/salespeople', payload })),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM salespersons WHERE employee_id=?',
      [payload.employeeId],
    );
    expect(String(rows[0]?.total)).toBe('1');
  });
  it('rechecks operator mutation roles/types and full profile scope while preserving scoped assignment diffs', async () => {
    await seed(UserStore, { django_user_id: 5, store_id: 1 });
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    const payload = {
      firstName: 'Scoped fixture',
      lastName: 'Person',
      email: 'fixture5@example.test',
      phone: '9876543205',
      contactEmail: 'contact5@example.test',
      role: 5,
      userType: 1,
      otpMethod: 1,
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/operators/5', payload })).statusCode,
    ).toBe(200);
    await db.get('writer').delete(UserStore).where(eq(UserStore.django_user_id, 3n));
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/operators/5',
          payload: { ...payload, firstName: 'Revoked write' },
        })
      ).statusCode,
    ).toBe(403);
    await seed(UserStore, { django_user_id: 3, store_id: 1 });
    await seed(UserStore, { django_user_id: 5, store_id: 2 });
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/operators/5', payload })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/operators/5/status',
          payload: { active: false },
        })
      ).statusCode,
    ).toBe(403);
    const removed = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operators/5/stores',
      payload: { storeIds: [] },
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await db.get('writer').select().from(UserStore).where(eq(UserStore.django_user_id, 5n))).map(
        (row) => String(row.store_id),
      ),
    ).toEqual(['2']);
    actor = { ...actor, role: 1 }; // Deliberately stale elevated principal; writer still has OPM role.
    const escalation = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operators/5',
      payload: { ...payload, role: 1 },
    });
    expect(escalation.statusCode).toBe(403);
    expect(escalation.json<{ error: { code: string } }>().error.code).toBe('OPERATOR_ROLE_DENIED');
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 3n));
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/operators/5/stores',
          payload: { storeIds: ['1'] },
        })
      ).statusCode,
    ).toBe(403);
    const [unchanged] = await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 5n));
    expect(unchanged).toMatchObject({ first_name: 'Scoped fixture', role: 5, is_active: true });
  });
  it('accepts private person search only in strict POST bodies and preserves existing paging/filter results', async () => {
    for (const path of [
      '/api/v1/admin/operators',
      '/api/v1/admin/salespeople',
      '/api/v1/stores/1/salespeople',
    ])
      expect(
        (await app.inject(`${path}?search=private-search-canary%40example.test`)).statusCode,
      ).toBe(400);
    const operator = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operators/search',
      payload: { search: 'fixture4@example.test', after: '0', limit: 30, active: 'true' },
    });
    expect(operator.statusCode).toBe(200);
    expect(operator.headers['cache-control']).toBe('private, no-store');
    expect(operator.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toEqual(['4']);
    await seed(SalesPerson, {
      id: 99,
      employee_id: 'SEARCH-FIXTURE',
      first_name: 'Private',
      last_name: 'Fixture',
      email: 'private-salesperson@example.test',
      phone: '9876543277',
      user_type: 1,
      is_active: 1,
    });
    await seed(StoreSalesPerson, { store_id: 1, salesperson_id: 99, is_active: 1 });
    for (const path of [
      '/api/v1/admin/salespeople/search',
      '/api/v1/stores/1/salespeople/search',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { search: 'Private', active: 'true' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toEqual(['99']);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/operators/search',
          payload: { search: '', unexpected: true },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('serializes concurrent store creation including its counter and default assignments', async () => {
    const payload = {
      store_name: 'New Fixture Store',
      short_name: 'New fixture',
      location_code: 'LOC-3',
      type: 'STORE',
      category: 'IN_HOUSE',
      latitude: '19.0760',
      longitude: '72.8777',
      address: 'Fixture address',
      city_id: '1111',
      country_id: '0',
      phone: '9876543299',
    };
    const results = await Promise.all(
      [1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/admin/stores', payload })),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 400]);
    // The second form re-renders with the legacy model-unique errors (stores/forms.py, Django).
    expect(
      results
        .find((response) => response.statusCode === 400)!
        .json<{
          error: { fields: Record<string, string[]> };
        }>().error.fields,
    ).toEqual({
      location_code: ['Store with this Location code already exists.'],
      phone: ['Store with this Phone already exists.'],
    });
    const created = results.find((response) => response.statusCode === 201)!.json<{ id: string }>();
    const [counters] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT counter_name FROM store_counters WHERE store_id=?',
      [created.id],
    );
    expect(counters.map((row) => row.counter_name)).toEqual(['C1']);
    const [assignments] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT django_user_id FROM user_stores WHERE store_id=?',
      [created.id],
    );
    expect(assignments.map((row) => String(row.django_user_id))).toEqual(['2']);
  });
  it('persists and clears a validated check-in, rejecting cross-store and expired proofs', async () => {
    actor = { ...actor, id: '4', role: 4, storeIds: ['1', '2'] };
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/operators/me/check-in',
      payload: { storeId: '1', counterId: '1' },
    });
    expect(response.statusCode).toBe(200);
    await expect(services.checkins.assertCheckIn('4', '1', '1')).resolves.toBeUndefined();
    await expect(services.checkins.assertCheckIn('4', '2', '2')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
    expect(await services.checkins.checkedInStore('4')).toBe('1');
    expect(await services.checkins.checkedInUsers('1')).toEqual(['4']);
    await connection.query('DELETE FROM user_stores WHERE django_user_id=4 AND store_id=1');
    // Legacy `get_checkin_data` reads only the key; writer actions recheck the current scope.
    expect(await services.checkins.checkedInStore('4')).toBe('1');
    await expect(services.checkins.assertCheckIn('4', '1', '1')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await app.inject({ method: 'DELETE', url: '/api/v1/operators/me/check-in' });
    expect(await services.checkins.checkedInStore('4')).toBeNull();
    expect(await services.checkins.checkedInUsers('1')).toEqual([]);
    await expect(services.checkins.assertCheckIn('4', '1', '1')).rejects.toMatchObject({
      code: 'CHECK_IN_REQUIRED',
    });
  });
  it('serializes operator creation and writes its commerce mirror without copying the password', async () => {
    const input = {
      method: 'POST' as const,
      url: '/api/v1/admin/operators',
      payload: {
        firstName: 'Fixture',
        lastName: 'New',
        email: 'newfixture@example.test',
        phone: '9876543299',
        role: 5,
        contactEmail: 'newcontact@example.test',
        otpMethod: 2,
        userType: 1,
        password: 'fixture passphrase 42',
        confirmPassword: 'fixture passphrase 42',
      },
    };
    const responses = await Promise.all([app.inject(input), app.inject(input)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const response = responses.find((result) => result.statusCode === 201)!;
    expect(response.statusCode).toBe(201);
    const operator = response.json<{ id: string }>();
    const [users] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT password FROM pos_user WHERE id=?',
      [operator.id],
    );
    const [mirrors] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT password,plain_password,user_type FROM users WHERE pos_admin_id=?',
      [operator.id],
    );
    expect(users[0]?.password).toMatch(/^pbkdf2_sha256\$/);
    expect(mirrors[0]?.password).toBe('');
    expect(mirrors[0]?.plain_password).toBe('');
    expect(mirrors[0]?.user_type).toBe('8');
  });
  it('rolls operator identity back if the required commerce mirror fails', async () => {
    await connection.query(
      "CREATE TRIGGER fixture_fail_staff_mirror BEFORE INSERT ON users FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fixture mirror failure'",
    );
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/operators',
        payload: {
          firstName: 'Fixture',
          lastName: 'Rollback',
          email: 'rollback@example.test',
          phone: '9876543298',
          role: 5,
          contactEmail: 'rollback-otp@example.test',
          otpMethod: 2,
          userType: 1,
          password: 'fixture passphrase 43',
          confirmPassword: 'fixture passphrase 43',
        },
      });
      expect(response.statusCode).toBe(500);
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM pos_user WHERE email=?',
        ['rollback@example.test'],
      );
      expect(String(rows[0]?.total)).toBe('0');
    } finally {
      await connection.query('DROP TRIGGER fixture_fail_staff_mirror');
    }
  });
  it('checks route inputs and role/store scope before making changes', async () => {
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/stores/1/counters',
          payload: { description: '' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/stores/2/storages' })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/stores/1/storages?limit=-1' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/operators/3/status',
          payload: { active: false },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('keeps stock mutation disabled until the deployed procedure is verified', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/stores/1/inventory/1001/stock',
      payload: { stock: 1, expectedStock: 0 },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('DEPENDENCY_UNAVAILABLE');
  });
  it('does not return terminal credentials in administration list responses', async () => {
    await seed(PosMachine, {
      store_id: 1,
      counter_id: 1,
      machine_name: 'Fixture terminal',
      security_token: 'secret-canary',
      is_active: 1,
    });
    await seed(PosPaytmMachine, {
      store_id: 1,
      counter_id: 1,
      machine_name: 'Fixture Paytm',
      merchant_key: 'private-canary',
      is_active: 1,
    });
    const response = await app.inject('/api/v1/admin/stores/1/payment-terminals');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('secret-canary');
    expect(response.body).not.toContain('private-canary');
    expect(response.body).not.toContain('security_token');
    expect(response.body).not.toContain('merchant_key');
  });
  it('creates one delivery weekday per store under concurrent requests with validated times', async () => {
    const payload = { weekday: 'MON', start: '09:00', end: '22:30' };
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url: '/api/v1/admin/stores/1/delivery-slots', payload }),
      ),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const listed = await app.inject('/api/v1/admin/stores/1/delivery-slots');
    expect(
      listed.json<{ data: { weekday: string; start: string; end: string; available: number }[] }>()
        .data,
    ).toEqual([
      expect.objectContaining({ weekday: 'MON', start: '09:00:00', end: '22:30:00', available: 1 }),
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/stores/1/delivery-slots',
          payload: { ...payload, weekday: 'TUE', start: '25:00' },
        })
      ).statusCode,
    ).toBe(400);
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/stores/2/delivery-slots', payload }))
        .statusCode,
    ).toBe(403);
  });
  it('allocates source EDC names per provider/store and never returns provider credentials', async () => {
    await seed(PosPaytmMachine, {
      store_id: 1,
      counter_id: 1,
      machine_name: 'machine 009',
      is_active: 0,
      merchant_key: 'archived-secret',
    });
    expect(
      (await app.inject('/api/v1/admin/stores/1/payment-terminals/next-name?provider=paytm')).json<{
        name: string;
      }>().name,
    ).toBe('Machine 10');
    const payload = {
      provider: 'paytm',
      merchantId: 'fixture-mid',
      terminalId: 'fixture-tid',
      deviceSerialNumber: '9223372036854775807',
      merchantKey: 'fixture-merchant-secret',
      active: true,
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url: '/api/v1/admin/stores/1/payment-terminals', payload }),
      ),
    );
    expect(results.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(results.map((response) => response.json<{ name: string }>().name).sort()).toEqual([
      'Machine 10',
      'Machine 11',
    ]);
    const id = results[0]!.json<{ id: string }>().id;
    const detail = await app.inject(`/api/v1/admin/stores/1/payment-terminals/paytm/${id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('fixture-merchant-secret');
    expect(detail.json<{ deviceSerialNumber: string }>().deviceSerialNumber).toBe(
      payload.deviceSerialNumber,
    );
    const pine = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/payment-terminals',
      payload: {
        provider: 'pine-labs',
        clientId: 'client',
        hardwareId: 'hardware',
        terminalId: 'tid',
        merchantId: 'merchant',
        merchantStorePosCode: 'store-pos',
        securityToken: 'fixture-pine-secret',
        active: true,
      },
    });
    expect(pine.statusCode).toBe(201);
    expect(pine.json<{ name: string }>().name).toBe('Machine 1');
    const pineId = pine.json<{ id: string }>().id;
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT imei_no,merchant_name,counter_id FROM pos_machines WHERE id=?',
      [pineId],
    );
    expect(rows.map((row) => [row.imei_no, row.merchant_name, row.counter_id])).toEqual([
      ['0', 'The Souled Store Pvt Ltd', 1],
    ]);
    const list = await app.inject('/api/v1/admin/stores/1/payment-terminals');
    expect(list.body).not.toContain('fixture-pine-secret');
    expect(list.body).not.toContain('fixture-merchant-secret');
    actor = { ...actor, id: '5', role: 5, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/stores/1/payment-terminals',
          payload,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('moves terminals only within scope, retains omitted secrets, renumbers clashes and deletes configuration', async () => {
    const payload = {
      provider: 'paytm',
      merchantId: 'fixture-mid',
      terminalId: 'fixture-tid',
      deviceSerialNumber: '123',
      merchantKey: 'retained-secret',
      active: true,
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/payment-terminals',
      payload,
    });
    const id = created.json<{ id: string }>().id;
    await seed(PosPaytmMachine, {
      store_id: 2,
      counter_id: 2,
      machine_name: 'Machine 1',
      is_active: 1,
    });
    await seed(PosPaytmMachine, {
      store_id: 2,
      counter_id: 2,
      machine_name: 'Machine 7',
      is_active: 0,
    });
    const edited = {
      provider: 'paytm',
      merchantId: 'changed-mid',
      terminalId: 'changed-tid',
      deviceSerialNumber: '456',
      active: true,
      destinationStoreId: '2',
    };
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/payment-terminals/paytm/${id}`,
          payload: edited,
        })
      ).statusCode,
    ).toBe(403);
    actor = { ...actor, id: '1', role: 1, storeIds: [] };
    const moved = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/stores/1/payment-terminals/paytm/${id}`,
      payload: edited,
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ name: string }>().name).toBe('Machine 8');
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT merchant_key,counter_id,store_name FROM pos_paytm_machines WHERE id=?',
      [id],
    );
    expect(rows.map((row) => [row.merchant_key, row.counter_id, row.store_name])).toEqual([
      ['retained-secret', 2, 'Fixture Store 2'],
    ]);
    expect(
      (await app.inject(`/api/v1/admin/stores/1/payment-terminals/paytm/${id}`)).statusCode,
    ).toBe(404);
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/stores/2/payment-terminals/paytm/${id}`,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<{ message: string }>().message).toBe('Paytm Machine deleted');
    expect(
      (await app.inject(`/api/v1/admin/stores/2/payment-terminals/paytm/${id}`)).statusCode,
    ).toBe(404);
  });
  it('edits and moves delivery timings with store isolation, stale-input protection and durable notices', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/delivery-slots',
      payload: { weekday: 'MON', start: '09:00', end: '22:00' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const listed = (await app.inject('/api/v1/admin/stores/1/delivery-slots')).json<{
      data: { id: string; version: string }[];
    }>().data[0]!;
    const body = {
      operationId: randomUUID(),
      expectedVersion: listed.version,
      weekday: 'TUE',
      start: '10:00',
      end: '23:00',
    };
    const changes = await Promise.all(
      [body, { ...body, operationId: randomUUID(), start: '11:00' }].map((payload) =>
        app.inject({ method: 'PUT', url: `/api/v1/admin/stores/1/delivery-slots/${id}`, payload }),
      ),
    );
    expect(changes.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const current = (await app.inject('/api/v1/admin/stores/1/delivery-slots')).json<{
      data: { version: string }[];
    }>().data[0]!;
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/delivery-slots/${id}`,
          payload: {
            ...body,
            operationId: randomUUID(),
            expectedVersion: current.version,
            destinationStoreId: '2',
          },
        })
      ).statusCode,
    ).toBe(403);
    actor = { ...actor, id: '1', role: 1, storeIds: [] };
    const move = {
      ...body,
      operationId: randomUUID(),
      expectedVersion: current.version,
      destinationStoreId: '2',
    };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/delivery-slots/${id}`,
          payload: move,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/delivery-slots/${id}`,
          payload: move,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject('/api/v1/admin/stores/1/delivery-slots')).json<{ data: unknown[] }>().data,
    ).toHaveLength(0);
    // Effects run inline after commit (`core/views.py:1817`); a replayed operation sends none.
    expect(settingsDeliveries.map((row) => row.effect.kind)).toEqual([
      'slot.timing.notice',
      'slot.timing.notice',
    ]);
    expect(JSON.stringify(settingsDeliveries)).not.toContain('fixture@example.test');
  });
  it('updates one or all slot availability atomically and refuses stale collections and current role revocations', async () => {
    for (const weekday of ['MON', 'TUE'])
      await app.inject({
        method: 'POST',
        url: '/api/v1/admin/stores/1/delivery-slots',
        payload: { weekday, start: '09:00', end: '22:00' },
      });
    const slots = (await app.inject('/api/v1/admin/stores/1/delivery-slots')).json<{
      data: { id: string; version: string }[];
    }>().data;
    const update = { operationId: randomUUID(), expectedVersion: slots[0]!.version, active: false };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/stores/2/delivery-slots/${slots[0]!.id}/availability`,
          payload: update,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/v1/admin/stores/1/delivery-slots/${slots[0]!.id}/availability`,
          payload: update,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/stores/1/delivery-slots/availability',
          payload: {
            operationId: randomUUID(),
            active: false,
            expectedSlots: slots.map(({ id, version }) => ({ id, version })),
          },
        })
      ).statusCode,
    ).toBe(409);
    const refreshed = (await app.inject('/api/v1/admin/stores/1/delivery-slots'))
      .json<{ data: { id: string; version: string }[] }>()
      .data.map(({ id, version }) => ({ id, version }));
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/stores/1/delivery-slots/availability',
          payload: { operationId: randomUUID(), active: false, expectedSlots: refreshed },
        })
      ).statusCode,
    ).toBe(200);
    const [values] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT is_avail FROM pos_hyperlocal_slots WHERE store_id=1',
    );
    expect(values.map((row) => String(row.is_avail))).toEqual(['0', '0']);
    actor = { ...actor, id: '4', role: 3, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/stores/1/delivery-slots',
          payload: { weekday: 'WED', start: '09:00', end: '22:00' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('updates every matching global setting with source duration arithmetic, input checks and operation replay', async () => {
    for (const id of [100, 101])
      await seed(TssSetting, { id, platform: 'HYPERLOCAL_STOCK_THRESHOLD', value: '2' });
    await seed(TssSetting, { id: 102, platform: 'ORDER_CREATION_BUFFER_TIME_IN_SEC', value: '60' });
    const settings = (await app.inject('/api/v1/admin/general-settings')).json<{
      data: { name: string; version: string }[];
    }>().data;
    const body = {
      operationId: randomUUID(),
      expectedVersion: settings.find((row) => row.name === 'HYPERLOCAL_STOCK_THRESHOLD')!.version,
      value: 0,
    };
    const url = '/api/v1/admin/general-settings/delivery-stock-threshold';
    expect((await app.inject({ method: 'PUT', url, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url, payload: body })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'PUT', url, payload: { ...body, value: 3 } })).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: { ...body, operationId: randomUUID(), value: -1 },
        })
      ).statusCode,
    ).toBe(400);
    const duration = '72:15';
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/general-settings/order-creation-buffer',
          payload: {
            operationId: randomUUID(),
            expectedVersion: settings.find(
              (row) => row.name === 'ORDER_CREATION_BUFFER_TIME_IN_SEC',
            )!.version,
            value: duration,
          },
        })
      ).statusCode,
    ).toBe(200);
    const source = JSON.parse(
      goldenStdout(
        'administration',
        'mysql-integration',
        JSON.stringify({ operation: 'order-buffer', cases: [{ value: duration }] }),
      ),
    ) as number[];
    const [values] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT platform,value FROM tss_settings WHERE id>=100 ORDER BY id',
    );
    expect(values.map((row) => row.value)).toEqual(['0', '0', String(source[0])]);
    expect(settingsDeliveries.map((row) => row.effect.kind)).toEqual([
      'setting.cache',
      'setting.cache',
      'buffer.notice',
    ]);
    // Legacy runs the cache SET and Slack notice inline; an unavailable effect is logged only.
    settingsAvailable = false;
    const latest = (await app.inject('/api/v1/admin/general-settings'))
      .json<{ data: { name: string; version: string }[] }>()
      .data.find((row) => row.name === 'HYPERLOCAL_STOCK_THRESHOLD')!;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: { operationId: randomUUID(), expectedVersion: latest.version, value: 5 },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('delivers common-channel timing notices with source text and sanitizes failed HTTP effects', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/delivery-slots',
      payload: { weekday: 'MON', start: '09:00', end: '22:00' },
    });
    const slot = (await app.inject('/api/v1/admin/stores/1/delivery-slots')).json<{
      data: { id: string; version: string }[];
    }>().data[0]!;
    let status = 503;
    const requests: { redirect: RequestRedirect | undefined; body: unknown }[] = [];
    const delivery = createSettingsDelivery(
      applicationConfig,
      db,
      readSettingsOptions({ SLACK_URL: 'https://hooks.slack.com/services/fixture/private' }),
      {
        fetcher: async (_url, init) => {
          requests.push({
            redirect: init?.redirect,
            body: JSON.parse(String(init?.body)) as unknown,
          });
          return new Response('private-canary@example.test', { status });
        },
      },
    );
    const logged: unknown[] = [];
    const inline = settingsService(applicationConfig, db, {
      settingsDelivery: delivery,
      moduleRuntime,
      log: (_level, event) => logged.push(event),
    });
    await inline.setDeliveryAvailability(actor, '1', slot.id, {
      operationId: randomUUID(),
      expectedVersion: slot.version,
      active: false,
    });
    expect(logged).toEqual([
      expect.objectContaining({
        eventId: 'administration.settings-effect.failed',
        errorCode: 'SETTINGS_NOTICE_UNAVAILABLE',
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain('private-canary');
    status = 200;
    const reopened = (await app.inject('/api/v1/admin/stores/1/delivery-slots')).json<{
      data: { id: string; version: string }[];
    }>().data[0]!;
    await inline.setDeliveryAvailability(actor, '1', slot.id, {
      operationId: randomUUID(),
      expectedVersion: reopened.version,
      active: false,
    });
    expect(logged).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.redirect).toBe('error');
    expect(requests[0]?.body).toEqual({
      text: expect.stringContaining(
        'MON slot of Fixture Store 1 marked as Closed by Fixture Person at',
      ),
    });
    expect(Object.keys(requests[0]!.body as Record<string, unknown>)).toEqual(['text']);
    await delivery.close?.();
  });
  it('holds the legacy ecommerce cooldown key, sends source notices and queues the inventory sync job', async () => {
    const url = '/api/v1/admin/stores/1/ecommerce-settings';
    const current = (await app.inject(url)).json<{ version: string }>();
    const body = {
      operationId: randomUUID(),
      expectedVersion: current.version,
      threshold: 2,
      active: true,
    };
    const closed = settingsService(applicationConfig, db, { settingsDelivery });
    await expect(closed.updateEcommerce(actor, '1', body)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    moduleRuntime.jobs.enqueued.length = 0;
    expect((await app.inject({ method: 'PUT', url, payload: body })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url, payload: body })).statusCode).toBe(200);
    const updated = (await app.inject(url)).json<{
      threshold: number;
      active: boolean;
      version: string;
      lockedUntil: string;
    }>();
    expect(updated).toMatchObject({ threshold: 2, active: true });
    expect(Date.parse(updated.lockedUntil)).toBeGreaterThan(Date.now());
    expect(
      (
        await app.inject({
          method: 'PUT',
          url,
          payload: {
            ...body,
            operationId: randomUUID(),
            expectedVersion: updated.version,
            threshold: 3,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(settingsDeliveries.map((row) => row.effect.kind)).toEqual([
      'ecommerce.threshold.notice',
      'ecommerce.availability.notice',
    ]);
    expect(
      moduleRuntime.jobs.enqueued.map(({ name, args, options }) => ({ name, args, options })),
    ).toEqual([
      {
        name: 'core.tasks.sync_ecom_inventory',
        args: { store_id: '1' },
        options: { queue: 'core' },
      },
    ]);
    expect(await moduleRuntime.ephemeral.ttl('ecom_delivery_1')).toBeGreaterThan(0);
    actor = { ...actor, id: '2', role: 2, storeIds: ['1'] };
    expect((await app.inject(url)).statusCode).toBe(403);
  });
  it('creates and updates guides with sanitized rich text, stable ordering and optimistic replay protection', async () => {
    const body = {
      operationId: randomUUID(),
      expectedVersion: '',
      title: 'Fixture guide',
      summary: 'Fixture summary',
      description:
        '<p>Safe <strong>steps</strong><script>private-canary</script><img src=x onerror=alert(1)></p>',
      keywords: 'fixture',
      sortOrder: 2,
      retainAssetIds: [],
      uploadIds: [],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation',
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const document = created.json<{ id: string; version: string }>();
    expect(document.version).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // pos_tutorial.updated_at is the version (1 s precision); pin an older value.
    const stale = '2026-01-01 00:00:00';
    await connection.query('UPDATE pos_tutorial SET updated_at=? WHERE id=?', [stale, document.id]);
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation',
      payload: body,
    });
    expect(repeated.json<{ id: string }>().id).toBe(document.id);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/documentation',
          payload: { ...body, title: 'Changed operation' },
        })
      ).statusCode,
    ).toBe(409);
    const detail = await app.inject(`/api/v1/documentation/${document.id}`);
    expect(detail.body).not.toContain('private-canary');
    expect(detail.json<{ descriptionHtml: string }>().descriptionHtml).toBe(
      '<p>Safe <strong>steps</strong></p>',
    );
    const edits = await Promise.all(
      ['First edit', 'Second edit'].map((title) =>
        app.inject({
          method: 'PUT',
          url: `/api/v1/admin/documentation/${document.id}`,
          payload: { ...body, operationId: randomUUID(), expectedVersion: stale, title },
        }),
      ),
    );
    expect(edits.map((value) => value.statusCode).sort()).toEqual([200, 409]);
    for (const [title, sortOrder] of [
      ['Priority guide', 9],
      ['Last guide', 1],
    ] as const)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/documentation',
            payload: { ...body, operationId: randomUUID(), title, sortOrder },
          })
        ).statusCode,
      ).toBe(201);
    const first = await app.inject('/api/v1/documentation?limit=1');
    const page = first.json<{ data: { title: string }[]; nextCursor: string }>();
    expect(page.data[0]?.title).toBe('Priority guide');
    const next = await app.inject(
      `/api/v1/documentation?limit=1&after=${encodeURIComponent(page.nextCursor)}`,
    );
    expect(next.json<{ data: { id: string }[] }>().data[0]?.id).toBe(document.id);
    const archived = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/documentation/${document.id}/status`,
      payload: { active: false },
    });
    expect(archived.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/documentation/${document.id}`,
          payload: { ...body, operationId: randomUUID(), expectedVersion: stale },
        })
      ).statusCode,
    ).toBe(409);
    actor = { ...actor, id: '5', role: 5, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/documentation',
          payload: { ...body, operationId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('attaches only verified owned uploads and serves private media through an authenticated guide resource', async () => {
    const id = randomUUID(),
      checksum = createHash('sha256').update('%PDF-fixture').digest('base64');
    const upload = {
      id,
      kind: 'document',
      name: 'Fixture guide.pdf',
      contentType: 'application/pdf',
      size: 12,
      checksum,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/documentation/uploads',
          payload: upload,
        })
      ).statusCode,
    ).toBe(201);
    const body = {
      operationId: randomUUID(),
      expectedVersion: '',
      title: 'Guide with media',
      summary: 'Fixture',
      description: '<p>Steps</p>',
      sortOrder: 1,
      uploadIds: [id],
      retainAssetIds: [],
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/documentation', payload: body }))
        .statusCode,
    ).toBe(409);
    mediaVerificationFailure = true;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/documentation/uploads/${id}/complete`,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    mediaVerificationFailure = false;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/documentation/uploads/${id}/complete`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation',
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const documentId = created.json<{ id: string }>().id;
    const detail = (await app.inject(`/api/v1/documentation/${documentId}`)).json<{
      assets: { id: string; name: string; url: string }[];
    }>();
    // Attached paths live only in pos_tutorial; the key keeps the original file name.
    expect(detail.assets[0]?.name).toBe('Fixture_guide.pdf');
    expect(detail.assets[0]?.url).toBe(
      `/api/v1/documentation/${documentId}/assets/${detail.assets[0]?.id}/content`,
    );
    actor = { ...actor, id: '5', role: 5, storeIds: ['1'] };
    const content = await app.inject(detail.assets[0]!.url);
    expect(content.statusCode).toBe(200);
    expect(content.body).toBe('%PDF-fixture');
    expect(content.headers['content-type']).toContain('application/pdf');
    expect(content.headers['content-disposition']).toContain('attachment');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    actor = { ...actor, id: '1', role: 1, storeIds: [] };
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/documentation/${documentId}/status`,
      payload: { active: false },
    });
    actor = { ...actor, id: '5', role: 5, storeIds: ['1'] };
    expect((await app.inject(detail.assets[0]!.url)).statusCode).toBe(404);
    expect(mediaVerifications).toHaveLength(2);
  });
  it('rechecks the current writer role before privileged guide mutations', async () => {
    actor = { ...actor, id: '3', role: 1, storeIds: ['1'] };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation',
      payload: {
        operationId: randomUUID(),
        expectedVersion: '',
        title: 'Denied guide',
        summary: 'Fixture',
        description: '',
        sortOrder: 0,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/v1/admin/documentation/100/status',
          payload: { active: false },
        })
      ).statusCode,
    ).toBe(403);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM pos_tutorial',
    );
    expect(String(rows[0]?.total)).toBe('0');
  });
  it('matches source POS barcode, variant pricing and image fallback without multiplying rows', async () => {
    const parent = {
      id: 1000,
      product: 'Fixture parent',
      parent_prod_id: 0,
      prod_type: 3,
      price: '999.00',
      spl_price: '899.00',
      erp_product: 'PARENT-ERP',
      images_new: '{"unisex":["parent image.png"]}',
      is_del: 0,
    };
    const variant = {
      id: 1001,
      product: 'Fixture variant',
      parent_prod_id: 1000,
      prod_type: 1,
      price: '0.00',
      spl_price: '0.00',
      erp_product: 'CHILD-ERP',
      images_new: '{}',
      is_del: 0,
    };
    await seed(Product, parent);
    await seed(Product, variant);
    await seed(ProductStore, {
      product_id: 1000,
      store_id: 1,
      stock: 5,
      is_avail: true,
      is_del: false,
    });
    await seed(ProductStore, {
      product_id: 1001,
      store_id: 1,
      stock: 4,
      is_avail: true,
      is_del: false,
    });
    const barcodes = [
      { id: 10, product_id: 1001, gtin: 9000000000001 },
      { id: 11, product_id: 1001, gtin: 1000000000001 },
    ];
    for (const barcode of barcodes) await seed(ProductBarcode, barcode);
    const prices = [
      { product_id: 1000, pricelist_id: 2, location_id: 0, price: '799.00' },
      { product_id: 1000, pricelist_id: 2, location_id: 1, price: '699.00' },
      { product_id: 1001, pricelist_id: 2, location_id: 0, price: '599.00' },
    ];
    for (const price of prices)
      await connection.execute(
        'INSERT INTO pricelist(product_id,pricelist_id,location_id,price) VALUES(?,?,?,?)',
        [price.product_id, price.pricelist_id, price.location_id, price.price],
      );
    const result = await catalogService(db).products(actor, '1', '', '0', 30, false);
    expect(result.data).toHaveLength(1);
    const expected: unknown = JSON.parse(
      goldenStdout(
        'administration',
        'mysql-integration',
        JSON.stringify({
          operation: 'catalog',
          cases: [{ product: variant, products: [parent, variant], barcodes, prices }],
        }),
      ),
    ) as unknown;
    expect(Array.isArray(expected)).toBe(true);
    const reference = expected as {
      barcode: number;
      price: string;
      specialPrice: string;
      exclusivePrice: string;
      image: string;
    }[];
    const actual = result.data[0]!;
    expect({
      barcode: actual.barcode,
      price: actual.price,
      specialPrice: actual.specialPrice,
      exclusivePrice: actual.exclusivePrice,
      image: actual.image,
    }).toEqual({ ...reference[0], barcode: String(reference[0]!.barcode) });
    expect(actual.erpName).toBe('PARENT-ERP');
    // Source uses icontains for names, numeric IDs and all GS1 records.
    const service = catalogService(db);
    for (const search of ['001', '000000', 'fIxTuRe'])
      expect((await service.products(actor, '1', search)).data.map((row) => row.id)).toEqual([
        '1001',
      ]);
    expect((await service.products(actor, '1', '%')).data).toEqual([]);
  });
  /** Operator 1 is a current staff superuser; operator 2 is role-1 staff without superuser. */
  async function modelAdministratorFixture() {
    await db
      .get('writer')
      .update(PosUser)
      .set({ is_staff: true, is_superuser: true })
      .where(eq(PosUser.id, 1n));
    await db
      .get('writer')
      .update(PosUser)
      .set({ role: 1, is_staff: true, is_superuser: false })
      .where(eq(PosUser.id, 2n));
  }
  async function administrativeProfileInput(operatorId = '4') {
    const current = await services.operatorAdministration.profile(actor, operatorId);
    return operatorAdminProfileInput.parse({
      operationId: randomUUID(),
      expectedVersion: current.revision,
      username: current.username,
      firstName: current.firstName,
      lastName: current.lastName,
      email: current.email,
      phone: current.phone,
      contactEmail: current.contactEmail,
      age: current.age,
      gender: current.gender,
      role: current.role,
      userType: current.userType,
      otpMethod: current.otpMethod,
      active: current.active,
      lastLogin: current.lastLogin,
      dateJoined: current.dateJoined,
    });
  }
  it('edits complete UserAdmin source fields with native username normalization, exact wall dates and safe DTOs', async () => {
    await modelAdministratorFixture();
    await db
      .get('writer')
      .update(PosUser)
      .set({
        password: 'private-password-hash-canary',
        mfa_hash: 'PRIVATESEEDCANARY',
        is_mfa: true,
      })
      .where(eq(PosUser.id, 4n));
    const view = await app.inject('/api/v1/admin/operators/4/administrative-profile');
    expect(view.statusCode).toBe(200);
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.body).not.toMatch(
      /private-password-hash-canary|PRIVATESEEDCANARY|mfa_hash|profile_image|cover_image/,
    );
    expect(view.json()).toMatchObject({ canEdit: true, canResetPassword: true, mfaEnabled: true });
    const sessionStore = testSessions(applicationConfig, db),
      credential = await sessionStore.create('4');
    const original = await administrativeProfileInput();
    const profile = {
      ...original,
      firstName: 'Revised',
      lastName: 'Operator',
      age: 42,
      gender: 'O' as const,
      lastLogin: '2000-02-29 23:59:58.123456',
      dateJoined: '1999-12-31 12:13:14.654321',
    };
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operators/4/administrative-profile',
      payload: profile,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ credentialsChanged: false });
    expect(await sessionStore.valid('4', credential)).toBe(true);
    expect(await services.operatorAdministration.profile(actor, '4')).toMatchObject({
      firstName: 'Revised',
      lastName: 'Operator',
      age: 42,
      gender: 'O',
      lastLogin: '2000-02-29 23:59:58.123456',
      dateJoined: '1999-12-31 12:13:14.654321',
    });
    expect(await services.operatorAdministration.updateProfile(actor, '4', profile)).toMatchObject({
      credentialsChanged: false,
    });
    await expect(
      services.operatorAdministration.updateProfile(actor, '4', {
        ...original,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'OPERATOR_ADMIN_PROFILE_CHANGED' });
    const current = await administrativeProfileInput();
    const normalized = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/operators/4/administrative-profile',
      payload: { ...current, username: 'ｆｌｏｏｒ.ｆｉｘｔｕｒｅ' },
    });
    expect(normalized.statusCode).toBe(200);
    expect((await services.operatorAdministration.profile(actor, '4')).username).toBe(
      'floor.fixture',
    );
    // Legacy ends sessions only on a password change or deactivation (W3, sessions.ts).
    expect(await sessionStore.valid('4', credential)).toBe(true);
    const duplicates = { ...(await administrativeProfileInput()), username: 'fixture3' };
    await expect(
      services.operatorAdministration.updateProfile(actor, '4', duplicates),
    ).rejects.toMatchObject({ code: 'OPERATOR_IDENTITY_UNAVAILABLE' });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/operators/4/administrative-profile',
          payload: { ...duplicates, mfaHash: 'must-never-accept' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('requires a current staff superuser and refuses self changes for administrative profiles', async () => {
    await modelAdministratorFixture();
    const update = await administrativeProfileInput(),
      scoped = { ...actor, id: '2' };
    // Groups/permissions were deleted: a non-superuser staff account has no model access.
    await expect(services.operatorAdministration.profile(scoped, '4')).rejects.toMatchObject({
      code: 'MODEL_ADMINISTRATION_DENIED',
    });
    await expect(
      services.operatorAdministration.updateProfile(scoped, '4', update),
    ).rejects.toMatchObject({ status: 403 });
    expect(await services.operatorAdministration.capabilities(scoped)).toEqual({
      canViewOperators: false,
    });
    expect(await services.operatorAdministration.capabilities(actor)).toEqual({
      canViewOperators: true,
    });
    await expect(
      services.operatorAdministration.updateProfile(
        actor,
        '1',
        await administrativeProfileInput('1'),
      ),
    ).rejects.toMatchObject({ code: 'SELF_ADMIN_PROFILE_CHANGE_DENIED' });
    await db.get('writer').update(PosUser).set({ is_superuser: true }).where(eq(PosUser.id, 2n));
    expect((await services.operatorAdministration.profile(scoped, '4')).canEdit).toBe(true);
    await db.get('writer').update(PosUser).set({ is_staff: false }).where(eq(PosUser.id, 2n));
    await expect(
      services.operatorAdministration.updateProfile(scoped, '4', update),
    ).rejects.toMatchObject({ status: 403 });
    expect((await services.operatorAdministration.profile(actor, '4')).username).toBe('fixture4');
  });
  it('keeps sessions across identity edits and ends them on deactivation, as legacy', async () => {
    await modelAdministratorFixture();
    const sessions = testSessions(applicationConfig, db),
      credential = await sessions.create('4');
    const original = await administrativeProfileInput();
    const changed = { ...original, username: 'different.login' };
    expect(await services.operatorAdministration.updateProfile(actor, '4', changed)).toMatchObject({
      credentialsChanged: true,
    });
    // Same operation id: the Redis receipt replays the original result.
    expect(await services.operatorAdministration.updateProfile(actor, '4', changed)).toMatchObject({
      credentialsChanged: true,
    });
    await expect(
      services.operatorAdministration.updateProfile(actor, '4', {
        ...changed,
        firstName: 'Different input',
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_OPERATION_REUSED' });
    expect(await sessions.valid('4', credential)).toBe(true);
    await services.operatorAdministration.updateProfile(actor, '4', {
      ...(await administrativeProfileInput()),
      active: false,
    });
    expect(await sessions.valid('4', credential)).toBe(false);
  });
  it('uses source password policy, current superuser authority and idempotent write-only password resets', async () => {
    await modelAdministratorFixture();
    const sessions = testSessions(applicationConfig, db),
      credential = await sessions.create('4');
    const current = await services.operatorAdministration.profile(actor, '4');
    const input = {
      operationId: randomUUID(),
      expectedVersion: current.revision,
      newPassword: 'Riv3r!Cobalt-Forest#89',
      confirmation: 'Riv3r!Cobalt-Forest#89',
    };
    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operators/4/password-resets',
      payload: { ...input, newPassword: 'password', confirmation: 'password' },
    });
    expect(weak.statusCode).toBe(400);
    expect(await sessions.valid('4', credential)).toBe(true);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operators/4/password-resets',
      payload: input,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(saved.body).not.toMatch(/Riv3r|pbkdf2|Cobalt/);
    const [account] = await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n));
    // Django 4.2 PBKDF2 iterations (W3, S6: `DJANGO_PBKDF2_ITERATIONS`).
    expect(account?.password).toMatch(/^pbkdf2_sha256\$600000\$/);
    expect(await verifyDjangoPassword(input.newPassword, account!.password)).toBe(true);
    expect(await sessions.valid('4', credential)).toBe(false);
    await services.operatorAdministration.resetPassword(actor, '4', input);
    expect(
      (await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n)))[0]?.password,
    ).toBe(account?.password);
    await expect(
      services.operatorAdministration.resetPassword({ ...actor, id: '2' }, '4', input),
    ).rejects.toMatchObject({ code: 'MODEL_ADMINISTRATION_DENIED' });
    await expect(
      services.operatorAdministration.resetPassword(actor, '1', {
        ...input,
        expectedVersion: (await services.operatorAdministration.profile(actor, '1')).revision,
      }),
    ).rejects.toMatchObject({ code: 'SELF_ADMIN_PROFILE_CHANGE_DENIED' });
  }, 5000);
  it('reuses private profile lifecycle for actor-bound managed images', async () => {
    await modelAdministratorFixture();
    await db.get('writer').update(PosUser).set({ is_superuser: true }).where(eq(PosUser.id, 2n));
    const scoped = { ...actor, id: '2' },
      service = services.operatorAdministration;
    const current = await service.profile(scoped, '4');
    const input = imageReservationInput.parse({
      revision: current.revision,
      upload: {
        id: randomUUID(),
        kind: 'image',
        name: 'Private operator.png',
        contentType: 'image/png',
        size: storeImageBytes.length,
        checksum: createHash('sha256').update(storeImageBytes).digest('base64'),
      },
    });
    await service.images.reserve(scoped, '4', input);
    await expect(
      service.images.attach(actor, '4', input.upload.id, input.revision),
    ).rejects.toMatchObject({ code: 'OPERATOR_ADMIN_UPLOAD_NOT_FOUND' });
    await expect(
      service.images.attach(scoped, '3', input.upload.id, input.revision),
    ).rejects.toMatchObject({ code: 'OPERATOR_ADMIN_UPLOAD_NOT_FOUND' });
    await expect(
      profileMediaService(applicationConfig, db, operatorImageStore, testAuthRedis).attach(
        { ...actor, id: '4', role: 4 },
        input.upload.id,
        input.revision,
      ),
    ).rejects.toMatchObject({ code: 'PROFILE_UPLOAD_NOT_FOUND' });
    const valid = storeImageBytes;
    storeImageBytes = Buffer.from('not-a-real-image');
    await expect(
      service.images.attach(scoped, '4', input.upload.id, input.revision),
    ).rejects.toMatchObject({ status: 400 });
    storeImageBytes = valid;
    await service.images.attach(scoped, '4', input.upload.id, input.revision);
    // W3's Redis reservation is consumed on success (src/auth/image-reservations.ts).
    actor = scoped;
    const streamed = await app.inject('/api/v1/admin/operators/4/profile/images/image');
    expect(streamed.statusCode).toBe(200);
    expect(streamed.rawPayload).toEqual(valid);
    expect(streamed.headers['cache-control']).toBe('private, no-store');
    const profile = await service.profile(scoped, '4');
    expect(JSON.stringify(profile)).not.toContain('uploads/users/');
    const replacement = imageReservationInput.parse({
      ...input,
      revision: profile.revision,
      upload: { ...input.upload, id: randomUUID() },
    });
    await service.images.reserve(scoped, '4', replacement);
    await db.get('writer').update(PosUser).set({ is_superuser: false }).where(eq(PosUser.id, 2n));
    const verificationCount = storeImageVerifications.length;
    await expect(
      service.images.attach(scoped, '4', replacement.upload.id, replacement.revision),
    ).rejects.toMatchObject({ status: 403 });
    expect(storeImageVerifications).toHaveLength(verificationCount);
  });
  it('returns an exact auto-generated counter ID above the JavaScript safe integer range', async () => {
    const highId = '9007199254740993';
    await connection.query('ALTER TABLE store_counters AUTO_INCREMENT=9007199254740993');
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/stores/1/counters',
        payload: { description: 'Lossless fixture' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json<{ id: string }>().id).toBe(highId);
      const [row] = await db
        .get('writer')
        .select()
        .from(StoreCounter)
        .where(eq(StoreCounter.id, BigInt(highId)));
      expect(row?.counter_desc).toBe('Lossless fixture');
    } finally {
      await db
        .get('writer')
        .delete(StoreCounter)
        .where(eq(StoreCounter.id, BigInt(highId)));
      await connection.query('ALTER TABLE store_counters AUTO_INCREMENT=3');
    }
  }, 5000);
  it('activates an authenticator only after exact source TOTP verification, keeping sessions as legacy', async () => {
    let uri = '';
    const timestamp = 1805328000000,
      service = operatorMfaService(
        applicationConfig,
        db,
        () => timestamp,
        async (value) => {
          uri = value;
          return 'data:image/png;base64,aGVsbG8=';
        },
      );
    const sessions = testSessions(applicationConfig, db),
      credential = await sessions.create('4');
    expect(await sessions.valid('4', credential)).toBe(true);
    const current = await service.read(actor, '4'),
      id = randomUUID();
    await service.start(actor, '4', { operationId: id, expectedVersion: current.version });
    const secret = new URL(uri).searchParams.get('secret')!,
      code = new TOTP({
        secret: Secret.fromBase32(secret),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }).generate({ timestamp });
    await expect(service.confirm(actor, '4', id, { code })).resolves.toMatchObject({
      status: 'success',
    });
    await expect(service.confirm(actor, '4', id, { code })).resolves.toMatchObject({
      status: 'success',
    });
    // Legacy ends sessions only on a password change or deactivation (W3, sessions.ts).
    expect(await sessions.valid('4', credential)).toBe(true);
    const [target] = await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n));
    expect(target).toMatchObject({ is_mfa: true, mfa_hash: secret });
    await expect(
      service.start(actor, '4', {
        operationId: randomUUID(),
        expectedVersion: (await service.read(actor, '4')).version,
      }),
    ).rejects.toMatchObject({ code: 'MFA_ALREADY_ACTIVATED' });
  });
  it('rechecks MFA actor roles, full store coverage and franchise scope on the writer', async () => {
    const service = operatorMfaService(applicationConfig, db);
    const scopedActor: Principal = { ...actor, id: '2', role: 2, storeIds: ['1'] };
    await expect(service.read(scopedActor, '4')).rejects.toMatchObject({
      code: 'OPERATOR_SCOPE_DENIED',
    });
    await expect(service.read(scopedActor, '1')).rejects.toMatchObject({
      code: 'OPERATOR_ROLE_DENIED',
    });
    expect(await service.read(scopedActor, '2')).toMatchObject({ canReplace: false });
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 2n));
    await expect(service.read(scopedActor, '4')).rejects.toMatchObject({
      code: 'OPERATOR_SCOPE_DENIED',
    });
    await db.get('writer').update(PosUser).set({ role: 5 }).where(eq(PosUser.id, 1n));
    await expect(service.read(actor, '4')).rejects.toMatchObject({ status: 403 });
  });
  it('rejects stale enrollments and requires verified write-only replacement with idempotent reset receipts', async () => {
    let uri = '';
    const timestamp = 1805328000000,
      service = operatorMfaService(
        applicationConfig,
        db,
        () => timestamp,
        async (value) => {
          uri = value;
          return 'data:image/png;base64,aGVsbG8=';
        },
      );
    const current = await service.read(actor, '4'),
      enrollmentId = randomUUID();
    await service.start(actor, '4', {
      operationId: enrollmentId,
      expectedVersion: current.version,
    });
    await db.get('writer').update(PosUser).set({ phone: '9876543200' }).where(eq(PosUser.id, 4n));
    const generatedSecret = new URL(uri).searchParams.get('secret')!,
      code = new TOTP({ secret: Secret.fromBase32(generatedSecret) }).generate({ timestamp });
    await expect(service.confirm(actor, '4', enrollmentId, { code })).rejects.toMatchObject({
      code: 'MFA_SETTINGS_CHANGED',
    });
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      validCode = new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp });
    const replacement = {
      operationId: randomUUID(),
      expectedVersion: (await service.read(actor, '4')).version,
      mode: 'replace' as const,
      secret,
      code: validCode,
    };
    await expect(
      service.update(actor, '4', {
        ...replacement,
        code: validCode === '000000' ? '000001' : '000000',
      }),
    ).rejects.toMatchObject({ code: 'MFA_CODE_INVALID' });
    expect(await service.update(actor, '4', replacement)).toMatchObject({ status: 'success' });
    expect(await service.update(actor, '4', replacement)).toMatchObject({ status: 'success' });
    await expect(
      service.update(actor, '4', { ...replacement, mode: 'disable' }),
    ).rejects.toMatchObject({ code: 'MFA_OPERATION_REUSED' });
    const disabled = await service.update(actor, '4', {
      operationId: randomUUID(),
      expectedVersion: (await service.read(actor, '4')).version,
      mode: 'disable',
    });
    expect(disabled.message).toContain('disabled');
    const [target] = await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n));
    expect(target).toMatchObject({ is_mfa: false, mfa_hash: null });
    await expect(service.confirm(actor, '4', enrollmentId, { code })).rejects.toMatchObject({
      code: 'MFA_ENROLLMENT_EXPIRED',
    });
  });
  it('serves strict non-cacheable MFA HTTP contracts without exposing existing seeds', async () => {
    const response = await app.inject('/api/v1/admin/operators/4/mfa');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toMatch(/secret|mfa_hash|qrDataUrl/);
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/operators/4/mfa-enrollments',
      payload: {
        operationId: randomUUID(),
        expectedVersion: response.json<{ version: string }>().version,
      },
    });
    expect(started.statusCode).toBe(201);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.json<{ qrDataUrl: string }>().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const id = started.json<{ id: string }>().id;
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/operators/4/mfa-enrollments/${id}/verification`,
      payload: { code: '12345', secret: 'must-not-be-accepted' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/v1/admin/operators/4/mfa-enrollments/${id}`,
        })
      ).statusCode,
    ).toBe(200);
  });
  it('preserves the stock toggle and archived-parent sellability branches', async () => {
    await seed(Product, {
      id: 2000,
      product: 'Archived parent',
      parent_prod_id: 0,
      prod_type: 3,
      is_del: 1,
    });
    for (const [id, parentId, stock, deleted, available] of [
      [2001, 0, 0, 0, 1],
      [2002, 2000, 0, 0, 1],
      [2003, 2000, 2, 1, 1],
      [2004, 0, 2, 0, 0],
    ]) {
      await seed(Product, {
        id: id!,
        product: `Fixture ${id}`,
        parent_prod_id: parentId!,
        prod_type: 1,
        is_del: deleted!,
      });
      await seed(ProductStore, {
        product_id: id!,
        store_id: 1,
        stock: stock!,
        is_avail: Boolean(available),
        is_del: false,
      });
    }
    const service = catalogService(db);
    expect(
      (await service.products(actor, '1', '', '0', 30, false)).data.map((row) => row.id),
    ).toEqual(['2003']);
    expect(
      (await service.products(actor, '1', '', '0', 30, true)).data.map((row) => row.id),
    ).toEqual(['2001', '2003']);
  });
  it('preserves existing parent inventory when associating a previously missing child', async () => {
    await seed(Product, { id: 6000, product: 'Existing parent', prod_type: 3, parent_prod_id: 0 });
    await seed(Product, { id: 6001, product: 'Missing child', prod_type: 1, parent_prod_id: 6000 });
    await seed(ProductStore, {
      product_id: 6000,
      store_id: 1,
      stock: 19,
      is_avail: false,
      is_del: true,
    });
    const calls: StockProcedureInput[] = [];
    const inventory = inventoryService(applicationConfig, db, {
      procedureVerified: true,
      productSync: async () => true,
      stockProcedure: async (_tx, input) => {
        calls.push(input);
      },
    });
    await inventory.setStock(actor, '1', '6001', 5, 0);
    const rows = await db
      .get('writer')
      .select()
      .from(ProductStore)
      .where(eq(ProductStore.store, 1n));
    expect(rows.find((row) => row.product === 6000n)).toMatchObject({
      stock: 19,
      is_avail: false,
      is_del: true,
    });
    expect(rows.find((row) => row.product === 6001n)).toMatchObject({
      stock: 5,
      is_avail: true,
      is_del: false,
    });
    expect(calls.map((call) => call.productId)).toEqual(['6001']);
  });
  it('matches source postal joins, title casing, exact coordinate strings and first indexed duplicate', async () => {
    await seed(Country, { id: 99, name: 'Fixture country', status: 0 });
    await seed(locationZones, { id: 42, name: 'Fixture state' });
    for (const [id, city, latitude] of [
      [9007199254740993n, 'straße', '19.0000000000000001'],
      [9007199254740994n, 'Other City', '20.5'],
    ] as const)
      await seed(deliverablePincodes, {
        id,
        pincode: '400001',
        city,
        state_id: 42,
        country_id: 99,
        latitude,
        longitude: '72.0000000000000001',
      });
    const oracle = (row: unknown) =>
      JSON.parse(
        goldenStdout(
          'administration',
          'mysql-integration',
          JSON.stringify({
            operation: 'postal-lookup',
            cases: [{ pincode: '400001', row }],
          }),
        ),
      ) as {
        statement: string;
        parameters: string[];
        response: { data: Record<string, unknown> };
      }[];
    const source = oracle(null)[0]!;
    const [rows] = await connection.execute<mysql.RowDataPacket[]>(
      source.statement.replace('%s', '?'),
      source.parameters,
    );
    const first = rows[0]!;
    const expected = oracle([
      String(first.id),
      first.pincode,
      first.city,
      first.state,
      first.country,
      first.country_id,
      first.latitude,
      first.longitude,
      first.state_id,
    ])[0]!.response.data;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/locations/postal-code-lookups',
      payload: { postalCode: '400001' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json<{ data: unknown }>().data).toEqual({
      postalCode: expected.pincode,
      city: expected.city,
      state: expected.state,
      country: expected.country,
      countryId: String(expected.country_id),
      stateId: String(expected.state_id),
      latitude: expected.latitude,
      longitude: expected.longitude,
    });
    expect((await services.locations.find(actor, { postalCode: '999999' })).data).toBeNull();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/locations/postal-code-lookups?postalCode=400001',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/locations/postal-code-lookups',
          payload: { postalCode: "400001' OR 1=1" },
        })
      ).statusCode,
    ).toBe(400);
    expect(await db.get('writer').select().from(deliverablePincodes)).toHaveLength(2);
  });
  it('keeps current franchise role1 scoped to assigned franchise stores for writer actions, check-in display and notification recipients', async () => {
    await expect(
      db.get('writer').transaction((tx) => assertCurrentStoreAccess(tx, '1', '2')),
    ).resolves.toBeUndefined();
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 1n));
    await seed(UserStore, { django_user_id: 1, store_id: 1 });
    await expect(
      db.get('writer').transaction((tx) => assertCurrentStoreAccess(tx, '1', '1')),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await db.get('writer').update(Store).set({ category: 'FRANCHISE' }).where(eq(Store.id, 1n));
    await db.get('writer').update(Store).set({ category: 'FRANCHISE' }).where(eq(Store.id, 2n));
    await expect(
      db.get('writer').transaction((tx) => assertCurrentStoreAccess(tx, '1', '1')),
    ).resolves.toBeUndefined();
    await expect(
      db.get('writer').transaction((tx) => assertCurrentStoreAccess(tx, '1', '2')),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await services.checkins.set(actor, '1', null);
    expect(await services.checkins.checkedInStore('1')).toBe('1');
    expect(await services.checkins.checkedInUsers('1')).toContain('1');
    await db.get('writer').delete(UserStore).where(eq(UserStore.django_user_id, 1n));
    // Legacy check-in display reads only the check_in_* keys; writer actions recheck scope.
    expect(await services.checkins.checkedInStore('1')).toBe('1');
    expect(await services.checkins.current(actor)).toMatchObject({ storeId: '1' });
    await expect(
      db
        .get('writer')
        .transaction((tx) => services.checkins.assertCheckIn('1', '1', undefined, tx)),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await seed(UserStore, { django_user_id: 1, store_id: 1 });
    await db.get('writer').update(Store).set({ category: 'IN_HOUSE' }).where(eq(Store.id, 1n));
    await expect(
      db
        .get('writer')
        .transaction((tx) => services.checkins.assertCheckIn('1', '1', undefined, tx)),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
  });
  it('provides a minimal active same-store salesperson picker without trusting the first legacy global assignment', async () => {
    for (const [id, active] of [
      [701, 1],
      [702, 1],
      [703, 0],
      [2147483648n, 1],
    ] as const)
      await seed(SalesPerson, {
        id,
        first_name: 'Fixture',
        last_name: String(id),
        user_type: 1,
        is_active: active,
      });
    for (const row of [
      { id: 801, salesperson_id: 701, store_id: 1, is_active: 0 },
      { id: 802, salesperson_id: 701, store_id: 2, is_active: 1 },
      { id: 803, salesperson_id: 702, store_id: 2, is_active: 1 },
      { id: 804, salesperson_id: 702, store_id: 1, is_active: 1 },
      { id: 805, salesperson_id: 703, store_id: 1, is_active: 1 },
      { id: 806, salesperson_id: 2147483648n, store_id: 1, is_active: 1 },
    ])
      await seed(StoreSalesPerson, row);
    const url = '/api/v1/stores/1/salespeople?purpose=checkout&after=700&limit=100&active=true';
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [{ id: '702', name: 'Fixture 702' }],
      nextCursor: null,
    });
    expect(response.body).not.toMatch(/email|phone|employee_id|storeIds|activeStoreId/);
    expect(
      (await app.inject({ method: 'GET', url: url.replace('active=true', 'active=all') }))
        .statusCode,
    ).toBe(400);
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 1n));
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
  });
});
