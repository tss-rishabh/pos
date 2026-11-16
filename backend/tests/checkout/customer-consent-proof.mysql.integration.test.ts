import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { splitMigration } from '../../src/db/migrations.js';
import {
  assertCheckoutCustomerConsent,
  checkoutCustomerConsents,
  customerConsentContract,
  type CheckoutCustomerConsentScope,
} from '../../src/modules/checkout/customer-consent-proof.js';

const integration = process.env.MYSQL_INTEGRATION_URL;
describe.skipIf(!integration)('immutable native customer consent proof', () => {
  let connection: mysql.Connection, db: Databases;
  const schema =
    'pos_rewrite_customer_consent_test_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const scope: CheckoutCustomerConsentScope = {
    orderId: '9007199254740993',
    storeId: '1',
    counterId: '2',
    customerId: '9007199254740995',
    inputHash: 'a'.repeat(64),
    moneyUsed: 0,
    pointsUsed: 0,
    voucherAmountUsed: null,
  };
  const cashProof = () => ({
    orderId: BigInt(scope.orderId),
    storeId: 1n,
    counterId: 2n,
    customerId: BigInt(scope.customerId),
    operatorId: null,
    inputHash: scope.inputHash,
    required: 0,
    contactRevision: null,
    contactDigest: null,
    verifiedUntilMs: null,
    acceptedAtMs: 1700000000000n,
    contractVersion: customerConsentContract,
  });
  const benefitProof = () => ({
    ...cashProof(),
    operatorId: 7n,
    required: 1,
    contactRevision: 9007199254740997n,
    contactDigest: 'b'.repeat(64),
    verifiedUntilMs: 1700000900000n,
  });
  const read = (value = scope) =>
    db.get('writer').transaction((tx) => assertCheckoutCustomerConsent(tx, value));
  beforeAll(async () => {
    const base = new URL(integration!);
    if (
      base.protocol !== 'mysql:' ||
      !['localhost', '127.0.0.1'].includes(base.hostname) ||
      base.pathname !== '/pos_rewrite_integration' ||
      base.search ||
      base.hash
    )
      throw new Error('Use only the explicit isolated local integration fixture.');
    connection = await mysql.createConnection({
      host: base.hostname,
      port: Number(base.port || 3306),
      user: decodeURIComponent(base.username),
      password: decodeURIComponent(base.password),
    });
    await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
    await connection.changeUser({ database: schema });
    for (const statement of splitMigration(
      readFileSync('src/modules/checkout/migrations/0017_customer_consent_proof.sql', 'utf8'),
    ))
      await connection.query(statement);
    base.pathname = '/' + schema;
    db = createDatabases(
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'false',
        SESSION_SECRET: 'consent-native-fixture-key-'.repeat(3),
        MYSQL_WRITER_URL: base.href,
        MYSQL_PRIMARY_READER_URL: base.href,
        MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
      }),
    );
  });
  beforeEach(async () => {
    await db.get('writer').delete(checkoutCustomerConsents);
  });
  afterAll(async () => {
    await db?.close();
    if (connection) {
      await connection.query(`DROP DATABASE IF EXISTS ${mysql.escapeId(schema)}`);
      await connection.end();
    }
  });
  it('requires the new attestation even for a plain-cash order and accepts its explicit no-consent decision', async () => {
    await expect(read()).rejects.toMatchObject({ code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED' });
    await db.get('writer').insert(checkoutCustomerConsents).values(cashProof());
    await expect(read()).resolves.toBeUndefined();
  });
  it.each(['moneyUsed', 'pointsUsed', 'voucherAmountUsed'] as const)(
    'independently requires original verification when native %s is positive',
    async (field) => {
      await db.get('writer').insert(checkoutCustomerConsents).values(cashProof());
      await expect(read({ ...scope, [field]: 0.01 })).rejects.toMatchObject({
        code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED',
      });
      await db.get('writer').delete(checkoutCustomerConsents);
      await db.get('writer').insert(checkoutCustomerConsents).values(benefitProof());
      await expect(read({ ...scope, [field]: 0.01 })).resolves.toBeUndefined();
    },
  );
  it('preserves expired but originally valid committed consent without consulting current users, contacts or coupons', async () => {
    // This schema intentionally has no users/coupons/revision tables. Original
    // consent remains valid for committed cash even after a coupon flag changes.
    await db.get('writer').insert(checkoutCustomerConsents).values(benefitProof());
    await expect(read()).resolves.toBeUndefined();
    await expect(
      read({ ...scope, moneyUsed: 50, pointsUsed: 10, voucherAmountUsed: 25 }),
    ).resolves.toBeUndefined();
    const [proof] = await db.get('writer').select().from(checkoutCustomerConsents);
    expect(proof?.contactRevision).toBe(9007199254740997n);
    expect(proof?.verifiedUntilMs).toBe(1700000900000n);
  });
  it.each(['orderId', 'storeId', 'counterId', 'customerId', 'inputHash'] as const)(
    'rejects a mismatched immutable %s binding',
    async (field) => {
      await db.get('writer').insert(checkoutCustomerConsents).values(benefitProof());
      await expect(
        read({ ...scope, [field]: field === 'inputHash' ? 'c'.repeat(64) : '99' }),
      ).rejects.toMatchObject({ code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED' });
    },
  );
  it('rejects old contracts and non-finite/negative native financial values without silently treating them as cash', async () => {
    await db
      .get('writer')
      .insert(checkoutCustomerConsents)
      .values({ ...cashProof(), contractVersion: 'obsolete' });
    await expect(read()).rejects.toMatchObject({ code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED' });
    for (const invalid of [NaN, Infinity, -0.01])
      await expect(read({ ...scope, moneyUsed: invalid })).rejects.toMatchObject({
        code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED',
      });
    for (const orderId of ['bad-id', '0', '9223372036854775808'])
      await expect(read({ ...scope, orderId })).rejects.toMatchObject({
        code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED',
      });
  });
  it('rejects malformed stored proof fields even if an old publisher bypassed the current DDL checks', async () => {
    for (const patch of [
      { required: 2 },
      { contactDigest: 'not-a-digest' },
      { verifiedUntilMs: 1700000000000n },
      { verifiedUntilMs: 1700000900001n },
      { operatorId: null },
      { acceptedAtMs: 9007199254740992n },
      { required: 0 },
    ]) {
      // Only this randomized localhost fixture table is altered. MySQL has
      // per-constraint enforcement, rather than MariaDB's session switch.
      await connection.query(
        'ALTER TABLE pos_rewrite_checkout_customer_consents ALTER CHECK ck_checkout_consent_scope NOT ENFORCED, ALTER CHECK ck_checkout_consent_binding NOT ENFORCED',
      );
      try {
        await db.get('writer').delete(checkoutCustomerConsents);
        const value = { ...benefitProof(), ...patch };
        await connection.execute(
          'INSERT INTO pos_rewrite_checkout_customer_consents (order_id,store_id,counter_id,user_id,operator_id,input_hash,required,contact_revision,contact_digest,verified_until_ms,accepted_at_ms,contract_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            String(value.orderId),
            '1',
            '2',
            String(value.customerId),
            value.operatorId === null ? null : String(value.operatorId),
            value.inputHash,
            value.required,
            String(value.contactRevision),
            value.contactDigest,
            String(value.verifiedUntilMs),
            String(value.acceptedAtMs),
            value.contractVersion,
          ],
        );
        await expect(read()).rejects.toMatchObject({
          code: 'CHECKOUT_CUSTOMER_CONSENT_UNCONFIRMED',
        });
      } finally {
        await db.get('writer').delete(checkoutCustomerConsents);
        await connection.query(
          'ALTER TABLE pos_rewrite_checkout_customer_consents ALTER CHECK ck_checkout_consent_scope ENFORCED, ALTER CHECK ck_checkout_consent_binding ENFORCED',
        );
      }
    }
  });
});
