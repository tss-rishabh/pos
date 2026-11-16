import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql, { type Connection } from 'mysql2/promise';
import { getTableConfig, type MySqlTable } from 'drizzle-orm/mysql-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import {
  PosUser,
  ProductStore,
  Store,
  StoreDayClose,
  UserStore,
} from '../../src/db/legacy-schema.js';
import type { Principal } from '../../src/domain/access.js';
import { canonicalCashJson } from '../../src/modules/checkout/offline-cash/canonical.js';
import { cashDigest, offlineCashSigner } from '../../src/modules/checkout/offline-cash/crypto.js';
import {
  devicePublicKeySchema,
  type CashReceipt,
  type SignedCashReceipt,
} from '../../src/modules/checkout/offline-cash/contracts.js';
import { offlineCashRepository } from '../../src/modules/checkout/offline-cash/repository.js';
import { offlineCashFixture } from './offline-cash-fixtures.js';

const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('offline cash receipt acceptance in an isolated writer', () => {
  let connection: Connection,
    db: Databases,
    config: ReturnType<typeof readConfig>,
    schemaName = '',
    service: ReturnType<typeof offlineCashRepository>,
    privateKey: KeyObject,
    serverSigner: ReturnType<typeof offlineCashSigner>;
  let fixture = offlineCashFixture(),
    authVersion = '3'.repeat(64);
  const operator: Principal = {
    id: '44',
    name: 'Fixture operator',
    email: 'operator@example.com',
    userType: 1,
    role: 5,
    storeIds: ['1'],
  };
  const signed = (receipt: CashReceipt = fixture.receipt): SignedCashReceipt => ({
    receipt,
    signature: sign(null, Buffer.from(canonicalCashJson(receipt)), privateKey).toString(
      'base64url',
    ),
  });
  async function rows(query: string, values: (string | number)[] = []) {
    const [result] = await connection.execute<mysql.RowDataPacket[]>(query, values);
    return result;
  }
  async function seed(
    table: MySqlTable,
    supplied: Record<string, string | number | boolean | null>,
  ) {
    const metadata = getTableConfig(table),
      values: Record<string, string | number | boolean | null> = {};
    for (const column of metadata.columns) {
      if ('autoIncrement' in column && column.autoIncrement) continue;
      const type = column.getSQLType();
      values[column.name] = !column.notNull
        ? null
        : /^(date|datetime|timestamp)/.test(type)
          ? type === 'date'
            ? '2026-11-16'
            : '2026-11-16 00:00:00'
          : type.startsWith('time')
            ? '00:00:00'
            : column.dataType === 'boolean'
              ? false
              : ['number', 'bigint'].includes(column.dataType) || type.startsWith('decimal')
                ? 0
                : '';
    }
    Object.assign(values, supplied);
    const names = Object.keys(values);
    await connection.execute(
      `INSERT INTO ${mysql.escapeId(metadata.name)} (${names.map(mysql.escapeId).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      names.map((name) => values[name]),
    );
  }
  beforeAll(async () => {
    const url = new URL(template!);
    if (
      url.protocol !== 'mysql:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/pos_rewrite_checkout_test'
    )
      throw new Error('Offline cash tests refuse every non-isolated database template.');
    connection = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    schemaName = `pos_rewrite_checkout_test_cash_${process.pid}_${randomUUID().slice(0, 8)}`;
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schemaName)}`);
    await connection.changeUser({ database: schemaName });
    for (const table of [Store, ProductStore, StoreDayClose, PosUser, UserStore]) {
      const metadata = getTableConfig(table),
        definitions = metadata.columns.map(
          (column) =>
            `${mysql.escapeId(column.name)} ${column.getSQLType()}${column.notNull ? ' NOT NULL' : ''}${'autoIncrement' in column && column.autoIncrement ? ' AUTO_INCREMENT' : ''}`,
        ),
        primary = metadata.columns
          .filter((column) => column.primary)
          .map((column) => mysql.escapeId(column.name));
      if (primary.length) definitions.push(`PRIMARY KEY (${primary.join(',')})`);
      await connection.query(
        `CREATE TABLE ${mysql.escapeId(metadata.name)} (${definitions.join(',')}) ENGINE=InnoDB`,
      );
    }
    for (const name of [
      '0011_offline_cash.sql',
      '0012_offline_cash_receipt_identity.sql',
      '0013_offline_cash_import_proof.sql',
    ])
      for (const statement of readFileSync('src/modules/checkout/migrations/' + name, 'utf8')
        .split(';')
        .filter((entry) => entry.trim()))
        await connection.query(statement);
    url.pathname = '/' + schemaName;
    config = readConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'offline-cash-fixture-session-secret-'.repeat(3),
      MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      MYSQL_WRITER_URL: url.href,
      MYSQL_PRIMARY_READER_URL: url.href,
    });
    db = createDatabases(config);
  });
  beforeEach(async () => {
    for (const name of [
      'pos_rewrite_offline_cash_import_proofs',
      'pos_rewrite_offline_cash_signing_keys',
      'pos_rewrite_offline_cash_receipt_lines',
      'pos_rewrite_offline_cash_close_impacts',
      'pos_rewrite_offline_cash_events',
      'pos_rewrite_offline_cash_order_links',
      'pos_rewrite_offline_cash_receipts',
      'pos_rewrite_offline_cash_authorizations',
      'pos_rewrite_offline_cash_devices',
      getTableConfig(StoreDayClose).name,
      getTableConfig(ProductStore).name,
      getTableConfig(Store).name,
      getTableConfig(PosUser).name,
      getTableConfig(UserStore).name,
    ])
      await connection.query(`DELETE FROM ${mysql.escapeId(name)}`);
    fixture = offlineCashFixture();
    authVersion = '3'.repeat(64);
    const server = generateKeyPairSync('ed25519'),
      device = generateKeyPairSync('ed25519'),
      signer = offlineCashSigner(
        server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      );
    privateKey = device.privateKey;
    serverSigner = signer;
    fixture.authorization.deviceKeyHash = cashDigest(
      devicePublicKeySchema.parse(device.publicKey.export({ format: 'jwk' })),
    );
    service = offlineCashRepository(db, config, {
      verifyAuthorization: signer.verify,
      authorizationPublicKey: () => signer.publicKey,
      assertCheckIn: async () => {},
      currentRole: async (_tx, user) => user.role,
      assertStoreAccess: async () => {},
      authenticationVersion: async () => authVersion,
      operatorCustomer: async () => '777',
      clock: () => fixture.snapshot.issuedAt + 10000,
    });
    await seed(Store, { id: 1, store_name: 'Fixture store' });
    await seed(ProductStore, {
      product_id: '9007199254740993',
      store_id: 1,
      stock: 2,
      is_avail: true,
      is_del: false,
    });
    await service.registerDevice(
      operator,
      '1',
      '2',
      fixture.authorization.deviceId,
      devicePublicKeySchema.parse(device.publicKey.export({ format: 'jwk' })),
    );
    await service.saveAuthorization(
      operator,
      signer.authorize(fixture.authorization),
      fixture.snapshot,
    );
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      if (/^pos_rewrite_checkout_test_cash_\d+_[a-f0-9]{8}$/.test(schemaName))
        await connection.query(`DROP DATABASE ${mysql.escapeId(schemaName)}`);
      await connection.end();
    }
  });
  it('accepts20 lost-response retries once, retaining collected cash and a precise SKU without creating an order', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.accept(operator, '1', signed())),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      results.every(
        (result) =>
          result.payableCents === 39900 &&
          result.cashReceivedCents - result.changeCents === 39900 &&
          result.orderId === null,
      ),
    ).toBe(true);
    expect(results[0]!.conflicts).toEqual(['source-import-unavailable']);
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_receipts'))[0]!.count,
    ).toBe(1);
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_events'))[0]!.count,
    ).toBe(1);
    expect(
      (
        await rows(
          'SELECT accepted_receipts, accepted_cents FROM pos_rewrite_offline_cash_authorizations',
        )
      )[0],
    ).toMatchObject({ accepted_receipts: 1, accepted_cents: 39900 });
    const stored = (await rows('SELECT receipt_json FROM pos_rewrite_offline_cash_receipts'))[0]!
      .receipt_json as string;
    expect(stored).toContain('9007199254740993');
  });
  it('marks only the latest close stale once and preserves every frozen amount plus append-only impacts', async () => {
    await seed(StoreDayClose, {
      id: 101,
      store_id: 1,
      close_date: fixture.authorization.businessDate,
      version: 1,
      status: 'CLOSED',
      cash_system: 11,
      cash_actual: 11,
    });
    await seed(StoreDayClose, {
      id: 102,
      store_id: 1,
      close_date: fixture.authorization.businessDate,
      version: 2,
      status: 'CLOSED',
      cash_system: 22,
      cash_actual: 22,
      stale_reason: 'PAYMENT',
    });
    await service.accept(operator, '1', signed());
    expect(
      (await rows('SELECT status,cash_system,cash_actual FROM store_day_close WHERE id=101'))[0],
    ).toMatchObject({ status: 'CLOSED', cash_system: '11.00', cash_actual: '11.00' });
    expect(
      (
        await rows(
          'SELECT status,cash_system,cash_actual,stale_reason FROM store_day_close WHERE id=102',
        )
      )[0],
    ).toMatchObject({
      status: 'STALE',
      cash_system: '22.00',
      cash_actual: '22.00',
      stale_reason: 'OFFLINE_CASH',
    });
    expect(
      (await rows('SELECT close_id,prior_reason FROM pos_rewrite_offline_cash_close_impacts'))[0],
    ).toMatchObject({ close_id: 102, prior_reason: 'PAYMENT' });
    await connection.query("UPDATE store_day_close SET status='CLOSED' WHERE id=102");
    await service.accept(operator, '1', signed());
    expect((await rows('SELECT status FROM store_day_close WHERE id=102'))[0]!.status).toBe(
      'CLOSED',
    );
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_close_impacts'))[0]!
        .count,
    ).toBe(1);
  });
  it('keeps expired-access, revoked-device and stock conflicts countable without changing received money or stock', async () => {
    authVersion = '4'.repeat(64);
    await connection.query('UPDATE pos_rewrite_offline_cash_devices SET revoked_at_ms=1');
    await connection.query('UPDATE product_store SET stock=0');
    const result = await service.accept(operator, '1', signed());
    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        'authorization-revoked',
        'operator-access-changed',
        'stock-shortage',
      ]),
    );
    expect(result.status).toBe('conflicted');
    expect(result.payableCents).toBe(39900);
    expect((await rows('SELECT stock FROM product_store'))[0]!.stock).toBe(0);
  });
  it('rejects forged signatures, mutated same-ID evidence and reused draft/sequence without a second ledger entry', async () => {
    const forged = generateKeyPairSync('ed25519');
    await expect(
      service.accept(operator, '1', {
        receipt: fixture.receipt,
        signature: sign(
          null,
          Buffer.from(canonicalCashJson(fixture.receipt)),
          forged.privateKey,
        ).toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_SIGNATURE_INVALID' });
    await service.accept(operator, '1', signed());
    await expect(
      service.accept(
        operator,
        '1',
        signed({ ...fixture.receipt, cashReceivedCents: 60000, changeCents: 20100 }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.accept(
        operator,
        '1',
        signed({ ...fixture.receipt, id: randomUUID(), draftId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_RECEIPT_CONFLICT' });
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_receipts'))[0]!.count,
    ).toBe(1);
  });
  it('rolls back receipt, authorization consumption and close effects on a SQL failure, allowing safe local retry', async () => {
    await connection.query(
      "CREATE TRIGGER reject_offline_cash_event BEFORE INSERT ON pos_rewrite_offline_cash_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='isolated fixture failure'",
    );
    try {
      await expect(service.accept(operator, '1', signed())).rejects.toThrow();
    } finally {
      await connection.query('DROP TRIGGER reject_offline_cash_event');
    }
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_receipts'))[0]!.count,
    ).toBe(0);
    expect(
      (await rows('SELECT accepted_receipts FROM pos_rewrite_offline_cash_authorizations'))[0]!
        .accepted_receipts,
    ).toBe(0);
    expect((await service.accept(operator, '1', signed())).replayed).toBe(false);
  });
  it('requires original operator or checked-in store manager and enforces signed aggregate limits', async () => {
    await expect(service.accept({ ...operator, id: '45' }, '1', signed())).rejects.toMatchObject({
      code: 'OFFLINE_CASH_OWNER_REQUIRED',
    });
    const manager = { ...operator, id: '46', role: 4 as const };
    expect((await service.accept(manager, '1', signed())).operatorId).toBe('44');
    await expect(service.accept({ ...manager, storeIds: [] }, '1', signed())).rejects.toMatchObject(
      { code: 'STORE_ACCESS_DENIED' },
    );
    await connection.query(
      'UPDATE pos_rewrite_offline_cash_authorizations SET accepted_cents=1000000',
    );
    await expect(
      service.accept(
        operator,
        '1',
        signed({
          ...fixture.receipt,
          id: randomUUID(),
          draftId: randomUUID(),
          sequence: 2,
          receiptNumber: fixture.authorization.receiptPrefix + '-0002',
        }),
      ),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_LIMIT_EXCEEDED' });
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_receipts'))[0]!.count,
    ).toBe(1);
  });
  it('retains verified signing keys so collected cash syncs after private-key rotation', async () => {
    const rotated = offlineCashRepository(db, config, {
      verifyAuthorization: () => false,
      assertCheckIn: async () => {},
      currentRole: async (_tx, user) => user.role,
      assertStoreAccess: async () => {},
      authenticationVersion: async () => authVersion,
      operatorCustomer: async () => '777',
    });
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_signing_keys'))[0]!.count,
    ).toBe(1);
    expect((await rotated.accept(operator, '1', signed())).payableCents).toBe(39900);
  });
  it('detects cached-stock conflicts using indexed pending receipt quantities without reserving or losing cash', async () => {
    await service.accept(operator, '1', signed());
    const second = await service.accept(
      operator,
      '1',
      signed({
        ...fixture.receipt,
        id: randomUUID(),
        draftId: randomUUID(),
        sequence: 2,
        receiptNumber: fixture.authorization.receiptPrefix + '-0002',
      }),
    );
    expect(second.conflicts).toContain('stock-shortage');
    expect(
      (await rows('SELECT SUM(payable_cents) AS total FROM pos_rewrite_offline_cash_receipts'))[0]!
        .total,
    ).toBe('79800');
    expect(
      (await rows('SELECT SUM(quantity) AS total FROM pos_rewrite_offline_cash_receipt_lines'))[0]!
        .total,
    ).toBe('4');
    expect((await rows('SELECT stock FROM product_store'))[0]!.stock).toBe(2);
  });
  it('acknowledges manager review idempotently without changing immutable cash, date or conflicts', async () => {
    const original = await service.accept(operator, '1', signed()),
      manager = { ...operator, id: '46', role: 4 as const },
      input = {
        operationId: randomUUID(),
        expectedVersion: 1,
        reason: 'Cash received; physical stock count is being verified.',
      };
    const first = await service.acknowledge(manager, '1', fixture.receipt.id, input),
      again = await service.acknowledge(manager, '1', fixture.receipt.id, input);
    expect(first).toEqual(again);
    expect(first).toMatchObject({
      version: 2,
      payableCents: original.payableCents,
      businessDate: original.businessDate,
      conflicts: original.conflicts,
      status: 'conflicted',
    });
    expect(
      (
        await rows(
          "SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_events WHERE kind='manager-reviewed'",
        )
      )[0]!.count,
    ).toBe(1);
    await expect(
      service.acknowledge(operator, '1', fixture.receipt.id, input),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
    await expect(
      service.acknowledge(manager, '1', fixture.receipt.id, { ...input, reason: 'Changed review' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.acknowledge(manager, '1', fixture.receipt.id, {
        ...input,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_VERSION_CONFLICT' });
  });
  it('rechecks franchise type, assignment and current store category inside the cash writer transaction', async () => {
    await seed(PosUser, {
      id: 44,
      username: 'fixture-cash-operator',
      role: 1,
      user_type: 2,
      is_active: true,
    });
    await connection.query("UPDATE stores SET category='IN_HOUSE' WHERE id=1");
    const actual = offlineCashRepository(db, config, {
      verifyAuthorization: () => false,
      assertCheckIn: async () => {},
      authenticationVersion: async () => authVersion,
      operatorCustomer: async () => '777',
    });
    const stale = { ...operator, role: 1 as const, userType: 1 as const, storeIds: [] };
    await expect(actual.accept(stale, '1', signed())).rejects.toMatchObject({ status: 403 });
    await connection.query("UPDATE stores SET category='FRANCHISE' WHERE id=1");
    await expect(actual.accept(stale, '1', signed())).rejects.toMatchObject({ status: 403 });
    await seed(UserStore, { django_user_id: 44, store_id: 1 });
    expect((await actual.accept(stale, '1', signed())).payableCents).toBe(39900);
    const next = signed({
      ...fixture.receipt,
      id: randomUUID(),
      draftId: randomUUID(),
      sequence: 2,
      receiptNumber: fixture.authorization.receiptPrefix + '-0002',
    });
    await connection.query("UPDATE stores SET category='IN_HOUSE' WHERE id=1");
    await expect(actual.accept(stale, '1', next)).rejects.toMatchObject({ status: 403 });
    await connection.query("UPDATE stores SET category='FRANCHISE' WHERE id=1");
    await connection.query('DELETE FROM user_stores');
    await expect(actual.accept(stale, '1', next)).rejects.toMatchObject({ status: 403 });
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_receipts'))[0]!.count,
    ).toBe(1);
  });
  it('binds manager import approval to the exact immutable receipt and rejects staff, stale versions and valid-time edits', async () => {
    await service.accept(operator, '1', signed());
    const manager = { ...operator, id: '46', role: 4 as const },
      input = {
        operationId: randomUUID(),
        expectedVersion: 1,
        reason: 'Verified received cash and stock count.',
      };
    await expect(
      service.approveImport(operator, '1', fixture.receipt.id, input),
    ).rejects.toMatchObject({ code: 'ROLE_ACCESS_DENIED' });
    await expect(
      service.approveImport(manager, '1', fixture.receipt.id, {
        ...input,
        orderCreatedAt: '2026-11-16 00:00:00',
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_TIMESTAMP_IMMUTABLE' });
    const first = await service.approveImport(manager, '1', fixture.receipt.id, input);
    expect(await service.approveImport(manager, '1', fixture.receipt.id, input)).toEqual(first);
    expect(first).toMatchObject({
      version: 2,
      status: 'conflicted',
      payableCents: 39900,
      cashReceivedCents: 50000,
      changeCents: 10100,
    });
    const events = await rows(
      "SELECT details_json FROM pos_rewrite_offline_cash_events WHERE kind='import-approved'",
    );
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.details_json as string)).toMatchObject({
      version: 1,
      receiptHash: cashDigest(signed()),
      authorizationId: fixture.authorization.id,
      expectedVersion: 1,
      acknowledgedConflicts: ['source-import-unavailable'],
    });
    await expect(
      service.approveImport(manager, '1', fixture.receipt.id, {
        ...input,
        reason: 'Changed evidence.',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      service.approveImport(manager, '1', fixture.receipt.id, {
        ...input,
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_VERSION_CONFLICT' });
  });
  it('reuses one active device authorization across20 create retries without resetting accepted cash limits', async () => {
    await service.accept(operator, '1', signed());
    const result = await Promise.all(
      Array.from({ length: 20 }, () => {
        const id = randomUUID();
        return service.saveAuthorization(
          operator,
          serverSigner.authorize({
            ...fixture.authorization,
            id,
            receiptPrefix: 'OC-' + id.replaceAll('-', '').toUpperCase(),
          }),
          fixture.snapshot,
        );
      }),
    );
    expect(
      result.every((bundle) => bundle?.envelope.authorization.id === fixture.authorization.id),
    ).toBe(true);
    const context = await service.authorizationContext(
      operator,
      '1',
      '2',
      fixture.authorization.deviceId,
    );
    expect(context.active?.envelope.authorization.id).toBe(fixture.authorization.id);
    expect(
      (await rows('SELECT COUNT(*) AS count FROM pos_rewrite_offline_cash_authorizations'))[0]!
        .count,
    ).toBe(1);
    expect(
      (
        await rows(
          'SELECT accepted_receipts,accepted_cents FROM pos_rewrite_offline_cash_authorizations',
        )
      )[0],
    ).toMatchObject({ accepted_receipts: 1, accepted_cents: 39900 });
  });
  it('revokes an old device grant on an authoritative identity change and preserves its receipts as manager conflicts', async () => {
    authVersion = '4'.repeat(64);
    const context = await service.authorizationContext(
      operator,
      '1',
      '2',
      fixture.authorization.deviceId,
    );
    expect(context.active).toBeNull();
    const id = randomUUID();
    const next = await service.saveAuthorization(
      operator,
      serverSigner.authorize({
        ...fixture.authorization,
        id,
        operatorAuthVersion: authVersion,
        issuedAt: fixture.authorization.issuedAt + 10000,
        receiptPrefix: 'OC-' + id.replaceAll('-', '').toUpperCase(),
      }),
      fixture.snapshot,
    );
    expect(next?.envelope.authorization.id).toBe(id);
    const accepted = await service.accept(operator, '1', signed());
    expect(accepted.conflicts).toEqual(
      expect.arrayContaining(['authorization-revoked', 'operator-access-changed']),
    );
    expect(accepted.payableCents).toBe(39900);
  });
  it('retains honestly late uploaded cash as an expired-authorization conflict even when its original device time is inside the grant', async () => {
    const late = offlineCashRepository(db, config, {
      verifyAuthorization: () => false,
      assertCheckIn: async () => {},
      currentRole: async (_tx, user) => user.role,
      assertStoreAccess: async () => {},
      authenticationVersion: async () => authVersion,
      operatorCustomer: async () => '777',
      sourceImportReady: true,
      clock: () => fixture.authorization.expiresAt + 1,
    });
    const result = await late.accept(operator, '1', signed());
    expect(result).toMatchObject({
      status: 'conflicted',
      conflicts: ['authorization-expired'],
      completedAt: fixture.receipt.completedAt,
      payableCents: 39900,
      cashReceivedCents: 50000,
      changeCents: 10100,
    });
    expect((await late.accept(operator, '1', signed())).replayed).toBe(true);
    expect(
      (await rows('SELECT accepted_receipts FROM pos_rewrite_offline_cash_authorizations'))[0]!
        .accepted_receipts,
    ).toBe(1);
  });
  it('keeps an invalid device clock intact and requires explicit manager attribution inside the signed day/window', async () => {
    const original = signed({
      ...fixture.receipt,
      completedAt: fixture.authorization.expiresAt + 86_400_000,
    });
    const accepted = await service.accept(operator, '1', original),
      manager = { ...operator, id: '46', role: 4 as const };
    expect(accepted.conflicts).toContain('clock-outside-authorization');
    const input = {
      operationId: randomUUID(),
      expectedVersion: 1,
      reason: 'Cash counted and actual shift time checked.',
    };
    await expect(
      service.approveImport(manager, '1', fixture.receipt.id, input),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_CLOCK_ATTRIBUTION_REQUIRED' });
    await expect(
      service.approveImport(manager, '1', fixture.receipt.id, {
        ...input,
        orderCreatedAt: '2026-11-17 10:00:00',
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE_CASH_CLOCK_ATTRIBUTION_REQUIRED' });
    const { offlineCashOrderTimestamp } =
      await import('../../src/modules/checkout/offline-cash/attribution.js');
    const orderCreatedAt = offlineCashOrderTimestamp(
      fixture.authorization,
      fixture.receipt,
      config.BUSINESS_TIMEZONE,
    );
    const approved = await service.approveImport(manager, '1', fixture.receipt.id, {
      ...input,
      orderCreatedAt,
    });
    expect(approved.completedAt).toBe(original.receipt.completedAt);
    expect(approved.businessDate).toBe(fixture.authorization.businessDate);
    expect(
      JSON.parse(
        (await rows('SELECT receipt_json FROM pos_rewrite_offline_cash_receipts'))[0]!
          .receipt_json as string,
      ),
    ).toEqual(original);
  });
});
