/** Only synthetic evidence in an explicit isolated localhost schema. No live service calls. */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { z } from 'zod';
import { migrationPlan } from '../../src/db/migrations.js';
import { canonicalCashJson } from '../../src/modules/checkout/offline-cash/canonical.js';
import { cashDigest, offlineCashSigner } from '../../src/modules/checkout/offline-cash/crypto.js';
import { cashLines, cashTotals } from '../../src/modules/checkout/offline-cash/evidence.js';
import {
  cashAuthorizationSchema,
  cashReceiptSchema,
  devicePublicKeySchema,
  type CashPriceSnapshot,
} from '../../src/modules/checkout/offline-cash/contracts.js';
import {
  offlineCashAuthorizations,
  offlineCashDevices,
  offlineCashReceipts,
  offlineCashSigningKeys,
} from '../../src/modules/checkout/offline-cash/schema.js';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.js';

export async function nativeSourceCashTemplate(
  connection: mysql.Connection,
  fixtureUrl: URL,
  snapshot: CashPriceSnapshot,
) {
  if (
    fixtureUrl.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(fixtureUrl.hostname) ||
    !/^\/pos_rewrite_offline_tax_test_[a-f0-9]{12}$/.test(fixtureUrl.pathname) ||
    fixtureUrl.search ||
    fixtureUrl.hash
  )
    throw new Error('Source templates require the isolated local pricing schema.');
  const fixture = verifiedMysqlFixture(connection);
  await fixture.create(['users', 'cities', 'zones', 'pricelist', 'pricelist_meta']);
  await fixture.insert('users', {
    id: 777,
    firstname: 'Fixture',
    lastname: 'Guest',
    telephone: '',
  });
  await fixture.insert('cities', { id: 10, city_name: 'Fixture city', state_id: 20 });
  await fixture.insert('zones', { id: 20, name: 'Fixture state' });
  await connection.query('UPDATE stores SET city_id=10 WHERE id=1');
  await fixture.insert('pricelist_meta', { id: 1, is_active: 1 });
  for (const productId of [100, 102])
    await fixture.insert('pricelist', { product_id: productId, pricelist_id: 1, price: 299 });
  for (const migration of migrationPlan().filter((entry) => /\/001[123]_/.test(entry.id)))
    for (const statement of migration.statements) await connection.query(statement);
  const db = drizzle(connection);
  const server = generateKeyPairSync('ed25519'),
    device = generateKeyPairSync('ed25519');
  const signer = offlineCashSigner(
    server.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
  const publicKey = devicePublicKeySchema.parse(device.publicKey.export({ format: 'jwk' }));
  const authorizationId = randomUUID(),
    deviceId = randomUUID();
  const authorization = cashAuthorizationSchema.parse({
    version: 1,
    id: authorizationId,
    deviceId,
    deviceKeyHash: cashDigest(publicKey),
    operatorId: '7',
    operatorAuthVersion: 'a'.repeat(64),
    operatorCustomerId: '777',
    storeId: '1',
    counterId: '2',
    businessDate: snapshot.businessDate,
    issuedAt: snapshot.issuedAt,
    expiresAt: snapshot.expiresAt,
    snapshotId: snapshot.id,
    snapshotHash: cashDigest(snapshot),
    stockPolicy: 'cached-stock-manager',
    mode: 'cash-only',
    currency: 'INR',
    receiptPrefix: 'OC-' + authorizationId.replaceAll('-', '').toUpperCase(),
    receiptCount: 10,
    maxReceiptUnits: 1000,
    maxReceiptCents: 1_000_000,
    maxTotalCents: 5_000_000,
  });
  const lines = cashLines(snapshot, [
    { productId: '101', quantity: 3 },
    { productId: '102', quantity: 1 },
  ]);
  const totals = cashTotals(lines);
  const receipt = cashReceiptSchema.parse({
    version: 1,
    id: randomUUID(),
    authorizationId,
    deviceId,
    operatorId: '7',
    storeId: '1',
    counterId: '2',
    businessDate: snapshot.businessDate,
    draftId: randomUUID(),
    draftVersion: 1,
    sequence: 1,
    receiptNumber: authorization.receiptPrefix + '-0001',
    completedAt: snapshot.issuedAt + 1000,
    currency: 'INR',
    snapshotId: snapshot.id,
    snapshotHash: authorization.snapshotHash,
    stockPolicy: 'cached-stock-manager',
    lines,
    ...totals,
    cashReceivedCents: 100_000,
    changeCents: 100_000 - totals.payableCents,
  });
  const envelope = {
    receipt,
    signature: sign(null, Buffer.from(canonicalCashJson(receipt)), device.privateKey).toString(
      'base64url',
    ),
  };
  await db.insert(offlineCashSigningKeys).values({
    keyId: signer.keyId,
    publicKey: JSON.stringify(signer.publicKey),
    createdAt: snapshot.issuedAt,
  });
  await db.insert(offlineCashDevices).values({
    id: deviceId,
    operatorId: '7',
    storeId: '1',
    counterId: '2',
    publicKey: JSON.stringify(publicKey),
    keyHash: authorization.deviceKeyHash,
    createdAt: snapshot.issuedAt,
  });
  await db.insert(offlineCashAuthorizations).values({
    id: authorizationId,
    deviceId,
    operatorId: '7',
    storeId: '1',
    counterId: '2',
    businessDate: snapshot.businessDate,
    envelope: JSON.stringify(signer.authorize(authorization)),
    snapshot: JSON.stringify(snapshot),
    snapshotHash: authorization.snapshotHash,
    acceptedReceipts: 1,
    acceptedCents: receipt.payableCents,
    createdAt: snapshot.issuedAt,
  });
  await db.insert(offlineCashReceipts).values({
    id: receipt.id,
    authorizationId,
    deviceId,
    sequence: 1,
    operatorId: '7',
    storeId: '1',
    counterId: '2',
    draftId: receipt.draftId,
    businessDate: receipt.businessDate,
    completedAt: receipt.completedAt,
    acceptedAt: receipt.completedAt + 1000,
    receiptNumber: receipt.receiptNumber,
    requestHash: cashDigest(envelope),
    envelope: JSON.stringify(envelope),
    payableCents: receipt.payableCents,
    cashReceivedCents: receipt.cashReceivedCents,
    changeCents: receipt.changeCents,
    status: 'accepted',
    conflicts: '[]',
    version: 1,
  });
  // Change live reference prices after authorization. Frozen selling/tax amounts must survive.
  await connection.query('UPDATE products SET price=999,spl_price=499 WHERE id IN (100,102)');
  const script = fileURLToPath(
    new URL(
      '../../compatibility/upstream/offline-cash-pricing/test_source_template.py',
      import.meta.url,
    ),
  );
  const raw: unknown = JSON.parse(
    execFileSync(
      'uv',
      [
        'run',
        '--project',
        dirname(script),
        '--frozen',
        'python',
        script,
        '--native-driver-template',
      ],
      {
        input: JSON.stringify({ url: fixtureUrl.href, receiptId: receipt.id }) + '\n',
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          UV_PROJECT_ENVIRONMENT: join(tmpdir(), 'pos-offline-pricing-runtime'),
          PYTHONDONTWRITEBYTECODE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ),
  );
  const columns = z.record(z.string(), z.union([z.string(), z.boolean(), z.null()]));
  const template = z
    .object({
      contract: z.literal('pos-offline-cash-template-v1'),
      sourceCommit: z.literal('2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
      receiptId: z.uuid(),
      receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
      operatorCustomerId: z.literal('777'),
      storeId: z.literal('1'),
      counterId: z.literal('2'),
      businessDate: z.iso.date(),
      lineItemsEnabled: z.literal(true),
      header: columns,
      orderStore: columns,
      lines: z.array(columns),
      refundAllocations: z.array(
        z
          .object({
            lineIndex: z.number().int().nonnegative(),
            amountToBeRefunded: z.string(),
            tssPointsUsed: z.string(),
            tssMoneyUsed: z.string(),
            giftVoucherAmount: z.string(),
            couponAmountUsed: z.string(),
            storeDiscountPg: z.string(),
          })
          .strict(),
      ),
      cancellationMessageId: z.literal('1'),
      flagIds: z.array(z.union([z.literal(4), z.literal(13), z.literal(19)])).min(1),
      refundAllocationContract: z.literal('pos-refund-per-hp-v1'),
      refundSourcePatchHash: z.literal(
        'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
      ),
    })
    .strict()
    .parse(raw);
  return { template, receipt, receiptHash: cashDigest(envelope) };
}
