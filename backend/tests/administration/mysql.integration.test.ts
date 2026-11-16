import { readFileSync } from 'node:fs';
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
import { mysqlSessions } from '../../src/auth/sessions.js';
import { verifyDjangoPassword } from '../../src/auth/crypto.js';
import { profileMediaService } from '../../src/auth/profile-media.js';
import { profileMediaCleanup } from '../../src/auth/profile-media-worker.js';
import { profileUploads } from '../../src/auth/profile-media-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { registerAdministration } from '../../src/modules/administration/index.js';
import {
  enqueueInventorySynchronization,
  enqueueSystemInventorySynchronization,
  type InventorySynchronizationContext,
} from '../../src/modules/administration/inventory.js';
import { catalogService } from '../../src/modules/catalog.js';
import { execFileSync } from 'node:child_process';
import {
  legacyFixtureRecord,
  legacyFixtureTableSql,
} from '../../tools/administration/mysql-fixture.js';
import {
  administrationWorker,
  retryInventorySynchronization,
  type AdministrationWorkerEvent,
} from '../../src/modules/administration/worker.js';
import { readAdministrationWorkerOptions } from '../../src/modules/administration/worker-options.js';
import type {
  DocumentationMediaStore,
  ReservedMedia,
} from '../../src/modules/administration/media-storage.js';
import { documentationMediaCleanup } from '../../src/modules/administration/media-cleanup.js';
import {
  documentationMediaWorker,
  type MediaWorkerEvent,
} from '../../src/modules/administration/media-worker.js';
import { readDocumentationMediaOptions } from '../../src/modules/administration/media-storage.js';
import { settingsOutbox } from '../../src/modules/administration/settings-outbox.js';
import { settingsService } from '../../src/modules/administration/settings.js';
import { readSettingsWorkerOptions } from '../../src/modules/administration/settings-options.js';
import {
  settingsWorker,
  type SettingsWorkerEvent,
} from '../../src/modules/administration/settings-worker.js';
import type {
  SettingsEffect,
  SettingsEffectDelivery,
} from '../../src/modules/administration/settings-domain.js';
import { createSettingsDelivery } from '../../src/modules/administration/settings-adapters.js';
import { inventoryImportService } from '../../src/modules/administration/imports.js';
import { inventoryService } from '../../src/modules/administration/inventory.js';
import { assertCurrentStoreAccess } from '../../src/modules/administration/authorization.js';
import { stockCsv, stockImportHeaders } from '../../src/modules/administration/import-domain.js';
import type { StockProcedureInput } from '../../src/modules/administration/stock-procedure.js';
import {
  inventoryImportHistory,
  readImportHistoryOptions,
} from '../../src/modules/administration/import-history.js';
import { operatorMfaService } from '../../src/modules/administration/mfa.js';
import { operatorMfaEnrollments } from '../../src/modules/administration/mfa-schema.js';
import {
  storeImageCleanup,
  storeImageService,
} from '../../src/modules/administration/store-images.js';
import {
  storeImageJobs,
  storeImageUploads,
} from '../../src/modules/administration/store-image-schema.js';
import { storeImageUploadInput } from '../../src/modules/administration/store-images.js';
import type { ImageCleanupEvent } from '../../src/modules/administration/image-lifecycle/cleanup.js';
import { operatorAuthEpochs, invalidateOperatorAuthentication } from '../../src/auth/revocation.js';
import {
  deliverablePincodes,
  locationZones,
} from '../../src/modules/administration/location-schema.js';
import { slackConnections } from '../../src/modules/administration/slack-schema.js';
import {
  pruneSlackConnections,
  slackConnectionService,
} from '../../src/modules/administration/slack-connections.js';
import type { SlackOAuthProvider } from '../../src/modules/administration/slack-provider.js';
import { loginChallenges, loginSecurity } from '../../src/auth/mfa-schema.js';
import { reconcileAdministrationAccess } from '../../src/modules/administration/access-reconciliation.js';
import {
  administrationAccessReconciliation,
  administrationDirectPermissions,
  administrationGroupPermissions,
  administrationGroups,
  administrationMemberships,
  administrationPermissions,
} from '../../src/modules/administration/access-schema.js';
import { assertModelAdministrationPermission } from '../../src/modules/administration/access-control.js';
import { imageReservationInput } from '../../src/modules/administration/image-lifecycle/domain.js';
import { operatorAdminProfileInput } from '../../src/modules/administration/operator-admin-domain.js';

const template = process.env.ADMINISTRATION_MYSQL_TEST_URL;
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
  let slackExchanges = 0,
    slackExchangeFailure = false;
  let duringSlackExchange: (() => Promise<void>) | undefined;
  const slackProvider: SlackOAuthProvider = {
    configurationVersion: 'c'.repeat(64),
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
      slackExchanges++;
      if (slackExchangeFailure) throw new Error('private-slack-token@example.test');
      await duringSlackExchange?.();
      return {
        webhook: 'https://hooks.slack.com/services/T0123456789/B0123456789/privateFixtureWebhook',
        channel: '#fixture-sales',
        channelId: 'C0123456789',
        teamId: 'T0123456789',
      };
    },
  };
  let applicationConfig: ReturnType<typeof readConfig>;
  let deliveryFailure = false;
  let settingsAvailable = true;
  const settingsFailures = new Set<SettingsEffect['kind']>();
  const settingsDeliveries: { id: string; effect: SettingsEffect }[] = [];
  const settingsDelivery: SettingsEffectDelivery = {
    supports: () => settingsAvailable,
    async deliver(id, effect, signal) {
      signal?.throwIfAborted();
      settingsDeliveries.push({ id, effect });
      if (settingsFailures.has(effect.kind)) throw new Error('private-canary@example.test');
    },
  };
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
  const deliveries: { id: string; products: string[]; context: InventorySynchronizationContext }[] =
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
      'ALTER TABLE product_store ADD UNIQUE KEY uq_product_store(product_id,store_id)',
    );
    await connection.query('ALTER TABLE deliverable_pincodes ADD KEY pincode(pincode)');
    await connection.query(
      'ALTER TABLE pos_user MODIFY last_login DATETIME(6) NULL, MODIFY date_joined DATETIME(6) NOT NULL',
    );
    for (const file of [
      'migrations/0002_auth_sessions.sql',
      'migrations/0003_login_challenges.sql',
      'migrations/0005_profile_media.sql',
      'migrations/0006_operator_auth_epochs.sql',
      'src/modules/administration/migration.sql',
      'src/modules/administration/media-migration.sql',
      'src/modules/administration/settings-migration.sql',
      'src/modules/administration/import-migration.sql',
      'src/modules/administration/parent-store-imports/migration.sql',
      'src/modules/administration/mfa-migration.sql',
      'src/modules/administration/store-image-migration.sql',
      'src/modules/administration/access-migration.sql',
      'src/modules/administration/slack-migration.sql',
    ])
      for (const statement of readFileSync(file, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((s) => s.trim()))
        await connection.query(statement);
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
    services = registerAdministration(app, config, db, {
      defaultStoreOperatorIds: ['2'],
      mediaStore: media,
      storeImageStore,
      operatorImageStore,
      slackOAuth: slackProvider,
      syncProducts: async (id, products, context) => {
        deliveries.push({ id, products, context });
        if (deliveryFailure) throw new Error('Fixture dependency outage');
      },
      procedureVerified: false,
      settingsDelivery,
      ecommerceSyncVerified: true,
    });
    await app.ready();
  });
  beforeEach(async () => {
    slackExchanges = 0;
    slackExchangeFailure = false;
    duringSlackExchange = undefined;
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
    await connection.query('DELETE FROM pos_rewrite_operator_checkins');
    await connection.query('DELETE FROM pos_rewrite_administration_outbox');
    for (const table of [
      'pos_rewrite_documentation_assets',
      'pos_rewrite_documentation_revisions',
      'pos_rewrite_documentation_mutations',
      'pos_rewrite_settings_effects',
      'pos_rewrite_settings_mutations',
      'pos_rewrite_ecommerce_changes',
      'pos_rewrite_inventory_import_rows',
      'pos_rewrite_inventory_imports',
      'pos_rewrite_operator_mfa_enrollments',
      'pos_rewrite_operator_mfa_mutations',
      'pos_rewrite_sessions',
      'pos_rewrite_login_challenges',
      'pos_rewrite_login_security',
      'pos_rewrite_operator_auth_epochs',
      'pos_rewrite_profile_uploads',
      'pos_rewrite_profile_media_jobs',
      'pos_rewrite_store_image_uploads',
      'pos_rewrite_store_image_jobs',
      'pos_rewrite_administration_permissions',
      'pos_rewrite_administration_groups',
      'pos_rewrite_administration_group_permissions',
      'pos_rewrite_administration_memberships',
      'pos_rewrite_administration_direct_permissions',
      'pos_rewrite_administration_access_reconciliation',
      'pos_rewrite_administration_access_mutations',
      'pos_rewrite_slack_connections',
    ])
      await connection.query('DELETE FROM ' + mysql.escapeId(table));
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
    expect((await app.inject('/api/v1/admin/stores?search=LOC-2')).json()).toEqual({ data: [], nextCursor: null });
    expect((await app.inject('/api/v1/admin/stores?search=LOC-3')).json()).toEqual({ data: [], nextCursor: null });
    expect((await app.inject('/api/v1/admin/stores?active=false')).json()).toMatchObject({ data: [{ id: '5' }], nextCursor: null });
    actor = { ...actor, storeIds: [] };
    expect((await app.inject('/api/v1/admin/stores?active=all')).json()).toEqual({ data: [], nextCursor: null });
    await db.get('writer').update(PosUser).set({ user_type: 1 }).where(eq(PosUser.id, 1n));
    actor = { ...actor, userType: 1 };
    const internal = (await app.inject('/api/v1/admin/stores?active=all')).json<{ data: { id: string }[] }>();
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
      payload: { name: 'Back', description: 'Fixture storage', type: 'STORAGE' },
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
  it('edits storage names without a second prefix and moves only empty storage within actor scope', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/storages',
      payload: { name: 'Back', description: 'Storage', type: 'STORAGE' },
    });
    const storageId = created.json<{ id: string }>().id;
    const body = { name: 'FIXTURE-STRG-RENAMED', description: 'Changed', type: 'STORAGE' };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/storages/${storageId}`,
          payload: body,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({ method: 'GET', url: `/api/v1/admin/stores/1/storages/${storageId}` })
      ).json<{ storage_name: string }>().storage_name,
    ).toBe(body.name);
    await seed(StockStorage, { product_id: 1001, store_id: 1, storage_id: storageId, stock: 2 });
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/storages/${storageId}`,
          payload: { ...body, destinationStoreId: '2' },
        })
      ).statusCode,
    ).toBe(409);
    await connection.query('DELETE FROM stock_storages');
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/storages/${storageId}`,
          payload: { ...body, destinationStoreId: '2' },
        })
      ).statusCode,
    ).toBe(403);
    actor = { ...actor, id: '1', role: 1, storeIds: [] };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/admin/stores/1/storages/${storageId}`,
          payload: { ...body, destinationStoreId: '2' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/admin/stores/1/storages/${storageId}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/admin/stores/2/storages/${storageId}` }))
        .statusCode,
    ).toBe(200);
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
      ['1', 0],
      ['2', 1],
    ]);
  });
  it('rolls check-in back with a caller-owned authentication transaction', async () => {
    await expect(
      db.get('writer').transaction(async (transaction) => {
        await services.checkins.set(actor, '1', '1', transaction);
        throw new Error('Fixture authentication rollback');
      }),
    ).rejects.toThrow('Fixture authentication rollback');
    expect(await services.checkins.checkedInStore('1')).toBeNull();
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
      name: 'New Fixture Store',
      shortName: 'New fixture',
      locationCode: 'LOC-3',
      type: 'STORE',
      category: 'IN_HOUSE',
      latitude: '19.0760',
      longitude: '72.8777',
      address: 'Fixture address',
      cityId: 0,
      countryId: 0,
      phone: '9876543299',
    };
    const results = await Promise.all(
      [1, 2].map(() => app.inject({ method: 'POST', url: '/api/v1/admin/stores', payload })),
    );
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
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
  it('associates an existing franchise without mutating its shared details or creating a duplicate', async () => {
    await seed(POSFranchise, {
      id: 20,
      name: 'Existing fixture franchise',
      description: 'Shared description',
      cin_number: 'FIXTURE-CIN',
    });
    const payload = {
      name: 'Associated Fixture Store',
      shortName: 'Associated',
      locationCode: 'LOC-3',
      type: 'STORE',
      category: 'FRANCHISE',
      latitude: '19',
      longitude: '72',
      address: 'Fixture address',
      cityId: 0,
      countryId: 0,
      phone: '9876543298',
      franchiseId: '20',
    };
    const response = await app.inject({ method: 'POST', url: '/api/v1/admin/stores', payload });
    expect(response.statusCode).toBe(201);
    const id = response.json<{ id: string }>().id;
    const store = (await app.inject(`/api/v1/admin/stores/${id}`)).json<{
      franchise_id: number;
      franchise: { id: string; name: string; description: string; cin: string };
    }>();
    expect(store.franchise_id).toBe(20);
    expect(store.franchise).toEqual({
      id: '20',
      name: 'Existing fixture franchise',
      description: 'Shared description',
      cin: 'FIXTURE-CIN',
    });
    expect(await db.get('primary').select({ id: POSFranchise.id }).from(POSFranchise)).toHaveLength(
      1,
    );
    await db
      .get('writer')
      .update(TssSetting)
      .set({ value: '["LOC-1","LOC-2","LOC-3","LOC-4"]' })
      .where(eq(TssSetting.platform, 'STORE_LOCATION_CODE'));
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      payload: {
        ...payload,
        phone: '9876543297',
        name: 'Missing franchise',
        locationCode: 'LOC-4',
        franchiseId: '404',
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(
      await db
        .get('primary')
        .select({ id: Store.id })
        .from(Store)
        .where(eq(Store.location_code, 'LOC-4')),
    ).toEqual([]);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores',
      payload: { ...payload, franchise: { name: 'Ambiguous' } },
    });
    expect(invalid.statusCode).toBe(400);
  });
  it('limits shared franchise changes and associations to current complete store access', async () => {
    await seed(POSFranchise, {
      id: 20,
      name: 'Shared fixture franchise',
      description: 'Original',
      cin_number: 'FIXTURE-CIN',
    });
    await seed(POSFranchise, { id: 21, name: 'Orphan fixture franchise' });
    await db
      .get('writer')
      .update(Store)
      .set({ category: 'FRANCHISE', franchise_id: 20 })
      .where(eq(Store.id, 1n));
    await db
      .get('writer')
      .update(Store)
      .set({ category: 'FRANCHISE', franchise_id: 20 })
      .where(eq(Store.id, 2n));
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    const listed = await app.inject('/api/v1/admin/franchises?active=all');
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ data: { id: string }[] }>().data.map((row) => row.id)).toEqual(['20']);
    const payload = {
      name: 'Fixture Store 1',
      shortName: 'Fixture',
      locationCode: 'LOC-1',
      type: 'STORE',
      category: 'FRANCHISE',
      latitude: '19',
      longitude: '72',
      address: 'Fixture address',
      cityId: 0,
      countryId: 0,
      phone: '9876543298',
      franchise: { name: 'Changed shared details', description: 'Updated', cin: 'NEW-CIN' },
    };
    const refused = await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe('FRANCHISE_SCOPE_DENIED');
    const associate = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/stores/1',
      payload: { ...payload, franchise: undefined, franchiseId: '21' },
    });
    expect(associate.statusCode).toBe(403);
    await seed(UserStore, { django_user_id: 3, store_id: 2 });
    const permitted = await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload });
    expect(permitted.statusCode).toBe(200);
    const [details] = await db
      .get('primary')
      .select()
      .from(POSFranchise)
      .where(eq(POSFranchise.id, 20n));
    expect(details).toMatchObject({
      name: 'Changed shared details',
      description: 'Updated',
      cin_number: 'NEW-CIN',
    });
    await db.get('writer').update(PosUser).set({ role: 5 }).where(eq(PosUser.id, 3n));
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload })).statusCode,
    ).toBe(403);
  });
  it.each(['return', 'legacy-rto', 'legacy-delivery'] as const)(
    'queues one %s synchronization event, preserves attempts and traces delivery without PII',
    async (reason) => {
      const event = {
        id: 'financial-return-fixture',
        storeId: '1',
        productIds: ['1002', '1000', '1002'],
        operatorId: '4',
        reason,
        requestId: 'fixture-request-id',
      };
      await db.get('writer').transaction(async (transaction) => {
        await enqueueInventorySynchronization(transaction, event);
        await enqueueInventorySynchronization(transaction, event);
      });
      await expect(
        db
          .get('writer')
          .transaction((transaction) =>
            enqueueInventorySynchronization(transaction, { ...event, storeId: '2' }),
          ),
      ).rejects.toThrow('belongs to another operation');
      deliveryFailure = true;
      expect(await services.inventory.dispatchPending()).toBe(0);
      const [pending] = await connection.query<mysql.RowDataPacket[]>(
        "SELECT attempts,delivered_at,JSON_UNQUOTE(JSON_EXTRACT(payload,'$.reason')) AS reason FROM pos_rewrite_administration_outbox WHERE id=?",
        [event.id],
      );
      expect(pending.map((row) => [row.attempts, row.delivered_at, row.reason])).toEqual([
        [1, null, reason],
      ]);
      deliveryFailure = false;
      expect(await services.inventory.dispatchPending()).toBe(1);
      expect(deliveries).toEqual(
        [1, 2].map(() => ({
          id: event.id,
          products: ['1000', '1002'],
          context: { operatorId: '4', storeId: '1', requestId: event.requestId },
        })),
      );
    },
  );
  it('preserves the trusted service system actor without allowing normal enqueue impersonation', async () => {
    const event = {
      id: randomUUID(),
      storeId: '1',
      productIds: ['1000'],
      operatorId: '0',
      reason: 'legacy-delivery' as const,
      requestId: 'system-request-fixture',
    };
    await expect(
      db
        .get('writer')
        .transaction((transaction) => enqueueInventorySynchronization(transaction, event)),
    ).rejects.toThrow();
    const { operatorId: _operator, ...systemEvent } = event;
    await db
      .get('writer')
      .transaction((transaction) =>
        enqueueSystemInventorySynchronization(transaction, systemEvent),
      );
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      "SELECT JSON_UNQUOTE(JSON_EXTRACT(payload,'$.actorId')) AS actor,JSON_UNQUOTE(JSON_EXTRACT(payload,'$.reason')) AS reason FROM pos_rewrite_administration_outbox WHERE id=?",
      [event.id],
    );
    expect(rows).toMatchObject([{ actor: '0', reason: 'legacy-delivery' }]);
    expect(await services.inventory.dispatchPending()).toBe(1);
    expect(deliveries[0]!.context).toEqual({
      operatorId: '0',
      storeId: '1',
      requestId: event.requestId,
    });
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
    expect(await services.checkins.checkedInStore('4')).toBeNull();
    expect(await services.checkins.checkedInUsers('1')).toEqual([]);
    await app.inject({ method: 'DELETE', url: '/api/v1/operators/me/check-in' });
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
  it('prevents overlapping worker batches and emits resource/request/operator trace identifiers', async () => {
    await db.get('writer').transaction((transaction) =>
      enqueueInventorySynchronization(transaction, {
        id: 'worker-fixture',
        storeId: '1',
        productIds: ['1001'],
        operatorId: '4',
        reason: 'return',
        requestId: 'fixture-request-id',
      }),
    );
    const options = readAdministrationWorkerOptions({
      ADMINISTRATION_WORKER_ENABLED: 'true',
      PRODUCT_SYNC_BASE_URL: 'https://sync.example.test/',
      PRODUCT_SYNC_URI: 'sync/products',
      PRODUCT_SYNC_REPLAY_SAFE: 'true',
    });
    const events: AdministrationWorkerEvent[] = [];
    let calls = 0,
      release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: typeof fetch = async () => {
      calls++;
      await gate;
      return new Response(null, { status: 200 });
    };
    const worker = administrationWorker(
      applicationConfig,
      db,
      options,
      (_level, event) => events.push(event),
      fetcher,
    );
    const pending = worker.runOnce();
    await expect.poll(() => calls).toBe(1);
    expect(worker.runOnce()).toBe(pending);
    release();
    await pending;
    await worker.stop();
    expect(calls).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        module: 'administration',
        resource: 'inventory-synchronization',
        eventId: 'administration.inventory-synchronization.acknowledged',
        eventInstanceId: expect.any(String),
        requestId: 'fixture-request-id',
        userId: '4',
        effectId: 'worker-fixture',
        storeId: '1',
      }),
    );
  });
  it('alerts on exhausted synchronization and supports explicit replay-safe recovery', async () => {
    const id = 'exhausted-fixture';
    await db.get('writer').transaction((transaction) =>
      enqueueInventorySynchronization(transaction, {
        id,
        storeId: '1',
        productIds: ['1001'],
        operatorId: '4',
        reason: 'return',
        requestId: 'fixture-request-id',
      }),
    );
    await connection.query('UPDATE pos_rewrite_administration_outbox SET attempts=10 WHERE id=?', [
      id,
    ]);
    const options = readAdministrationWorkerOptions({
      ADMINISTRATION_WORKER_ENABLED: 'true',
      PRODUCT_SYNC_BASE_URL: 'https://sync.example.test/',
      PRODUCT_SYNC_URI: 'sync/products',
      PRODUCT_SYNC_REPLAY_SAFE: 'true',
    });
    const events: AdministrationWorkerEvent[] = [];
    let calls = 0;
    const worker = administrationWorker(
      applicationConfig,
      db,
      options,
      (_level, event) => events.push(event),
      async () => {
        calls++;
        return new Response(null, { status: 200 });
      },
    );
    await worker.runOnce();
    expect(calls).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventId: 'administration.inventory-synchronization.retry-exhausted',
        userId: '4',
        requestId: 'fixture-request-id',
        effectId: id,
        errorCode: 'PRODUCT_SYNC_RETRY_EXHAUSTED',
      }),
    );
    await retryInventorySynchronization(db, id);
    await worker.runOnce();
    expect(calls).toBe(1);
    await expect(retryInventorySynchronization(db, id)).rejects.toThrow('already complete');
    await worker.stop();
  });
  it('aborts in-flight delivery on shutdown without logging upstream errors or losing retry state', async () => {
    const id = 'shutdown-fixture';
    await db.get('writer').transaction((transaction) =>
      enqueueInventorySynchronization(transaction, {
        id,
        storeId: '1',
        productIds: ['1001'],
        operatorId: '4',
        reason: 'return',
        requestId: 'fixture-request-id',
      }),
    );
    const options = readAdministrationWorkerOptions({
      ADMINISTRATION_WORKER_ENABLED: 'true',
      PRODUCT_SYNC_BASE_URL: 'https://sync.example.test/',
      PRODUCT_SYNC_URI: 'sync/products',
      PRODUCT_SYNC_REPLAY_SAFE: 'true',
    });
    const events: AdministrationWorkerEvent[] = [];
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls++;
        if (init?.signal?.aborted) reject(new Error('private-canary@example.test'));
        else
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private-canary@example.test')),
            { once: true },
          );
      });
    const worker = administrationWorker(
      applicationConfig,
      db,
      options,
      (_level, event) => events.push(event),
      fetcher,
    );
    const pending = worker.runOnce();
    await expect.poll(() => calls).toBe(1);
    await worker.stop();
    await pending;
    await worker.runOnce();
    expect(calls).toBe(1);
    expect(JSON.stringify(events)).not.toContain('private-canary');
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT attempts,delivered_at FROM pos_rewrite_administration_outbox WHERE id=?',
      [id],
    );
    expect(rows.map((row) => [row.attempts, row.delivered_at])).toEqual([[1, null]]);
  });
  it('previews CSV rows in batches without mutation and keeps stock-procedure submission gated', async () => {
    await seed(Product, { id: 1000, product: 'Fixture product', prod_type: 1, parent_prod_id: 0 });
    await seed(ProductStore, {
      product_id: 1000,
      store_id: 1,
      stock: 4,
      is_avail: true,
      is_del: false,
    });
    const input = {
      id: randomUUID(),
      name: 'Fixture.csv',
      csv: stockCsv([
        stockImportHeaders,
        ['1000', '1', '1', '2', '', ''],
        ['1000', '1', '1', '8', '', ''],
        ['invalid', '1', '', '', '', ''],
      ]),
    };
    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/inventory-imports/preview',
      payload: input,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      totalRows: 3,
      validRows: 1,
      invalidRows: 2,
      requiresStockProcedure: true,
      canSubmit: false,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/inventory-imports', payload: input }))
        .statusCode,
    ).toBe(503);
    const [jobs] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM pos_rewrite_inventory_imports',
    );
    expect(String(jobs[0]?.count)).toBe('0');
    const [stocks] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock FROM product_store WHERE product_id=1000 AND store_id=1',
    );
    expect(stocks[0]?.stock).toBe(4);
  });
  it('queues and replays visibility-only imports with atomic child/parent changes and durable synchronization', async () => {
    await seed(Product, { id: 1000, product: 'Fixture parent', prod_type: 3, parent_prod_id: 0 });
    await seed(Product, { id: 1001, product: 'Fixture child', prod_type: 1, parent_prod_id: 1000 });
    for (const product_id of [1000, 1001])
      await seed(ProductStore, {
        product_id,
        store_id: 1,
        stock: product_id === 1000 ? 0 : 5,
        is_avail: true,
        is_del: false,
      });
    const input = {
      id: randomUUID(),
      name: 'Visibility.csv',
      csv: stockCsv([stockImportHeaders, ['1001', '1', '', '', '0', '1']]),
    };
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/inventory-imports',
            payload: input,
          })
        ).statusCode,
      ).toBe(201);
    expect((await services.imports.dispatchNext())?.status).toBe('row-succeeded');
    expect(await services.imports.dispatchNext()).toBeNull();
    const [values] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT product_id,stock,is_avail,is_del FROM product_store WHERE store_id=1 ORDER BY product_id',
    );
    expect(
      values.map((row) => [String(row.product_id), row.stock, row.is_avail, row.is_del]),
    ).toEqual([
      ['1000', 0, 0, 1],
      ['1001', 5, 0, 1],
    ]);
    const detail = await app.inject(`/api/v1/admin/inventory-imports/${input.id}`);
    expect(detail.json()).toMatchObject({
      state: 'COMPLETED',
      processedRows: 1,
      successfulRows: 1,
      failedRows: 0,
    });
    const [effects] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM pos_rewrite_administration_outbox',
    );
    expect(String(effects[0]?.count)).toBe('1');
    await services.inventory.dispatchPending();
    expect(deliveries[0]?.products).toEqual(['1000', '1001']);
    actor = { ...actor, id: '2', role: 2, storeIds: ['1'] };
    expect((await app.inject(`/api/v1/admin/inventory-imports/${input.id}`)).statusCode).toBe(404);
  });
  it('moves held stock with conservation, source audit comments and global-live sibling restoration', async () => {
    for (const [id, parent, deleted, type] of [
      [1000, 0, 0, 3],
      [1001, 1000, 0, 1],
      [1002, 1000, 0, 1],
      [1003, 1000, 1, 1],
      [1004, 1000, 1, 1],
    ])
      await seed(Product, {
        id: id!,
        product: `Fixture product ${id}`,
        parent_prod_id: parent!,
        prod_type: type!,
        is_del: deleted!,
      });
    await seed(ProductStore, {
      product_id: 1000,
      store_id: 1,
      stock: 0,
      is_avail: false,
      is_del: true,
    });
    await seed(ProductStore, {
      product_id: 1001,
      store_id: 1,
      stock: 10,
      is_avail: true,
      is_del: false,
    });
    await seed(ProductStore, {
      product_id: 1002,
      store_id: 1,
      stock: 5,
      is_avail: false,
      is_del: true,
    });
    await seed(ProductStore, {
      product_id: 1003,
      store_id: 2,
      stock: 2,
      is_avail: true,
      is_del: false,
    });
    const calls: StockProcedureInput[] = [];
    const imports = inventoryImportService(applicationConfig, db, {
      procedureVerified: true,
      syncProducts: async () => {},
      stockProcedure: async (_transaction, input) => {
        calls.push(input);
      },
    });
    const input = {
      id: randomUUID(),
      name: 'Hold-and-release.csv',
      csv: stockCsv([
        stockImportHeaders,
        ['1001', '1', '1', '3', '', ''],
        ['1001', '1', '0', '2', '', ''],
      ]),
    };
    await imports.create(actor, input);
    await Promise.all([imports.dispatchNext(), imports.dispatchNext()]);
    await imports.dispatchNext();
    expect(calls.map((call) => [call.stock, call.comment])).toEqual([
      [7, 'Product inventory added into hold stock.'],
      [9, 'Product inventory added from admin panel from Hold Stock'],
    ]);
    const [stock] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock FROM product_store WHERE product_id=1001 AND store_id=1',
    );
    const [held] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock FROM hold_stock_store WHERE product_id=1001 AND store_id=1',
    );
    expect([stock[0]?.stock, held[0]?.stock]).toEqual([9, 1]);
    expect(Number(stock[0]?.stock) + Number(held[0]?.stock)).toBe(10);
    const [family] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT product_id,stock,is_avail,is_del FROM product_store WHERE store_id=1 ORDER BY product_id',
    );
    expect(
      family.map((row) => [String(row.product_id), row.stock, row.is_avail, row.is_del]),
    ).toEqual([
      ['1000', 0, 1, 0],
      ['1001', 9, 1, 0],
      ['1002', 5, 1, 0],
      ['1003', 0, 1, 0],
    ]);
    const [logs] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock_before,stock_after,comment FROM pos_hold_stock_logs ORDER BY id',
    );
    expect(logs.map((row) => [row.stock_before, row.stock_after, row.comment])).toEqual([
      ['0', '3', 'Hold Stock inventory added into Hold Stock from admin panel .'],
      ['3', '1', 'Hold Stock inventory reduced to add into Product inventory.'],
    ]);
    expect(await imports.dispatchNext()).toBeNull();
  });
  it('rolls back an entire row on stock procedure failure and resumes without duplicated stock', async () => {
    await seed(Product, { id: 1000, product: 'Fixture product', prod_type: 1, parent_prod_id: 0 });
    await seed(ProductStore, {
      product_id: 1000,
      store_id: 1,
      stock: 5,
      is_avail: true,
      is_del: false,
    });
    let unavailable = true;
    const imports = inventoryImportService(applicationConfig, db, {
      procedureVerified: true,
      syncProducts: async () => {},
      stockProcedure: async () => {
        if (unavailable) throw new Error('private-canary@example.test');
      },
    });
    const input = {
      id: randomUUID(),
      name: 'Rollback.csv',
      csv: stockCsv([stockImportHeaders, ['1000', '1', '1', '2', '0', '1']]),
    };
    await imports.create(actor, input);
    expect(await imports.dispatchNext()).toMatchObject({
      status: 'blocked',
      errorCode: 'INVENTORY_IMPORT_STORAGE_UNAVAILABLE',
    });
    const [stock] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock,is_avail,is_del FROM product_store WHERE product_id=1000 AND store_id=1',
    );
    expect(stock.map((row) => [row.stock, row.is_avail, row.is_del])).toEqual([[5, 1, 0]]);
    const [held] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM hold_stock_store',
    );
    expect(String(held[0]?.count)).toBe('0');
    expect(JSON.stringify(await imports.detail(actor, input.id))).not.toContain('private-canary');
    unavailable = false;
    await imports.control(actor, input.id, 'resume');
    expect((await imports.dispatchNext())?.status).toBe('row-succeeded');
    const [after] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock FROM product_store WHERE product_id=1000 AND store_id=1',
    );
    expect(after[0]?.stock).toBe(3);
  });
  it('records failed rows safely, cancels remaining rows, and rechecks writer-current assignments', async () => {
    await seed(Product, { id: 1000, product: 'Fixture product', prod_type: 1, parent_prod_id: 0 });
    await seed(ProductStore, {
      product_id: 1000,
      store_id: 1,
      stock: 5,
      is_avail: true,
      is_del: false,
    });
    actor = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    const input = {
      id: randomUUID(),
      name: 'Scope.csv',
      csv: stockCsv([
        stockImportHeaders,
        ['=HYPERLINK("fixture")', '1', '', '', '', ''],
        ['1000', '1', '', '', '0', '1'],
        ['1000', '1', '', '', '1', '0'],
      ]),
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/admin/inventory-imports', payload: input }))
        .statusCode,
    ).toBe(201);
    await connection.query('DELETE FROM user_stores WHERE django_user_id=3 AND store_id=1');
    expect(await services.imports.dispatchNext()).toMatchObject({
      status: 'row-failed',
      errorCode: 'STORE_ACCESS_DENIED',
    });
    const failed = await app.inject(`/api/v1/admin/inventory-imports/${input.id}/failures.csv`);
    expect(failed.statusCode).toBe(200);
    expect(failed.body).toContain("'=HYPERLINK");
    expect(failed.body).toContain('Not a valid store for requested user.');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/inventory-imports/${input.id}/cancel`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const rows = (await app.inject(`/api/v1/admin/inventory-imports/${input.id}/rows`)).json<{
      data: { state: string }[];
    }>().data;
    expect(rows.map((row) => row.state)).toEqual(['FAILED', 'FAILED', 'CANCELLED']);
    const [stock] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT stock,is_avail,is_del FROM product_store WHERE product_id=1000 AND store_id=1',
    );
    expect(stock.map((row) => [row.stock, row.is_avail, row.is_del])).toEqual([[5, 1, 0]]);
  });
  it('routes completed CSV record data older than one day only to BigQuery after current writer authorization', async () => {
    await seed(Product, { id: 1000, product: 'Fixture product', prod_type: 1, parent_prod_id: 0 });
    await seed(ProductStore, {
      product_id: 1000,
      store_id: 1,
      stock: 5,
      is_avail: true,
      is_del: false,
    });
    const input = {
      id: randomUUID(),
      name: 'Archived.csv',
      csv: stockCsv([stockImportHeaders, ['1000', '1', '', '', '1', '0']]),
    };
    await services.imports.create(actor, input);
    await services.imports.dispatchNext();
    await connection.query(
      "UPDATE pos_rewrite_inventory_imports SET created_at='2000-01-01 00:00:00.000',updated_at='2000-01-01 00:00:01.000' WHERE id=?",
      [input.id],
    );
    const [records] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT sequence,checksum FROM pos_rewrite_inventory_imports WHERE id=?',
      [input.id],
    );
    await connection.query('DELETE FROM pos_rewrite_inventory_import_rows WHERE import_id=?', [
      input.id,
    ]);
    const config = { ...applicationConfig, BIGQUERY_PROJECT_ID: 'fixture-project' };
    let queries = 0;
    const history = inventoryImportHistory(
      config,
      readImportHistoryOptions({
        BQ_INVENTORY_IMPORTS_VIEW: 'fixture-project.pos_rewrite.inventory_imports',
        BQ_INVENTORY_IMPORT_ROWS_VIEW: 'fixture-project.pos_rewrite.inventory_import_rows',
      }),
      {
        async queryReport(query) {
          queries++;
          return query.includes('record_stats')
            ? [
                {
                  id: input.id,
                  sequence: String(records[0]?.sequence),
                  actorId: '1',
                  checksum: records[0]?.checksum,
                  name: 'Archived.csv',
                  state: 'COMPLETED',
                  totalRows: '1',
                  processedRows: '1',
                  successfulRows: '1',
                  failedRows: '0',
                  errorCode: null,
                  createdAt: '2000-01-01T00:00:00.000Z',
                  updatedAt: '2000-01-01T00:00:01.000Z',
                  recordCount: '1',
                  distinctRecords: '1',
                  minimumRecord: '2',
                  maximumRecord: '2',
                  succeededCount: '1',
                  failedCount: '0',
                  cancelledCount: '0',
                  unexpectedCount: '0',
                },
              ]
            : [
                {
                  importId: input.id,
                  actorId: '1',
                  checksum: records[0]?.checksum,
                  updatedAt: '2000-01-01T00:00:01.000Z',
                  rowNumber: '2',
                  cells: JSON.stringify(['1000', '1', '', '', '1', '0']),
                  command: JSON.stringify({
                    productId: '1000',
                    storeId: '1',
                    movement: 'none',
                    quantity: 0,
                    available: true,
                    archived: false,
                  }),
                  state: 'SUCCEEDED',
                  errorCode: null,
                  message: 'Historical fixture row.',
                },
              ];
        },
      },
    );
    const imports = inventoryImportService(config, db, { importHistory: history });
    const rows = await imports.rows(actor, input.id, { after: 0, limit: 50, state: 'all' });
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]?.message).toBe('Historical fixture row.');
    expect(queries).toBe(2);
    actor = { ...actor, id: '2', role: 1, storeIds: ['1'] };
    await expect(
      imports.rows(actor, input.id, { after: 0, limit: 50, state: 'all' }),
    ).rejects.toMatchObject({ code: 'INVENTORY_IMPORT_NOT_FOUND' });
    expect(queries).toBe(2);
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
    const [effects] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT kind,payload FROM pos_rewrite_settings_effects ORDER BY sequence',
    );
    expect(effects).toHaveLength(2);
    expect(effects.map((row) => row.kind)).toEqual(['slot.timing.notice', 'slot.timing.notice']);
    expect(JSON.stringify(effects)).not.toContain('fixture@example.test');
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
      execFileSync('python3', ['tools/administration/legacy_oracle.py'], {
        input: JSON.stringify({ operation: 'order-buffer', cases: [{ value: duration }] }),
        encoding: 'utf8',
      }),
    ) as number[];
    const [values] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT platform,value FROM tss_settings WHERE id>=100 ORDER BY id',
    );
    expect(values.map((row) => row.value)).toEqual(['0', '0', String(source[0])]);
    const [effects] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT kind FROM pos_rewrite_settings_effects ORDER BY sequence',
    );
    expect(effects.map((row) => row.kind)).toEqual([
      'setting.cache',
      'setting.cache',
      'buffer.notice',
    ]);
    settingsAvailable = false;
    expect(
      (await app.inject({ method: 'PUT', url, payload: { ...body, operationId: randomUUID() } }))
        .statusCode,
    ).toBe(503);
  });
  it('orders cache effects across retries while allowing unrelated resources to progress', async () => {
    await seed(TssSetting, { id: 100, platform: 'HYPERLOCAL_STOCK_THRESHOLD', value: '2' });
    await seed(TssSetting, { id: 101, platform: 'ORDER_CREATION_BUFFER_TIME_IN_SEC', value: '60' });
    for (const value of [3, 4]) {
      const setting = (await app.inject('/api/v1/admin/general-settings'))
        .json<{ data: { name: string; version: string }[] }>()
        .data.find((row) => row.name === 'HYPERLOCAL_STOCK_THRESHOLD')!;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/admin/general-settings/delivery-stock-threshold',
            payload: { operationId: randomUUID(), expectedVersion: setting.version, value },
          })
        ).statusCode,
      ).toBe(200);
    }
    const buffer = (await app.inject('/api/v1/admin/general-settings'))
      .json<{ data: { name: string; version: string }[] }>()
      .data.find((row) => row.name === 'ORDER_CREATION_BUFFER_TIME_IN_SEC')!;
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/general-settings/order-creation-buffer',
      payload: { operationId: randomUUID(), expectedVersion: buffer.version, value: '01:30' },
    });
    let fail = true;
    const delivery: SettingsEffectDelivery = {
      supports: () => true,
      async deliver(id, effect) {
        settingsDeliveries.push({ id, effect });
        if (fail && effect.kind === 'setting.cache' && effect.key === 'HYPERLOCAL_STOCK_THRESHOLD')
          throw new Error('private-canary@example.test');
      },
    };
    const outbox = settingsOutbox(db, delivery),
      first = await outbox.dispatchNext();
    expect(first?.status).toBe('failed');
    expect((await outbox.dispatchNext(undefined, [first!.id]))?.status).toBe('delivered');
    expect((await outbox.dispatchNext(undefined, [first!.id]))?.status).toBe('delivered');
    expect(await outbox.dispatchNext(undefined, [first!.id])).toBeNull();
    fail = false;
    await Promise.all([outbox.dispatchNext(), outbox.dispatchNext()]);
    await outbox.dispatchNext();
    const acknowledged = settingsDeliveries
      .filter(
        ({ effect }) =>
          effect.kind === 'setting.cache' && effect.key === 'HYPERLOCAL_STOCK_THRESHOLD',
      )
      .map(({ effect }) => (effect.kind === 'setting.cache' ? effect.value : 0));
    expect(acknowledged).toEqual([3, 3, 4]);
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT attempts,delivered_at FROM pos_rewrite_settings_effects ORDER BY sequence',
    );
    expect(rows.every((row) => row.delivered_at !== null)).toBe(true);
    expect(rows[0]?.attempts).toBe(2);
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
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/stores/1/delivery-slots/${slot.id}/availability`,
      payload: { operationId: randomUUID(), expectedVersion: slot.version, active: false },
    });
    let status = 503;
    const requests: { redirect: RequestRedirect | undefined; body: unknown }[] = [];
    const delivery = createSettingsDelivery(
      applicationConfig,
      db,
      readSettingsWorkerOptions({ SLACK_URL: 'https://hooks.slack.com/services/fixture/private' }),
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
    const outbox = settingsOutbox(db, delivery);
    const failure = await outbox.dispatchNext();
    expect(failure).toMatchObject({ status: 'failed', errorCode: 'SETTINGS_NOTICE_UNAVAILABLE' });
    expect(JSON.stringify(failure)).not.toContain('private-canary');
    status = 200;
    expect((await outbox.dispatchNext())?.status).toBe('delivered');
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
  it('aborts a single in-flight settings batch on shutdown without logging payloads', async () => {
    await seed(TssSetting, { id: 100, platform: 'HYPERLOCAL_STOCK_THRESHOLD', value: '2' });
    const setting = (await app.inject('/api/v1/admin/general-settings'))
      .json<{ data: { name: string; version: string }[] }>()
      .data.find((row) => row.name === 'HYPERLOCAL_STOCK_THRESHOLD')!;
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/general-settings/delivery-stock-threshold',
      payload: { operationId: randomUUID(), expectedVersion: setting.version, value: 3 },
    });
    let started!: () => void,
      calls = 0;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const delivery: SettingsEffectDelivery = {
      supports: () => true,
      async deliver(_id, _effect, signal) {
        calls++;
        started();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) reject(new Error('private-canary@example.test'));
          else
            signal?.addEventListener(
              'abort',
              () => reject(new Error('private-canary@example.test')),
              { once: true },
            );
        });
      },
    };
    const events: SettingsWorkerEvent[] = [];
    const worker = settingsWorker(
      db,
      delivery,
      readSettingsWorkerOptions({ SETTINGS_WORKER_ENABLED: 'true' }),
      (_level, event) => events.push(event),
    );
    const pending = worker.runOnce();
    await ready;
    expect(worker.runOnce()).toBe(pending);
    await worker.stop();
    await pending;
    await worker.runOnce();
    expect(calls).toBe(1);
    expect(JSON.stringify(events)).not.toContain('private-canary');
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT attempts,delivered_at FROM pos_rewrite_settings_effects',
    );
    expect(rows.map((row) => [row.attempts, row.delivered_at])).toEqual([[1, null]]);
  });
  it('persists ecommerce cooldown, queues source effects and keeps unverified synchronization closed', async () => {
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
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT kind FROM pos_rewrite_settings_effects ORDER BY sequence',
    );
    expect(rows.map((row) => row.kind)).toEqual([
      'ecommerce.threshold.notice',
      'ecommerce.availability.notice',
      'ecommerce.inventory.sync',
    ]);
    actor = { ...actor, id: '2', role: 2, storeIds: ['1'] };
    expect((await app.inject(url)).statusCode).toBe(403);
  });
  it('surfaces exhausted settings deliveries after restart and requeues only pending effects', async () => {
    await seed(TssSetting, { id: 100, platform: 'HYPERLOCAL_STOCK_THRESHOLD', value: '2' });
    const setting = (await app.inject('/api/v1/admin/general-settings'))
      .json<{ data: { name: string; version: string }[] }>()
      .data.find((row) => row.name === 'HYPERLOCAL_STOCK_THRESHOLD')!;
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/general-settings/delivery-stock-threshold',
      payload: { operationId: randomUUID(), expectedVersion: setting.version, value: 3 },
    });
    await connection.query('UPDATE pos_rewrite_settings_effects SET attempts=9');
    settingsFailures.add('setting.cache');
    const events: SettingsWorkerEvent[] = [],
      options = readSettingsWorkerOptions({ SETTINGS_WORKER_ENABLED: 'true' });
    const worker = settingsWorker(db, settingsDelivery, options, (_level, event) =>
      events.push(event),
    );
    await worker.runOnce();
    await worker.stop();
    expect(
      events.some((event) => event.eventId === 'administration.settings-delivery.blocked'),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain('private-canary');
    const restarted = settingsWorker(db, settingsDelivery, options, (_level, event) =>
      events.push(event),
    );
    await restarted.runOnce();
    expect(
      events.filter((event) => event.eventId === 'administration.settings-delivery.blocked'),
    ).toHaveLength(2);
    const id = settingsDeliveries[0]!.id;
    await settingsOutbox(db, settingsDelivery).retry(id);
    settingsFailures.clear();
    await restarted.runOnce();
    await restarted.stop();
    await expect(settingsOutbox(db, settingsDelivery).retry(id)).rejects.toMatchObject({
      code: 'SETTINGS_EFFECT_NOT_PENDING',
    });
  });
  it('creates and updates guides with sanitized rich text, stable ordering and optimistic replay protection', async () => {
    const body = {
      operationId: randomUUID(),
      expectedVersion: 0,
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
    const document = created.json<{ id: string; version: number }>();
    expect(document.version).toBe(1);
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
          payload: { ...body, operationId: randomUUID(), expectedVersion: 1, title },
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
          payload: { ...body, operationId: randomUUID(), expectedVersion: 2 },
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
      expectedVersion: 0,
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
      assets: { id: string; url: string }[];
    }>();
    expect(detail.assets[0]?.id).toBe(id);
    expect(detail.assets[0]?.url).toBe(`/api/v1/documentation/${documentId}/assets/${id}/content`);
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
  it('cleans expired orphan uploads after lease grace and retains files shared by legacy guides', async () => {
    const id = randomUUID(),
      checksum = createHash('sha256').update('fixture').digest('base64');
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation/uploads',
      payload: {
        id,
        kind: 'image',
        name: 'Fixture.png',
        contentType: 'image/png',
        size: 7,
        checksum,
      },
    });
    const cleanup = documentationMediaCleanup(db, media);
    expect(await cleanup.dispatchNext()).toBeNull();
    await connection.query(
      "UPDATE pos_rewrite_documentation_assets SET expires_at='2000-01-01 00:00:00' WHERE id=?",
      [id],
    );
    const removed = await cleanup.dispatchNext();
    expect(removed?.status).toBe('deleted');
    expect(mediaDeletes).toHaveLength(1);
    const key = "fixtures/tutorials/legacy/O'Brien.pdf";
    await seed(PosTutorial, {
      id: 100,
      title: 'Shared guide',
      cover_image: '[]',
      image_link: '[]',
      video_link: '[]',
      doc_link: JSON.stringify([key]),
      is_active: 1,
    });
    await seed(PosTutorial, {
      id: 101,
      title: 'Other guide',
      cover_image: '[]',
      image_link: '[]',
      video_link: '[]',
      doc_link: JSON.stringify([key]),
      is_active: 1,
    });
    const detail = (await app.inject('/api/v1/documentation/100')).json<{
      assets: { id: string }[];
    }>();
    expect(detail.assets).toHaveLength(1);
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/documentation/100',
      payload: {
        operationId: randomUUID(),
        expectedVersion: 0,
        title: 'Shared guide',
        summary: 'Fixture',
        description: '',
        sortOrder: 0,
        retainAssetIds: [],
        uploadIds: [],
      },
    });
    expect(changed.statusCode).toBe(200);
    await connection.query(
      "UPDATE pos_rewrite_documentation_assets SET expires_at='2000-01-01 00:00:00' WHERE object_key=?",
      [key],
    );
    expect((await cleanup.dispatchNext())?.status).toBe('retained');
    expect(mediaDeletes).not.toContain(key);
  });
  it('persists failed media cleanup, alerts across worker restarts and supports bounded recovery', async () => {
    const id = randomUUID(),
      checksum = createHash('sha256').update('fixture').digest('base64');
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation/uploads',
      payload: {
        id,
        kind: 'image',
        name: 'Private-canary.png',
        contentType: 'image/png',
        size: 7,
        checksum,
      },
    });
    await connection.query(
      "UPDATE pos_rewrite_documentation_assets SET state='DELETE_PENDING',attempts=9,expires_at='2000-01-01 00:00:00' WHERE id=?",
      [id],
    );
    mediaDeletionFailure = true;
    const events: MediaWorkerEvent[] = [],
      options = readDocumentationMediaOptions({ DOCUMENTATION_MEDIA_WORKER_ENABLED: 'true' });
    const worker = documentationMediaWorker(db, media, options, (_level, event) =>
      events.push(event),
    );
    await worker.runOnce();
    await worker.stop();
    expect(events).toContainEqual(
      expect.objectContaining({
        eventId: 'administration.documentation-media.cleanup-blocked',
        userId: '1',
        effectId: id,
      }),
    );
    expect(JSON.stringify(events)).not.toContain('Private-canary');
    expect(JSON.stringify(events)).not.toContain('private-canary@example.test');
    expect(JSON.stringify(events)).not.toContain('fixtures/tutorials');
    const restarted = documentationMediaWorker(db, media, options, (_level, event) =>
      events.push(event),
    );
    await restarted.runOnce();
    expect(
      events.filter(
        (event) => event.eventId === 'administration.documentation-media.cleanup-blocked',
      ),
    ).toHaveLength(2);
    await documentationMediaCleanup(db, media).retry(id);
    mediaDeletionFailure = false;
    await restarted.runOnce();
    await restarted.stop();
    expect(mediaDeletes).toHaveLength(1);
  });
  it('rechecks the current writer role before privileged guide mutations', async () => {
    actor = { ...actor, id: '3', role: 1, storeIds: ['1'] };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/documentation',
      payload: {
        operationId: randomUUID(),
        expectedVersion: 0,
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
      execFileSync('python3', ['tools/administration/legacy_oracle.py'], {
        input: JSON.stringify({
          operation: 'catalog',
          cases: [{ product: variant, products: [parent, variant], barcodes, prices }],
        }),
        encoding: 'utf8',
      }),
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
  async function reconciledAccessFixture() {
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
    const accounts = await db
      .get('writer')
      .select({ id: PosUser.id, isStaff: PosUser.is_staff, isSuperuser: PosUser.is_superuser })
      .from(PosUser);
    const permissions = [
      'auth.add_group',
      'auth.view_group',
      'auth.change_group',
      'auth.delete_group',
      'users.view_posuser',
      'users.change_posuser',
      'stores.view_store',
      'stores.change_store',
    ].map((key) => {
      const [appLabel, codename] = key.split('.');
      return {
        key,
        appLabel: appLabel!,
        codename: codename!,
        model: codename!.split('_').at(-1)!,
        name: `Fixture ${key}`,
      };
    });
    const snapshot = {
      version: 1,
      sourceVerified: true,
      sourceFingerprint: 'a'.repeat(64),
      exportedAt: '2026-11-16T00:00:00Z',
      permissions,
      groups: [
        {
          legacyId: '10',
          name: 'Fixture administration readers',
          permissionKeys: ['auth.view_group', 'stores.view_store'],
        },
      ],
      operators: accounts.map((account) => ({
        id: String(account.id),
        isStaff: account.isStaff,
        isSuperuser: account.isSuperuser,
        legacyGroupIds: account.id === 2n ? ['10'] : [],
        permissionKeys: account.id === 2n ? ['users.view_posuser'] : [],
      })),
    };
    await reconcileAdministrationAccess(db, snapshot, { operatorId: '1' });
    return snapshot;
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
    await reconciledAccessFixture();
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
    const sessionStore = mysqlSessions(db),
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
    expect(await sessionStore.valid('4', credential)).toBe(false);
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
    const epoch = (
      await db
        .get('writer')
        .select()
        .from(operatorAuthEpochs)
        .where(eq(operatorAuthEpochs.userId, '4'))
    )[0];
    expect(epoch?.epoch).toBe(1n);
  });
  it('rechecks model permissions and self/superuser restrictions for administrative profiles', async () => {
    await reconciledAccessFixture();
    const update = await administrativeProfileInput(),
      scoped = { ...actor, id: '2' };
    expect((await services.operatorAdministration.profile(scoped, '4')).canEdit).toBe(false);
    await expect(
      services.operatorAdministration.updateProfile(scoped, '4', update),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .get('writer')
      .insert(administrationDirectPermissions)
      .values({ operatorId: '2', permissionKey: 'users.change_posuser' });
    expect((await services.operatorAdministration.profile(scoped, '4')).canEdit).toBe(true);
    await expect(
      services.operatorAdministration.updateProfile(
        actor,
        '1',
        await administrativeProfileInput('1'),
      ),
    ).rejects.toMatchObject({ code: 'SELF_ADMIN_PROFILE_CHANGE_DENIED' });
    await expect(
      services.operatorAdministration.updateProfile(
        scoped,
        '1',
        await administrativeProfileInput('1'),
      ),
    ).rejects.toMatchObject({ code: 'OPERATOR_ADMIN_TARGET_DENIED' });
    await db.get('writer').update(PosUser).set({ is_staff: false }).where(eq(PosUser.id, 2n));
    await expect(
      services.operatorAdministration.updateProfile(scoped, '4', update),
    ).rejects.toMatchObject({ status: 403 });
    expect((await services.operatorAdministration.profile(actor, '4')).username).toBe('fixture4');
  });
  it('permanently revokes authentication on administrative credential changes even after restoring source fields', async () => {
    await reconciledAccessFixture();
    const sessions = mysqlSessions(db),
      credential = await sessions.create('4');
    const original = await administrativeProfileInput();
    const changed = { ...original, username: 'different.login' };
    expect(await services.operatorAdministration.updateProfile(actor, '4', changed)).toMatchObject({
      credentialsChanged: true,
    });
    expect(await services.operatorAdministration.updateProfile(actor, '4', changed)).toMatchObject({
      credentialsChanged: true,
    });
    expect(await sessions.valid('4', credential)).toBe(false);
    await services.operatorAdministration.updateProfile(actor, '4', {
      ...original,
      operationId: randomUUID(),
      expectedVersion: (await services.operatorAdministration.profile(actor, '4')).revision,
    });
    expect(await sessions.valid('4', credential)).toBe(false);
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(operatorAuthEpochs)
          .where(eq(operatorAuthEpochs.userId, '4'))
      )[0]?.epoch,
    ).toBe(2n);
    expect(await sessions.valid('4', await sessions.create('4'))).toBe(true);
  });
  it('uses source password policy, current superuser authority and idempotent write-only password resets', async () => {
    await reconciledAccessFixture();
    const sessions = mysqlSessions(db),
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
    expect(account?.password).toMatch(/^pbkdf2_sha256\$1000000\$/);
    expect(await verifyDjangoPassword(input.newPassword, account!.password)).toBe(true);
    expect(await sessions.valid('4', credential)).toBe(false);
    await services.operatorAdministration.resetPassword(actor, '4', input);
    expect(
      (await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n)))[0]?.password,
    ).toBe(account?.password);
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(operatorAuthEpochs)
          .where(eq(operatorAuthEpochs.userId, '4'))
      )[0]?.epoch,
    ).toBe(1n);
    await db
      .get('writer')
      .insert(administrationDirectPermissions)
      .values({ operatorId: '2', permissionKey: 'users.change_posuser' });
    await expect(
      services.operatorAdministration.resetPassword({ ...actor, id: '2' }, '4', input),
    ).rejects.toMatchObject({ code: 'OPERATOR_PASSWORD_RESET_DENIED' });
    await expect(
      services.operatorAdministration.resetPassword(actor, '1', {
        ...input,
        expectedVersion: (await services.operatorAdministration.profile(actor, '1')).revision,
      }),
    ).rejects.toMatchObject({ code: 'SELF_ADMIN_PROFILE_CHANGE_DENIED' });
  }, 5000);
  it('reuses private profile lifecycle for actor-bound managed images and cross-owner cleanup references', async () => {
    await reconciledAccessFixture();
    await db
      .get('writer')
      .insert(administrationDirectPermissions)
      .values({ operatorId: '2', permissionKey: 'users.change_posuser' });
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
      profileMediaService(applicationConfig, db, operatorImageStore).attach(
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
    await service.images.attach(scoped, '4', input.upload.id, input.revision);
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
    await db
      .get('writer')
      .delete(administrationDirectPermissions)
      .where(eq(administrationDirectPermissions.operatorId, '2'));
    const verificationCount = storeImageVerifications.length;
    await expect(
      service.images.attach(scoped, '4', replacement.upload.id, replacement.revision),
    ).rejects.toMatchObject({ status: 403 });
    expect(storeImageVerifications).toHaveLength(verificationCount);
    await db
      .get('writer')
      .update(PosUser)
      .set({ cover_image: `uploads/users/profile_image/${input.upload.id}.png`, is_active: false })
      .where(eq(PosUser.id, 5n));
    const uploads = await db.get('writer').select().from(profileUploads);
    expect(uploads).toHaveLength(2);
    expect(uploads.every((upload) => upload.ownerId !== '2' && upload.ownerId !== '4')).toBe(true);
    const events: ImageCleanupEvent[] = [];
    const worker = profileMediaCleanup(
      db,
      operatorImageStore,
      (event) => events.push(event),
      () => Date.now() + 17 * 60000,
    );
    await worker.runOnce();
    await worker.stop();
    expect(storeImageDeletes).toEqual([`uploads/users/profile_image/${replacement.upload.id}.png`]);
    expect(events.every((event) => event.userId === '2')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/example.test|uploads\/users|Private operator/);
  });
  it('requires complete verified auth reconciliation and imports grants atomically with stable replay', async () => {
    await db
      .get('writer')
      .update(PosUser)
      .set({ is_staff: true, is_superuser: true })
      .where(eq(PosUser.id, 1n));
    const pending = await app.inject('/api/v1/admin/access/groups');
    expect(pending.statusCode).toBe(503);
    expect(pending.json<{ error: { code: string } }>().error.code).toBe(
      'ADMIN_ACCESS_RECONCILIATION_REQUIRED',
    );
    const snapshot = await reconciledAccessFixture();
    expect(
      await reconcileAdministrationAccess(
        db,
        { ...snapshot, exportedAt: '2026-11-17T00:00:00Z' },
        { operatorId: '1' },
      ),
    ).toMatchObject({ replay: true, counts: { operators: 6, groups: 1 } });
    await expect(
      reconcileAdministrationAccess(
        db,
        { ...snapshot, sourceFingerprint: 'b'.repeat(64) },
        { operatorId: '1' },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_ALREADY_RECONCILED' });
    expect(await db.get('writer').select().from(administrationAccessReconciliation)).toHaveLength(
      1,
    );
    expect(await db.get('writer').select().from(administrationGroups)).toHaveLength(1);
    expect(await db.get('writer').select().from(administrationMemberships)).toHaveLength(1);
    expect(await db.get('writer').select().from(administrationDirectPermissions)).toHaveLength(1);
    const catalog = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/access/permissions/search',
      payload: { search: 'stores.' },
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.headers['cache-control']).toBe('private, no-store');
    expect(catalog.json<{ data: { key: string }[] }>().data.map((row) => row.key)).toEqual([
      'stores.change_store',
      'stores.view_store',
    ]);
  });
  it('rejects incomplete/mismatched source access without partial catalog or grant publication', async () => {
    await db
      .get('writer')
      .update(PosUser)
      .set({ is_staff: true, is_superuser: true })
      .where(eq(PosUser.id, 1n));
    const accounts = await db
      .get('writer')
      .select({ id: PosUser.id, isStaff: PosUser.is_staff, isSuperuser: PosUser.is_superuser })
      .from(PosUser);
    const base = {
      version: 1,
      sourceVerified: true,
      sourceFingerprint: 'a'.repeat(64),
      exportedAt: '2026-11-16T00:00:00Z',
      permissions: [
        {
          key: 'stores.view_store',
          appLabel: 'stores',
          model: 'store',
          codename: 'view_store',
          name: 'Can view store',
        },
      ],
      groups: [],
      operators: accounts.map((account) => ({
        id: String(account.id),
        isStaff: account.isStaff,
        isSuperuser: account.isSuperuser,
        legacyGroupIds: [],
        permissionKeys: [],
      })),
    };
    await expect(
      reconcileAdministrationAccess(
        db,
        { ...base, operators: base.operators.slice(1) },
        { operatorId: '1' },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_SOURCE_MISMATCH' });
    await expect(
      reconcileAdministrationAccess(
        db,
        {
          ...base,
          operators: base.operators.map((operator) =>
            operator.id === '2' ? { ...operator, isStaff: true } : operator,
          ),
        },
        { operatorId: '1' },
      ),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_SOURCE_MISMATCH' });
    expect(await db.get('writer').select().from(administrationPermissions)).toEqual([]);
    expect(await db.get('writer').select().from(administrationAccessReconciliation)).toEqual([]);
  });
  it('unions current direct/group permissions while restricting privilege mutations and honoring revocation', async () => {
    await reconciledAccessFixture();
    const reader: Principal = { ...actor, id: '2', role: 1 };
    await expect(
      db
        .get('writer')
        .transaction((tx) => assertModelAdministrationPermission(tx, reader, ['auth.view_group'])),
    ).resolves.toMatchObject({ id: 2n });
    await expect(
      db
        .get('writer')
        .transaction((tx) =>
          assertModelAdministrationPermission(tx, reader, ['users.view_posuser']),
        ),
    ).resolves.toMatchObject({ id: 2n });
    await expect(
      db
        .get('writer')
        .transaction((tx) =>
          assertModelAdministrationPermission(tx, reader, ['stores.change_store']),
        ),
    ).rejects.toMatchObject({ code: 'MODEL_ADMINISTRATION_DENIED' });
    await expect(
      services.access.saveGroup(reader, undefined, {
        operationId: randomUUID(),
        expectedVersion: null,
        name: 'Escalation denied',
        permissionKeys: [],
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_PRIVILEGE_MUTATION_DENIED' });
    await db
      .get('writer')
      .delete(administrationMemberships)
      .where(eq(administrationMemberships.operatorId, '2'));
    await expect(
      db
        .get('writer')
        .transaction((tx) => assertModelAdministrationPermission(tx, reader, ['auth.view_group'])),
    ).rejects.toMatchObject({ code: 'MODEL_ADMINISTRATION_DENIED' });
    await db.get('writer').update(PosUser).set({ is_staff: false }).where(eq(PosUser.id, 2n));
    await expect(
      db
        .get('writer')
        .transaction((tx) =>
          assertModelAdministrationPermission(tx, reader, ['users.view_posuser']),
        ),
    ).rejects.toMatchObject({ code: 'MODEL_ADMINISTRATION_DENIED' });
  });
  it('serializes group CRUD, preserves idempotent receipts and refuses stale/deleted or unknown grants', async () => {
    await reconciledAccessFixture();
    const input = {
      operationId: randomUUID(),
      expectedVersion: null,
      name: 'Fixture cash supervisors',
      permissionKeys: ['stores.change_store'],
    };
    const created = await services.access.saveGroup(actor, undefined, input);
    expect(await services.access.saveGroup(actor, undefined, input)).toEqual(created);
    const first = await services.access.group(actor, created.id);
    const update = {
      operationId: randomUUID(),
      expectedVersion: first.version,
      name: 'Fixture floor supervisors',
      permissionKeys: ['stores.view_store'],
    };
    await services.access.saveGroup(actor, created.id, update);
    await expect(
      services.access.saveGroup(actor, created.id, { ...update, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_CHANGED' });
    const current = await services.access.group(actor, created.id);
    await expect(
      services.access.saveGroup(actor, created.id, {
        ...update,
        expectedVersion: current.version,
        operationId: randomUUID(),
        permissionKeys: ['stores.unknown_permission'],
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_PERMISSION_NOT_FOUND' });
    const removed = { operationId: randomUUID(), expectedVersion: current.version };
    await services.access.deleteGroup(actor, created.id, removed);
    await expect(services.access.deleteGroup(actor, created.id, removed)).resolves.toMatchObject({
      status: 'success',
    });
    expect(
      await db
        .get('writer')
        .select()
        .from(administrationGroupPermissions)
        .where(eq(administrationGroupPermissions.groupId, created.id)),
    ).toEqual([]);
    const duplicates = await Promise.allSettled(
      [0, 1].map(() =>
        services.access.saveGroup(actor, undefined, { ...input, operationId: randomUUID() }),
      ),
    );
    expect(duplicates.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(duplicates.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('previews and atomically deletes selected groups, deduplicates operator revocation and replays a single receipt', async () => {
    await reconciledAccessFixture();
    const groups = await Promise.all(
      ['Bulk fixture first', 'Bulk fixture second'].map((name) =>
        services.access.saveGroup(actor, undefined, {
          operationId: randomUUID(),
          expectedVersion: null,
          name,
          permissionKeys: ['stores.view_store'],
        }),
      ),
    );
    const current = await services.access.operator(actor, '4');
    await services.access.updateOperator(actor, '4', {
      operationId: randomUUID(),
      expectedVersion: current.version,
      isStaff: current.isStaff,
      isSuperuser: current.isSuperuser,
      groupIds: groups.map((group) => group.id),
      permissionKeys: current.permissionKeys,
    });
    const enrollmentId = randomUUID();
    await db
      .get('writer')
      .insert(operatorMfaEnrollments)
      .values({
        id: enrollmentId,
        actorId: '4',
        operatorId: '2',
        actorVersion: 'a'.repeat(64),
        operatorVersion: 'b'.repeat(64),
        sealedSecret: 'synthetic-sealed-value',
        state: 'PENDING',
        attempts: 0,
        expiresAt: '2099-01-01 00:00:00.000',
        createdAt: '2026-11-16 00:00:00.000',
      });
    const sessions = mysqlSessions(db),
      affected = await sessions.create('4'),
      unaffected = await sessions.create('5');
    const before = (
      await db
        .get('writer')
        .select()
        .from(operatorAuthEpochs)
        .where(eq(operatorAuthEpochs.userId, '4'))
    )[0]!.epoch;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/access/group-deletion-previews',
      payload: { groupIds: groups.map((group) => group.id) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const preview = response.json<{
      groups: { id: string; version: string; memberCount: string; permissionCount: number }[];
      membershipCount: number;
      permissionAssignmentCount: number;
      operatorAccountsDeleted: number;
    }>();
    expect(preview).toMatchObject({
      membershipCount: 2,
      permissionAssignmentCount: 2,
      operatorAccountsDeleted: 0,
    });
    expect(
      preview.groups.every((group) => group.memberCount === '1' && group.permissionCount === 1),
    ).toBe(true);
    const command = {
      operationId: randomUUID(),
      groups: preview.groups.map((group) => ({ id: group.id, expectedVersion: group.version })),
    };
    const results = await Promise.all([
      services.access.deleteGroups(actor, command),
      services.access.deleteGroups(actor, { ...command, groups: [...command.groups].reverse() }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].deletedGroupIds).toEqual(groups.map((group) => group.id).sort());
    expect(results[0].reauthenticate).toBe(false);
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(operatorAuthEpochs)
          .where(eq(operatorAuthEpochs.userId, '4'))
      )[0]!.epoch,
    ).toBe(before + 1n);
    expect(await sessions.valid('4', affected)).toBe(false);
    expect(await sessions.valid('5', unaffected)).toBe(true);
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(operatorMfaEnrollments)
          .where(eq(operatorMfaEnrollments.id, enrollmentId))
      )[0]!.state,
    ).toBe('CANCELLED');
    expect(
      await db.get('writer').select({ id: PosUser.id }).from(PosUser).where(eq(PosUser.id, 4n)),
    ).toHaveLength(1);
    const [receipt] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_administration_access_mutations WHERE id=?',
      [command.operationId],
    );
    expect(receipt).toHaveLength(1);
    await expect(
      services.access.deleteGroups(actor, { ...command, groups: command.groups.slice(0, 1) }),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_OPERATION_REUSED' });
  });
  it('rejects stale membership previews and missing groups without deleting any selected group', async () => {
    await reconciledAccessFixture();
    const created = await Promise.all(
      ['Scope fixture first', 'Scope fixture second'].map((name) =>
        services.access.saveGroup(actor, undefined, {
          operationId: randomUUID(),
          expectedVersion: null,
          name,
          permissionKeys: [],
        }),
      ),
    );
    const ids = created.map((group) => group.id),
      preview = await services.access.previewGroupDeletion(actor, { groupIds: ids });
    const current = await services.access.operator(actor, '4');
    await services.access.updateOperator(actor, '4', {
      operationId: randomUUID(),
      expectedVersion: current.version,
      isStaff: current.isStaff,
      isSuperuser: current.isSuperuser,
      groupIds: ids,
      permissionKeys: current.permissionKeys,
    });
    const command = {
      operationId: randomUUID(),
      groups: preview.groups.map((group) => ({ id: group.id, expectedVersion: group.version })),
    };
    await expect(services.access.deleteGroups(actor, command)).rejects.toMatchObject({
      code: 'ADMIN_ACCESS_CHANGED',
    });
    expect(
      (await services.access.previewGroupDeletion(actor, { groupIds: ids })).membershipCount,
    ).toBe(2);
    await expect(
      services.access.previewGroupDeletion(actor, { groupIds: [...ids, randomUUID()] }),
    ).rejects.toMatchObject({ code: 'ADMIN_GROUP_NOT_FOUND' });
    for (const id of ids)
      await expect(services.access.group(actor, id)).resolves.toMatchObject({ id });
    const [receipts] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_administration_access_mutations WHERE id=?',
      [command.operationId],
    );
    expect(receipts).toEqual([]);
  });
  it('rolls back all group/M2M writes and audit receipts on a failed selected-group deletion', async () => {
    await reconciledAccessFixture();
    const created = await Promise.all(
      ['Rollback fixture first', 'Rollback fixture second'].map((name) =>
        services.access.saveGroup(actor, undefined, {
          operationId: randomUUID(),
          expectedVersion: null,
          name,
          permissionKeys: ['stores.view_store'],
        }),
      ),
    );
    const ids = created.map((group) => group.id),
      current = await services.access.operator(actor, '4');
    await services.access.updateOperator(actor, '4', {
      operationId: randomUUID(),
      expectedVersion: current.version,
      isStaff: current.isStaff,
      isSuperuser: current.isSuperuser,
      groupIds: ids,
      permissionKeys: current.permissionKeys,
    });
    const preview = await services.access.previewGroupDeletion(actor, { groupIds: ids }),
      command = {
        operationId: randomUUID(),
        groups: preview.groups.map((group) => ({ id: group.id, expectedVersion: group.version })),
      };
    const sessions = mysqlSessions(db),
      credential = await sessions.create('4');
    await connection.query(
      "CREATE TRIGGER tr_group_bulk_reject BEFORE DELETE ON pos_rewrite_administration_groups FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic group delete rejected'",
    );
    try {
      await expect(services.access.deleteGroups(actor, command)).rejects.toThrow();
    } finally {
      await connection.query('DROP TRIGGER tr_group_bulk_reject');
    }
    expect(await services.access.previewGroupDeletion(actor, { groupIds: ids })).toEqual(preview);
    expect(await sessions.valid('4', credential)).toBe(true);
    const [receipts] = await connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM pos_rewrite_administration_access_mutations WHERE id=?',
      [command.operationId],
    );
    expect(receipts).toEqual([]);
    await expect(services.access.deleteGroups(actor, command)).resolves.toMatchObject({
      status: 'success',
    });
  });
  it('checks current group-deletion privileges, enforces exact selection validation and signals actor reauthentication', async () => {
    await reconciledAccessFixture();
    const created = await services.access.saveGroup(actor, undefined, {
      operationId: randomUUID(),
      expectedVersion: null,
      name: 'Actor fixture group',
      permissionKeys: [],
    });
    await db
      .get('writer')
      .insert(administrationMemberships)
      .values({ groupId: created.id, operatorId: '1' });
    const reader = { ...actor, id: '2' as const };
    await expect(
      services.access.previewGroupDeletion(reader, { groupIds: [created.id] }),
    ).rejects.toMatchObject({ code: 'ADMIN_PRIVILEGE_MUTATION_DENIED' });
    const preview = await services.access.previewGroupDeletion(actor, { groupIds: [created.id] });
    for (const groupIds of [
      [],
      [created.id, created.id],
      Array.from({ length: 101 }, () => randomUUID()),
    ])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/access/group-deletion-previews',
            payload: { groupIds },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/access/group-deletion-previews?search=private',
          payload: { groupIds: [created.id] },
        })
      ).statusCode,
    ).toBe(400);
    const input = {
      operationId: randomUUID(),
      groups: preview.groups.map((group) => ({ id: group.id, expectedVersion: group.version })),
    };
    await db.get('writer').update(PosUser).set({ is_superuser: false }).where(eq(PosUser.id, 1n));
    await expect(services.access.deleteGroups(actor, input)).rejects.toMatchObject({
      code: 'ADMIN_PRIVILEGE_MUTATION_DENIED',
    });
    await db.get('writer').update(PosUser).set({ is_superuser: true }).where(eq(PosUser.id, 1n));
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/access/group-deletions',
      payload: input,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ reauthenticate: boolean }>().reauthenticate).toBe(true);
  });
  it('updates operator flags/groups/direct grants atomically, invalidates sessions and detects group-version changes', async () => {
    await reconciledAccessFixture();
    const sessions = mysqlSessions(db),
      credential = await sessions.create('4');
    const current = await services.access.operator(actor, '4');
    const group = await services.access.saveGroup(actor, undefined, {
      operationId: randomUUID(),
      expectedVersion: null,
      name: 'Fixture store controllers',
      permissionKeys: ['stores.change_store'],
    });
    const input = {
      operationId: randomUUID(),
      expectedVersion: current.version,
      isStaff: true,
      isSuperuser: false,
      groupIds: [group.id],
      permissionKeys: ['users.view_posuser'],
    };
    await services.access.updateOperator(actor, '4', input);
    expect(await sessions.valid('4', credential)).toBe(false);
    expect(await services.access.updateOperator(actor, '4', input)).toMatchObject({
      status: 'success',
    });
    const assigned = await services.access.operator(actor, '4'),
      details = await services.access.group(actor, group.id);
    expect(assigned).toMatchObject({
      isStaff: true,
      isSuperuser: false,
      groupIds: [group.id],
      permissionKeys: ['users.view_posuser'],
    });
    expect(details.memberCount).toBe('1');
    await services.access.saveGroup(actor, group.id, {
      operationId: randomUUID(),
      expectedVersion: details.version,
      name: details.name,
      permissionKeys: ['stores.view_store'],
    });
    await expect(
      services.access.updateOperator(actor, '4', {
        ...input,
        operationId: randomUUID(),
        expectedVersion: assigned.version,
      }),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_CHANGED' });
    await expect(
      services.access.updateOperator(actor, actor.id, {
        ...input,
        operationId: randomUUID(),
        expectedVersion: (await services.access.operator(actor, actor.id)).version,
      }),
    ).rejects.toMatchObject({ code: 'SELF_PRIVILEGE_CHANGE_DENIED' });
    await db.get('writer').update(PosUser).set({ is_superuser: false }).where(eq(PosUser.id, 1n));
    await expect(
      services.access.updateOperator(actor, '4', { ...input, operationId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('does not revive old sessions or actor-bound MFA proofs when access flags and groups are restored', async () => {
    await reconciledAccessFixture();
    const sessions = mysqlSessions(db),
      prior = await sessions.create('2'),
      operator = await services.access.operator(actor, '2');
    const reader: Principal = { ...actor, id: '2', role: 1 },
      timestamp = Date.now();
    const enrollments = operatorMfaService(
      applicationConfig,
      db,
      () => timestamp,
      async () => 'data:image/png;base64,aGVsbG8=',
    );
    const pending = await enrollments.start(reader, '3', {
      operationId: randomUUID(),
      expectedVersion: (await enrollments.read(reader, '3')).version,
    });
    await db
      .get('writer')
      .insert(loginChallenges)
      .values({
        id: randomUUID(),
        userId: '2',
        proofHash: 'a'.repeat(64),
        authVersion: 'b'.repeat(64),
        expiresAt: new Date(timestamp + 600000),
        sentCount: 0,
      });
    await db
      .get('writer')
      .insert(loginSecurity)
      .values({
        userId: '2',
        otpHash: 'c'.repeat(64),
        otpExpiresAt: new Date(timestamp + 600000),
        failedCount: 3,
        lockedUntil: new Date(timestamp + 120000),
        lastSentAt: new Date(timestamp),
        failureWindowUntil: new Date(timestamp + 3600000),
      });
    const input = {
      operationId: randomUUID(),
      expectedVersion: operator.version,
      isStaff: false,
      isSuperuser: false,
      groupIds: [],
      permissionKeys: [],
    };
    await services.access.updateOperator(actor, '2', input);
    const changed = await services.access.operator(actor, '2');
    await services.access.updateOperator(actor, '2', {
      operationId: randomUUID(),
      expectedVersion: changed.version,
      isStaff: operator.isStaff,
      isSuperuser: operator.isSuperuser,
      groupIds: operator.groupIds,
      permissionKeys: operator.permissionKeys,
    });
    expect(await sessions.valid('2', prior)).toBe(false);
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(operatorMfaEnrollments)
          .where(eq(operatorMfaEnrollments.id, pending.id))
      )[0]?.state,
    ).toBe('CANCELLED');
    await expect(
      enrollments.confirm(reader, '3', pending.id, { code: '123456' }),
    ).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_EXPIRED' });
    expect(
      await db.get('writer').select().from(loginChallenges).where(eq(loginChallenges.userId, '2')),
    ).toEqual([]);
    const [budget] = await db
      .get('writer')
      .select()
      .from(loginSecurity)
      .where(eq(loginSecurity.userId, '2'));
    expect(budget).toMatchObject({ otpHash: null, otpExpiresAt: null, failedCount: 3 });
    expect(budget?.lockedUntil?.getTime()).toBe(timestamp + 120000);
    expect(budget?.lastSentAt?.getTime()).toBe(timestamp);
    expect(await sessions.valid('2', await sessions.create('2'))).toBe(true);
  });
  it('revokes effective group grants across the500-operator batch boundary and keeps no-op saves harmless', async () => {
    await reconciledAccessFixture();
    const group = await services.access.saveGroup(actor, undefined, {
      operationId: randomUUID(),
      expectedVersion: null,
      name: 'Bulk fixture operators',
      permissionKeys: ['stores.view_store'],
    });
    const ids = Array.from({ length: 501 }, (_value, index) => String(1000 + index));
    for (const id of ids)
      await seed(PosUser, {
        id: BigInt(id),
        username: `bulk${id}`,
        first_name: 'Synthetic',
        last_name: 'Fixture',
        role: 5,
        user_type: 1,
        is_active: true,
        is_staff: false,
        is_superuser: false,
      });
    for (let start = 0; start < ids.length; start += 200)
      await db
        .get('writer')
        .insert(administrationMemberships)
        .values(ids.slice(start, start + 200).map((id) => ({ operatorId: id, groupId: group.id })));
    const sessions = mysqlSessions(db),
      first = await sessions.create(ids[0]!),
      last = await sessions.create(ids.at(-1)!);
    const detail = await services.access.group(actor, group.id);
    await services.access.saveGroup(actor, group.id, {
      operationId: randomUUID(),
      expectedVersion: detail.version,
      name: detail.name,
      permissionKeys: detail.permissionKeys,
    });
    expect(await sessions.valid(ids[0]!, first)).toBe(true);
    await services.access.saveGroup(actor, group.id, {
      operationId: randomUUID(),
      expectedVersion: detail.version,
      name: detail.name,
      permissionKeys: ['stores.change_store'],
    });
    expect(await sessions.valid(ids[0]!, first)).toBe(false);
    expect(await sessions.valid(ids.at(-1)!, last)).toBe(false);
    const epochs = await db.get('writer').select().from(operatorAuthEpochs);
    expect(epochs.filter((epoch) => ids.includes(epoch.userId))).toHaveLength(501);
    expect(
      epochs.filter((epoch) => ids.includes(epoch.userId)).every((epoch) => epoch.epoch === 1n),
    ).toBe(true);
    const current = await services.access.group(actor, group.id);
    await services.access.saveGroup(actor, group.id, {
      operationId: randomUUID(),
      expectedVersion: current.version,
      name: detail.name,
      permissionKeys: detail.permissionKeys,
    });
    expect(await sessions.valid(ids[0]!, first)).toBe(false);
    expect(await sessions.valid(ids.at(-1)!, last)).toBe(false);
  }, 10000);
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
  it('binds private store image uploads to both actor and store, decodes before attachment and streams without public URLs', async () => {
    const imageView = await app.inject('/api/v1/admin/stores/1/image');
    expect(imageView.statusCode).toBe(200);
    expect(imageView.headers['cache-control']).toBe('no-store');
    const input = storeImageUploadInput.parse({
      revision: imageView.json<{ revision: string }>().revision,
      upload: {
        id: randomUUID(),
        kind: 'image',
        name: 'Private fixture.png',
        contentType: 'image/png',
        size: storeImageBytes.length,
        checksum: createHash('sha256').update(storeImageBytes).digest('base64'),
      },
    });
    const reservation = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/image-uploads',
      payload: input,
    });
    expect(reservation.statusCode).toBe(200);
    expect(reservation.headers['cache-control']).toBe('no-store');
    const id = input.upload.id;
    const service = storeImageService(applicationConfig, db, storeImageStore);
    await expect(
      service.attach({ ...actor, id: '3', role: 3, storeIds: ['1'] }, '1', id, input.revision),
    ).rejects.toMatchObject({ code: 'STORE_IMAGE_UPLOAD_NOT_FOUND' });
    await expect(service.attach(actor, '2', id, input.revision)).rejects.toMatchObject({
      code: 'STORE_IMAGE_UPLOAD_NOT_FOUND',
    });
    const valid = storeImageBytes;
    storeImageBytes = Buffer.from('invalid-image-data');
    const refused = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/stores/1/image-uploads/${id}/attachment`,
      payload: { revision: input.revision },
    });
    expect(refused.statusCode).toBe(400);
    const [unchanged] = await db.get('writer').select().from(Store).where(eq(Store.id, 1n));
    expect(unchanged?.store_image).not.toContain(id);
    storeImageBytes = valid;
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/stores/1/image-uploads/${id}/attachment`,
      payload: { revision: input.revision },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(accepted.body).not.toContain('uploads/stores/');
    await service.attach(actor, '1', id, input.revision);
    expect(storeImageVerifications).toHaveLength(2);
    const content = await app.inject('/api/v1/admin/stores/1/image/content');
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['cache-control']).toBe('private, no-store');
    expect(content.headers['content-security-policy']).toContain("default-src 'none'");
    expect(content.rawPayload).toEqual(valid);
  });
  it('rechecks current store revision, role and assignments before publishing uploaded store images', async () => {
    const service = storeImageService(applicationConfig, db, storeImageStore);
    const scoped: Principal = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    const reserve = async () => {
      const input = storeImageUploadInput.parse({
        revision: (await service.get(scoped, '1')).revision,
        upload: {
          id: randomUUID(),
          kind: 'image',
          name: 'Fixture.png',
          contentType: 'image/png',
          size: storeImageBytes.length,
          checksum: createHash('sha256').update(storeImageBytes).digest('base64'),
        },
      });
      await service.reserve(scoped, '1', input);
      return input;
    };
    const stale = await reserve();
    await db
      .get('writer')
      .update(Store)
      .set({ store_name: 'Changed while uploading' })
      .where(eq(Store.id, 1n));
    await expect(
      service.attach(scoped, '1', stale.upload.id, stale.revision),
    ).rejects.toMatchObject({ code: 'STORE_IMAGE_CHANGED' });
    const revoked = await reserve();
    await db.get('writer').delete(UserStore).where(eq(UserStore.django_user_id, 3n));
    await expect(
      service.attach(scoped, '1', revoked.upload.id, revoked.revision),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await seed(UserStore, { django_user_id: 3, store_id: 1 });
    await db.get('writer').update(PosUser).set({ role: 5 }).where(eq(PosUser.id, 3n));
    await expect(
      service.attach(scoped, '1', revoked.upload.id, revoked.revision),
    ).rejects.toMatchObject({ status: 403 });
    expect(storeImageVerifications).toHaveLength(0);
    const [store] = await db.get('writer').select().from(Store).where(eq(Store.id, 1n));
    expect(store?.store_image).not.toContain(revoked.upload.id);
  });
  it('shares image cleanup leasing and retries, retaining every cross-store reference and excluding defaults', async () => {
    let timestamp = Date.now();
    const service = storeImageService(applicationConfig, db, storeImageStore, () => timestamp);
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const input = storeImageUploadInput.parse({
        revision: (await service.get(actor, '1')).revision,
        upload: {
          id: randomUUID(),
          kind: 'image',
          name: 'Fixture.png',
          contentType: 'image/png',
          size: storeImageBytes.length,
          checksum: createHash('sha256').update(storeImageBytes).digest('base64'),
        },
      });
      await service.reserve(actor, '1', input);
      if (index < 2) await service.attach(actor, '1', input.upload.id, input.revision);
      ids.push(input.upload.id);
    }
    const firstKey = `uploads/stores/stores_image/${ids[0]}.png`;
    await db
      .get('writer')
      .update(Store)
      .set({ store_image: firstKey, is_active: false })
      .where(eq(Store.id, 2n));
    expect(await db.get('writer').select().from(storeImageJobs)).toHaveLength(3);
    timestamp += 16 * 60000 + 1;
    const events: ImageCleanupEvent[] = [];
    const workers = [0, 1].map(() =>
      storeImageCleanup(
        db,
        storeImageStore,
        (event) => events.push(event),
        () => timestamp,
      ),
    );
    storeImageDeletionFailure = true;
    await Promise.all(workers.map((worker) => worker.runOnce()));
    expect(storeImageDeletes).toEqual([]);
    storeImageDeletionFailure = false;
    timestamp += 60000;
    await workers[0]!.runOnce();
    expect(storeImageDeletes).toEqual([`uploads/stores/stores_image/${ids[2]}.png`]);
    const jobs = await db.get('writer').select().from(storeImageJobs);
    expect(jobs.filter((job) => job.state === 'retained')).toHaveLength(2);
    expect(jobs.filter((job) => job.state === 'done')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(
      /private-store-image-canary|example.test|uploads\/stores/,
    );
    expect(
      events.every(
        (event) =>
          event.module === 'administration' &&
          event.resource === 'store-image' &&
          event.userId === '1' &&
          event.eventId.startsWith('administration.store-image.cleanup.'),
      ),
    ).toBe(true);
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(storeImageUploads)
          .where(eq(storeImageUploads.id, ids[2]!))
      )[0]?.state,
    ).toBe('cleaned');
    await Promise.all(workers.map((worker) => worker.stop()));
  });
  it('prevents store CRUD from bypassing verified image ownership', async () => {
    const payload = {
      name: 'Fixture Store 1',
      shortName: 'Fixture',
      locationCode: 'LOC-1',
      type: 'STORE',
      category: 'IN_HOUSE',
      latitude: '19',
      longitude: '72',
      address: 'Fixture address',
      cityId: 0,
      countryId: 0,
      phone: '9876543298',
      imagePath: `uploads/stores/stores_image/${randomUUID()}.png`,
    };
    const changed = await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload });
    expect(changed.statusCode).toBe(400);
    expect(changed.json<{ error: { code: string } }>().error.code).toBe(
      'STORE_IMAGE_UPLOAD_REQUIRED',
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/stores',
          payload: { ...payload, name: 'Unverified image', locationCode: 'LOC-3' },
        })
      ).statusCode,
    ).toBe(400);
    expect(await db.get('writer').select().from(storeImageUploads)).toEqual([]);
  });
  it('keeps store Slack credentials write-only, preserves blanks and validates explicit replacement/removal', async () => {
    const secret = 'https://hooks.slack.com/services/T_PRIVATE/B_PRIVATE/privateCanaryToken';
    await db.get('writer').update(Store).set({ slack_group_url: secret }).where(eq(Store.id, 1n));
    for (const path of ['/api/v1/admin/stores', '/api/v1/admin/stores/1']) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(/slack_group_url|T_PRIVATE|B_PRIVATE|privateCanaryToken/);
      expect(response.body).toContain('"slackConfigured":true');
    }
    const payload = {
      name: 'Fixture Store 1',
      shortName: 'Fixture',
      locationCode: 'LOC-1',
      type: 'STORE',
      category: 'IN_HOUSE',
      latitude: '19',
      longitude: '72',
      address: 'Fixture address',
      cityId: 0,
      countryId: 0,
      phone: '9876543298',
      slackUrl: '',
    };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload })).statusCode,
    ).toBe(200);
    const read = async () =>
      (
        await db
          .get('writer')
          .select({ webhook: Store.slack_group_url })
          .from(Store)
          .where(eq(Store.id, 1n))
      )[0]?.webhook;
    expect(await read()).toBe(secret);
    for (const slackUrl of [
      'https://127.0.0.1/services/T/B/key',
      'https://example.test/services/T/B/key',
      'https://hooks.slack.com@evil.test/services/T/B/key',
      'https://hooks.slack.com/services/T/B/key?secret=query',
      'https://hooks.slack.com/services/T/B/key#fragment',
      'https://hooks.slack.com:8443/services/T/B/key',
    ])
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/v1/admin/stores/1',
            payload: { ...payload, slackUrl },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/stores/1',
          payload: { ...payload, slackUrl: secret, removeSlack: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/stores/1',
          payload: { ...payload, removeSlack: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(await read()).toBeNull();
    expect((await app.inject('/api/v1/admin/stores/1')).json()).toMatchObject({
      slackConfigured: false,
    });
    const replacement = 'https://hooks.slack.com/services/T_FIXTURE/B_FIXTURE/replacementToken';
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/v1/admin/stores/1',
          payload: { ...payload, slackUrl: replacement },
        })
      ).statusCode,
    ).toBe(200);
    expect(await read()).toBe(replacement);
  });
  it('keeps pending authenticator material encrypted and returns only a local QR', async () => {
    let uri = '';
    const service = operatorMfaService(
      applicationConfig,
      db,
      () => 1805328000000,
      async (value) => {
        uri = value;
        return 'data:image/png;base64,aGVsbG8=';
      },
    );
    const previousSeed = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    await db
      .get('writer')
      .update(PosUser)
      .set({ mfa_hash: previousSeed, is_mfa: false })
      .where(eq(PosUser.id, 4n));
    const current = await service.read(actor, '4'),
      operationId = randomUUID();
    expect(current).toMatchObject({ enabled: false, configured: true, canReplace: true });
    expect(Object.keys(current).sort()).toEqual(['canReplace', 'configured', 'enabled', 'version']);
    const started = await service.start(actor, '4', {
      operationId,
      expectedVersion: current.version,
    });
    const firstUri = uri,
      secret = new URL(uri).searchParams.get('secret')!;
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(new URL(uri).searchParams.get('issuer')).toBe('TssPosApp');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(started.qrDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(JSON.stringify(started)).not.toContain(secret);
    const [pending] = await db
      .get('writer')
      .select()
      .from(operatorMfaEnrollments)
      .where(eq(operatorMfaEnrollments.id, operationId));
    expect(pending?.sealedSecret).not.toContain(secret);
    const [target] = await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n));
    expect(target).toMatchObject({ mfa_hash: previousSeed, is_mfa: false });
    expect(
      await service.start(actor, '4', { operationId, expectedVersion: current.version }),
    ).toEqual(started);
    expect(uri).toBe(firstUri);
  });
  it('activates an authenticator only after exact source TOTP verification and invalidates existing sessions', async () => {
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
    const sessions = mysqlSessions(db),
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
    expect(await sessions.valid('4', credential)).toBe(false);
    const [target] = await db.get('writer').select().from(PosUser).where(eq(PosUser.id, 4n));
    expect(target).toMatchObject({ is_mfa: true, mfa_hash: secret });
    await expect(
      service.start(actor, '4', {
        operationId: randomUUID(),
        expectedVersion: (await service.read(actor, '4')).version,
      }),
    ).rejects.toMatchObject({ code: 'MFA_ALREADY_ACTIVATED' });
  });
  it('persists rejected MFA attempts, throttles retries and expires pending enrollments', async () => {
    let timestamp = 1805328000000,
      uri = '';
    const service = operatorMfaService(
      applicationConfig,
      db,
      () => timestamp,
      async (value) => {
        uri = value;
        return 'data:image/png;base64,aGVsbG8=';
      },
    );
    const current = await service.read(actor, '4'),
      id = randomUUID();
    await service.start(actor, '4', { operationId: id, expectedVersion: current.version });
    const secret = new URL(uri).searchParams.get('secret')!,
      valid = new TOTP({ secret: Secret.fromBase32(secret) }).generate({ timestamp }),
      wrong = valid === '000000' ? '000001' : '000000';
    await expect(service.confirm(actor, '4', id, { code: wrong })).rejects.toMatchObject({
      code: 'MFA_CODE_INVALID',
    });
    await expect(service.confirm(actor, '4', id, { code: wrong })).rejects.toMatchObject({
      code: 'MFA_VERIFICATION_WAIT',
    });
    for (let attempt = 1; attempt < 5; attempt++) {
      timestamp += 1100;
      await expect(service.confirm(actor, '4', id, { code: wrong })).rejects.toMatchObject({
        code: 'MFA_CODE_INVALID',
      });
    }
    const [pending] = await db
      .get('writer')
      .select()
      .from(operatorMfaEnrollments)
      .where(eq(operatorMfaEnrollments.id, id));
    expect(pending).toMatchObject({ attempts: 5, state: 'CANCELLED' });
    await expect(service.confirm(actor, '4', id, { code: valid })).rejects.toMatchObject({
      code: 'MFA_ENROLLMENT_EXPIRED',
    });
    const nextId = randomUUID();
    await service.start(actor, '4', { operationId: nextId, expectedVersion: current.version });
    timestamp += 600001;
    await expect(service.confirm(actor, '4', nextId, { code: valid })).rejects.toMatchObject({
      code: 'MFA_ENROLLMENT_EXPIRED',
    });
    expect((await service.read(actor, '4')).enabled).toBe(false);
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
      syncProducts: async () => {},
      stockProcedure: async (_tx, input) => {
        calls.push(input);
      },
    });
    await inventory.setStock(actor, '1', '6001', 5, 0, randomUUID());
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
        execFileSync('python3', ['tools/administration/legacy_oracle.py'], {
          encoding: 'utf8',
          input: JSON.stringify({
            operation: 'postal-lookup',
            cases: [{ pincode: '400001', row }],
          }),
        }),
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
  it('completes a session-bound Slack OAuth flow exactly once and never returns or persists grant secrets in receipts', async () => {
    const cookieHeader = { cookie: 'pos_session=synthetic-session-one' };
    const view = await app.inject('/api/v1/admin/stores/1/slack-connection');
    expect(view.statusCode).toBe(200);
    const input = {
      operationId: randomUUID(),
      expectedVersion: view.json<{ version: string }>().version,
    };
    const missingCookie = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/slack-connections',
      payload: input,
    });
    expect(missingCookie.statusCode).toBe(401);
    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/stores/1/slack-connections',
      headers: cookieHeader,
      payload: input,
    });
    expect(started.statusCode).toBe(201);
    const result = started.json<{ id: string; authorizationUrl: string }>(),
      state = new URL(result.authorizationUrl).searchParams.get('state')!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.body).not.toMatch(
      /privateFixtureWebhook|fixture@example|actorId|sessionBinding/,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/admin/stores/1/slack-connections',
          headers: cookieHeader,
          payload: input,
        })
      ).json(),
    ).toEqual(started.json());
    const query =
      '/api/v1/admin/slack/oauth/callback?' +
      new URLSearchParams({ state, code: 'synthetic.code' });
    expect(
      (await app.inject({ url: query, headers: { cookie: 'pos_session=synthetic-session-two' } }))
        .statusCode,
    ).toBe(404);
    duringSlackExchange = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    };
    const responses = await Promise.all([
      app.inject({ url: query, headers: cookieHeader }),
      app.inject({ url: query, headers: cookieHeader }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([303, 303]);
    expect(slackExchanges).toBe(1);
    expect(responses[0]?.headers['referrer-policy']).toBe('no-referrer');
    expect(responses[0]?.headers.location).toContain('slackConnection=' + result.id);
    expect(responses[0]?.headers.location).not.toMatch(/code|private|state=/);
    await app.inject({ url: query, headers: cookieHeader });
    expect(slackExchanges).toBe(1);
    expect(await services.slack.attempt(actor, result.id)).toMatchObject({
      state: 'COMPLETED',
      channel: '#fixture-sales',
    });
    const [store] = await db.get('writer').select().from(Store).where(eq(Store.id, 1n));
    expect(store?.slack_group_url).toContain('privateFixtureWebhook');
    expect(JSON.stringify(await db.get('writer').select().from(slackConnections))).not.toMatch(
      /privateFixtureWebhook|synthetic\.code|synthetic-session/,
    );
    expect((await app.inject('/api/v1/admin/stores/1')).body).not.toMatch(
      /privateFixtureWebhook|slack_group_url/,
    );
  });
  it('rejects cross-actor Slack receipts and writer-revoked assignment, organization and role access', async () => {
    const binding = 'a'.repeat(64),
      scoped: Principal = { ...actor, id: '3', role: 3, storeIds: ['1'] };
    const view = await services.slack.view(scoped, '1'),
      id = randomUUID();
    const started = await services.slack.start(
        scoped,
        '1',
        { operationId: id, expectedVersion: view.version },
        binding,
      ),
      state = new URL(started.authorizationUrl).searchParams.get('state')!;
    await expect(services.slack.attempt(actor, id)).rejects.toMatchObject({
      code: 'SLACK_CONNECTION_NOT_FOUND',
    });
    await expect(
      services.slack.complete(actor, { state, code: 'synthetic' }, binding),
    ).rejects.toMatchObject({ code: 'SLACK_CONNECTION_NOT_FOUND' });
    await db.get('writer').delete(UserStore).where(eq(UserStore.django_user_id, 3n));
    await expect(
      services.slack.complete(scoped, { state, code: 'synthetic' }, binding),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await seed(UserStore, { django_user_id: 3, store_id: 1 });
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 3n));
    await expect(services.slack.view(scoped, '1')).rejects.toMatchObject({
      code: 'STORE_ACCESS_DENIED',
    });
    await db.get('writer').update(PosUser).set({ user_type: 1, role: 5 }).where(eq(PosUser.id, 3n));
    await expect(services.slack.view(scoped, '1')).rejects.toMatchObject({
      code: 'SLACK_CONNECTION_DENIED',
    });
    expect(slackExchanges).toBe(0);
  });
  it('fails closed on stale store/auth versions, provider rejection and cancellation without overwriting a connection', async () => {
    const binding = 'b'.repeat(64);
    const start = async () => {
      const view = await services.slack.view(actor, '1'),
        value = await services.slack.start(
          actor,
          '1',
          { operationId: randomUUID(), expectedVersion: view.version },
          binding,
        );
      return { ...value, state: new URL(value.authorizationUrl).searchParams.get('state')! };
    };
    await db
      .get('writer')
      .update(Store)
      .set({
        slack_group_url: 'https://hooks.slack.com/services/T_EXISTING/B_EXISTING/existingSecret',
      })
      .where(eq(Store.id, 1n));
    const stale = await start();
    await db
      .get('writer')
      .update(Store)
      .set({ store_name: 'Changed store' })
      .where(eq(Store.id, 1n));
    await services.slack.complete(actor, { state: stale.state, code: 'synthetic' }, binding);
    expect(await services.slack.attempt(actor, stale.id)).toMatchObject({
      state: 'FAILED',
      errorCode: 'SLACK_CONNECTION_CHANGED',
    });
    const revoked = await start();
    await db.get('writer').transaction(async (tx) => {
      await tx.select().from(PosUser).where(eq(PosUser.id, 1n)).for('update');
      await invalidateOperatorAuthentication(tx, '1');
    });
    await services.slack.complete(actor, { state: revoked.state, code: 'synthetic' }, binding);
    expect(await services.slack.attempt(actor, revoked.id)).toMatchObject({ state: 'FAILED' });
    expect(slackExchanges).toBe(0);
    const denied = await start();
    await services.slack.complete(actor, { state: denied.state, error: 'access_denied' }, binding);
    expect(await services.slack.attempt(actor, denied.id)).toMatchObject({ state: 'CANCELLED' });
    const rejected = await start();
    slackExchangeFailure = true;
    await services.slack.complete(actor, { state: rejected.state, code: 'synthetic' }, binding);
    const receipt = await services.slack.attempt(actor, rejected.id);
    expect(receipt).toMatchObject({ state: 'FAILED', errorCode: 'SLACK_OAUTH_EXCHANGE_FAILED' });
    expect(JSON.stringify(receipt)).not.toContain('private-slack-token');
    const current = (await db.get('writer').select().from(Store).where(eq(Store.id, 1n)))[0];
    expect(current?.slack_group_url).toContain('existingSecret');
  });
  it('rechecks authorization after Slack exchange and fences cancelled or superseded publication', async () => {
    const binding = 'd'.repeat(64),
      view = await services.slack.view(actor, '1');
    const first = await services.slack.start(
      actor,
      '1',
      { operationId: randomUUID(), expectedVersion: view.version },
      binding,
    );
    const state = new URL(first.authorizationUrl).searchParams.get('state')!;
    duringSlackExchange = async () => {
      await services.slack.cancel(actor, first.id);
    };
    await services.slack.complete(actor, { state, code: 'synthetic' }, binding);
    expect(await services.slack.attempt(actor, first.id)).toMatchObject({ state: 'CANCELLED' });
    expect((await services.slack.view(actor, '1')).configured).toBe(false);
    const second = await services.slack.start(
      actor,
      '1',
      { operationId: randomUUID(), expectedVersion: view.version },
      binding,
    );
    duringSlackExchange = async () => {
      await db.get('writer').update(PosUser).set({ role: 5 }).where(eq(PosUser.id, 1n));
    };
    await services.slack.complete(
      actor,
      { state: new URL(second.authorizationUrl).searchParams.get('state')!, code: 'synthetic' },
      binding,
    );
    expect(
      (await db.get('writer').select().from(Store).where(eq(Store.id, 1n)))[0]?.slack_group_url,
    ).toBeNull();
    expect(
      (
        await db
          .get('writer')
          .select()
          .from(slackConnections)
          .where(eq(slackConnections.id, second.id))
      )[0]?.state,
    ).toBe('FAILED');
  });
  it('expires short-lived Slack attempts and prunes old receipts with bounded writer work', async () => {
    let now = Date.now();
    const service = slackConnectionService(
        applicationConfig,
        db,
        { slackOAuth: slackProvider },
        () => now,
      ),
      binding = 'e'.repeat(64);
    const view = await service.view(actor, '1'),
      started = await service.start(
        actor,
        '1',
        { operationId: randomUUID(), expectedVersion: view.version },
        binding,
      );
    now += 600001;
    await service.complete(
      actor,
      { state: new URL(started.authorizationUrl).searchParams.get('state')!, code: 'synthetic' },
      binding,
    );
    expect(await service.attempt(actor, started.id)).toMatchObject({ state: 'EXPIRED' });
    expect(slackExchanges).toBe(0);
    expect(await pruneSlackConnections(db, now + 86400001)).toBe(1);
    await expect(service.attempt(actor, started.id)).rejects.toMatchObject({
      code: 'SLACK_CONNECTION_NOT_FOUND',
    });
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
    expect(await services.checkins.checkedInStore('1')).toBeNull();
    expect(await services.checkins.checkedInUsers('1')).not.toContain('1');
    expect(await services.checkins.current(actor)).toBeNull();
    await expect(
      db
        .get('writer')
        .transaction((tx) => services.checkins.assertCheckIn('1', '1', undefined, tx)),
    ).rejects.toMatchObject({ code: 'STORE_ACCESS_DENIED' });
    await seed(UserStore, { django_user_id: 1, store_id: 1 });
    await db.get('writer').update(Store).set({ category: 'IN_HOUSE' }).where(eq(Store.id, 1n));
    expect(await services.checkins.checkedInStore('1')).toBeNull();
    expect(await services.checkins.checkedInUsers('1')).not.toContain('1');
  });
  it('prevents manual webhook editing from bypassing current franchise organization and assignment checks', async () => {
    const payload = {
      name: 'Fixture Store 1',
      shortName: 'Fixture',
      locationCode: 'LOC-1',
      type: 'STORE',
      category: 'IN_HOUSE',
      latitude: '19',
      longitude: '72',
      address: 'Fixture address',
      cityId: 0,
      countryId: 0,
      phone: '9876543298',
      slackUrl: 'https://hooks.slack.com/services/T0123456789/B0123456789/privateReplacement',
    };
    await db.get('writer').update(PosUser).set({ user_type: 2 }).where(eq(PosUser.id, 1n));
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload })).statusCode,
    ).toBe(403);
    await seed(POSFranchise, { id: 77, name: 'Fixture franchise' });
    await db
      .get('writer')
      .update(Store)
      .set({ category: 'FRANCHISE', franchise_id: 77 })
      .where(eq(Store.id, 1n));
    const own = { ...payload, category: 'FRANCHISE', franchiseId: '77' };
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload: own })).statusCode,
    ).toBe(403);
    await seed(UserStore, { django_user_id: 1, store_id: 1 });
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload: own })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/v1/admin/stores/1', payload })).statusCode,
    ).toBe(403);
    expect((await db.get('writer').select().from(Store).where(eq(Store.id, 1n)))[0]).toMatchObject({
      category: 'FRANCHISE',
      franchise_id: 77,
      slack_group_url: payload.slackUrl,
    });
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
