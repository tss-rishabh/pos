import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabases, type Databases } from '../../src/db/pools.js';
import { readConfig } from '../../src/config.js';
import {
  customerContactChallenges as challenges,
  customerContactReservations as reservations,
} from '../../src/modules/customer-contacts/schema.js';
import {
  lockCustomerContactKeys,
  assertNoActiveContactChangeReservation,
  reserveCustomerContactKeys,
} from '../../src/modules/customer-contacts/reservations.js';

const template = process.env.CUSTOMER_CONTACT_MYSQL_TEST_URL;
describe.skipIf(!template)(
  'shared registration/contact reservation fence on isolated MySQL',
  () => {
    let connection: mysql.Connection, db: Databases, schema: string;
    const key = 'email:' + 'a'.repeat(64),
      phone = 'phone:' + 'b'.repeat(64),
      now = 1794823200000;
    const pending = (id: string) => ({
      id,
      checkoutId: randomUUID(),
      operatorId: '1',
      storeId: '1',
      counterId: '1',
      customerId: '7',
      activeCustomerId: '7',
      actorVersion: 'a'.repeat(64),
      contactFingerprint: 'b'.repeat(64),
      requestHash: 'c'.repeat(64),
      kind: 'email' as const,
      targetKey: key,
      encryptedInput: 'synthetic-sealed-envelope',
      status: 'PENDING_CURRENT' as const,
      version: 1,
      stage: 'current' as const,
      codeHash: 'd'.repeat(64),
      codeExpiresAt: now + 600000,
      attempts: 0,
      expiresAt: now + 600000,
      retryAt: now + 30000,
      createdAt: now,
      updatedAt: now,
    });
    beforeAll(async () => {
      const url = new URL(template!);
      if (
        url.protocol !== 'mysql:' ||
        !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/pos_rewrite_customer_contacts_test'
      )
        throw new Error('Contact tests require the explicit isolated local schema template.');
      schema = `pos_rewrite_customer_contacts_test_${process.pid}_${randomUUID().slice(0, 8)}`;
      connection = await mysql.createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      });
      await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
      await connection.changeUser({ database: schema });
      for (const statement of readFileSync('src/modules/customer-contacts/migration.sql', 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await connection.query(statement);
      url.pathname = '/' + schema;
      db = createDatabases(
        readConfig({
          NODE_ENV: 'test',
          SESSION_SECRET: 'synthetic-contact-reservation-fixture-secret-'.repeat(2),
          MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
          MYSQL_WRITER_URL: url.href,
          MYSQL_PRIMARY_READER_URL: url.href,
        }),
      );
    });
    beforeEach(async () => {
      await connection.query('DELETE FROM pos_rewrite_customer_contact_reservations');
      await connection.query('DELETE FROM pos_rewrite_customer_contact_challenges');
    });
    afterAll(async () => {
      await db?.close();
      if (connection) {
        await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);
        await connection.end();
      }
    });
    it('rejects active and quarantined changes, retaining the exact existing claim', async () => {
      const id = randomUUID();
      await db.get('writer').insert(challenges).values(pending(id));
      await db.get('writer').transaction(async (tx) => {
        await lockCustomerContactKeys(tx, [key]);
        await reserveCustomerContactKeys(tx, [key], id, now + 600000);
      });
      for (const status of [
        'PENDING_CURRENT',
        'PENDING_NEW',
        'READY',
        'COMMITTING',
        'UNCERTAIN',
      ] as const) {
        await db
          .get('writer')
          .update(challenges)
          .set({ status, expiresAt: status === 'UNCERTAIN' ? now - 1 : now + 600000 })
          .where(eq(challenges.id, id));
        await expect(
          db.get('writer').transaction(async (tx) => {
            await lockCustomerContactKeys(tx, [key]);
            await assertNoActiveContactChangeReservation(tx, [key], now);
          }),
        ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_RESERVED' });
      }
      expect((await db.get('writer').select().from(reservations))[0]?.challengeId).toBe(id);
    });
    it('expires a genuinely expired proof, preserves its history and safely reclaims the contact', async () => {
      const id = randomUUID();
      await db
        .get('writer')
        .insert(challenges)
        .values({ ...pending(id), expiresAt: now - 1 });
      await db
        .get('writer')
        .insert(reservations)
        .values({ key, challengeId: id, expiresAt: now - 1 });
      await db.get('writer').transaction(async (tx) => {
        await lockCustomerContactKeys(tx, [key]);
        await assertNoActiveContactChangeReservation(tx, [key], now);
      });
      const [row] = await db.get('writer').select().from(challenges).where(eq(challenges.id, id));
      expect(row).toMatchObject({ status: 'EXPIRED', activeCustomerId: null, codeHash: '' });
      expect(await db.get('writer').select().from(reservations)).toEqual([]);
    });
    it('fails closed for missing owners and mismatched expiration metadata', async () => {
      const missing = randomUUID();
      await db
        .get('writer')
        .insert(reservations)
        .values({ key, challengeId: missing, expiresAt: now - 1 });
      await expect(
        db.get('writer').transaction(async (tx) => {
          await lockCustomerContactKeys(tx, [key]);
          await assertNoActiveContactChangeReservation(tx, [key], now);
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_RESERVED' });
      const id = randomUUID();
      await db
        .get('writer')
        .insert(challenges)
        .values({ ...pending(id), expiresAt: now - 1 });
      await db
        .get('writer')
        .update(reservations)
        .set({ challengeId: id, expiresAt: now + 1 })
        .where(eq(reservations.key, key));
      await expect(
        db.get('writer').transaction(async (tx) => {
          await lockCustomerContactKeys(tx, [key]);
          await assertNoActiveContactChangeReservation(tx, [key], now);
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_RESERVED' });
    });
    it('sorts duplicate/opposite contact selections into one distributed lock order', async () => {
      const sequences: string[][] = [];
      await Promise.all(
        [
          [key, phone, key],
          [phone, key],
        ].map((input) =>
          db.get('writer').transaction(async (tx) => {
            await lockCustomerContactKeys(tx, input);
            await assertNoActiveContactChangeReservation(tx, input, now);
            sequences.push(input);
          }),
        ),
      );
      expect(sequences).toHaveLength(2);
      const [rows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT COUNT(*) AS count FROM pos_rewrite_customer_contact_mutexes',
      );
      expect(Number(rows[0]?.count)).toBe(2);
      await expect(
        db
          .get('writer')
          .transaction((tx) => lockCustomerContactKeys(tx, ['email:raw-private@example.test'])),
      ).rejects.toThrow();
    });
  },
);
