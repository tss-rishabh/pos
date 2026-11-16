import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { operationHash } from '../../src/modules/checkout/crypto.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { readCustomerContactOptions } from '../../src/modules/customer-contacts/options.js';
import { customerContactService } from '../../src/modules/customer-contacts/service.js';
import { customerContactOutbox } from '../../src/modules/customer-contacts/worker.js';
import type { CustomerContactDelivery } from '../../src/modules/customer-contacts/contracts.js';
import {
  customerContactChallenges as challenges,
  customerContactDeliveries as deliveries,
  customerContactMutations as mutations,
} from '../../src/modules/customer-contacts/schema.js';
import { customerContactFixture } from './mysql-fixture.js';
import { pruneCustomerContactProofs } from '../../src/modules/customer-contacts/prune.js';
import { openContactOtp } from '../../src/modules/customer-contacts/crypto.js';
import {
  bumpCurrentContactRevision,
  readCurrentContactRevision,
} from '../../src/modules/customer-contacts/revisions.js';
import { contactUsers } from '../../src/modules/customer-contacts/legacy-schema.js';

const template = process.env.CUSTOMER_CONTACT_MYSQL_TEST_URL,
  secret = 'synthetic-contact-service-native-secret-'.repeat(2),
  registrationSecret = 'synthetic-contact-registration-secret-'.repeat(2);
const tables = [
  'users',
  'pos_user',
  'stores',
  'store_counters',
  'user_stores',
  'orders',
  'gift_vouchers',
  'user_eav',
  'user_email_membership_copy_logs',
  'jp_customers',
  'welcome_offer',
  'bank_transfer_requests',
  'refund_alternate_payment_details',
  'refund_requests',
  'coupons',
  'coupons_users',
  'user_detail_logs',
];
const user: Principal = {
  id: '1',
  role: 1,
  userType: 1,
  name: 'Synthetic operator',
  email: 'operator.fixture@example.test',
  storeIds: ['1'],
};
const options = readCustomerContactOptions({
  CUSTOMER_CONTACTS_ENABLED: 'true',
  CUSTOMER_CONTACTS_CONTRACT: 'pos-customer-contact-v1',
  CUSTOMER_CONTACTS_SECRET: secret,
  CUSTOMER_REGISTRATION_SECRET: registrationSecret,
  CUSTOMER_CONTACTS_WORKER_ENABLED: 'true',
  CUSTOMER_CONTACT_EFFECTS_REPLAY_SAFE: 'true',
});
const oldEmail = '9876543210@temp.id',
  newEmail = 'verified.fixture@example.test';
describe.skipIf(!template)(
  'bound two-stage customer contact commands on real isolated MySQL',
  () => {
    let native: Awaited<ReturnType<typeof customerContactFixture>>,
      state: CheckoutState,
      time: number;
    let service: ReturnType<typeof customerContactService>,
      worker: ReturnType<typeof customerContactOutbox>;
    const sent: Parameters<CustomerContactDelivery['sendOtp']>[1][] = [],
      effects: Parameters<CustomerContactDelivery['sourceEffects']>[1][] = [];
    let effectResult: 'accepted' | 'uncertain' = 'accepted';
    let nativeBridge = false;
    let nativeBridgeOutput: unknown;
    let nativeBridgeExit: number | null = null;
    const sender: CustomerContactDelivery = {
      assertReady: () => undefined,
      assertEffectsReady: () => undefined,
      async sendOtp(_id, input) {
        sent.push(input);
        return 'accepted';
      },
      async sourceEffects(_id, input) {
        effects.push(input);
        if (nativeBridge) {
          const transportKey = 'synthetic-native-contact-bridge-service-key-'.repeat(2),
            body = {
              deliveryId: _id,
              bodyHash: operationHash('pos-customer-contact-effects-v1', input, transportKey),
              payload: input,
            };
          const result = spawnSync(
            'uv',
            [
              'run',
              '--project',
              'compatibility/customer-contacts',
              'python',
              'tools/customer-contacts/bridge-native-oracle.py',
            ],
            {
              input: JSON.stringify({ database: native.url, transportKey, body }),
              encoding: 'utf8',
              timeout: 30000,
            },
          );
          nativeBridgeExit = result.status;
          try {
            nativeBridgeOutput = JSON.parse(result.stdout) as unknown;
          } catch {
            nativeBridgeOutput = { error: 'BRIDGE_OUTPUT_INVALID' };
          }
          const expected = z
            .object({
              ack: z
                .object({
                  contract: z.literal('pos-customer-contact-effects-v1'),
                  deliveryId: z.literal(_id),
                  operationId: z.literal(input.operationId),
                  bodyHash: z.literal(body.bodyHash),
                  status: z.literal('accepted'),
                })
                .strict(),
              receiptCount: z.literal(1),
              jobCount: z.literal(5),
              succeeded: z.literal(5),
              publishCalls: z.literal(5),
            })
            .strict();
          return result.status === 0 && expected.safeParse(nativeBridgeOutput).success
            ? 'accepted'
            : 'uncertain';
        }
        return effectResult;
      },
    };
    const scope = () => ({ storeId: '1', checkoutId: state.id });
    const revision = () =>
      native.db.get('writer').transaction(async (tx) => {
        await tx
          .select({ id: contactUsers.id })
          .from(contactUsers)
          .where(eq(contactUsers.id, 7n))
          .for('update');
        return readCurrentContactRevision(tx, '7');
      });
    async function migration(path: string) {
      for (const statement of readFileSync(path, 'utf8')
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((value) => value.trim()))
        await native.connection.query(statement);
    }
    beforeAll(async () => {
      native = await customerContactFixture(template!, tables);
      for (const path of [
        'src/modules/administration/migration.sql',
        'src/modules/checkout/migrations/0002_checkout.sql',
        'src/modules/checkout/migrations/0008_checkout_draft_binding.sql',
        'src/modules/checkout/migrations/0010_customer_registration.sql',
        'migrations/0006_operator_auth_epochs.sql',
      ])
        await migration(path);
      // The verified live indexes are nonunique. Recreate their indexed lock shape.
      await native.connection.query(
        'ALTER TABLE users ADD KEY fixture_email(email),ADD KEY fixture_phone(telephone)',
      );
    });
    beforeEach(async () => {
      const [created] =
        await native.connection.query<import('mysql2').RowDataPacket[]>('SHOW TABLES');
      for (const row of created)
        await native.connection.query('DELETE FROM `' + String(Object.values(row)[0]) + '`');
      time = Date.now();
      sent.length = 0;
      effects.length = 0;
      effectResult = 'accepted';
      nativeBridge = false;
      await native.fixture.insert('pos_user', {
        id: '1',
        username: 'synthetic-operator',
        password: 'synthetic-not-a-password-hash',
        is_active: 1,
        role: 1,
        user_type: 1,
        is_staff: 1,
      });
      await native.fixture.insert('stores', {
        id: '1',
        store_name: 'Synthetic store',
        type: 'STORE',
        is_active: 1,
        category: 'IN_HOUSE',
      });
      await native.fixture.insert('store_counters', {
        id: '1',
        counter_name: 'Synthetic counter',
        store_id: '1',
        is_active: 1,
      });
      await native.fixture.insert('users', {
        id: '7',
        email: oldEmail,
        telephone: '9876543210',
        user_type: '2',
        status: 1,
        is_block: 0,
        is_disabled: 0,
        is_email_verified: 0,
        tss_money: 321.45,
        tss_points: 100,
      });
      await checkInService(native.db, native.config).set(user, '1', '1');
      state = checkoutStateSchema.parse({
        id: randomUUID(),
        operatorId: '1',
        operatorCustomerId: '88',
        storeId: '1',
        counterId: '1',
        tabId: 1,
        customerId: '7',
        verifiedCustomerUntil: time + 60000,
        verifiedCustomerContact: { revision: '0', digest: 'b'.repeat(64) },
        verificationChallenge: {
          id: randomUUID(),
          expiresAt: time + 60000,
          attempts: 0,
          lastSentAt: time,
          sent: true,
        },
        version: 5,
        phase: 'quoted',
        cart: { products: { items: [{ product_id: '123', qty: 2 }] } },
        quote: { payable: '150.00' },
        orderId: null,
        orderSubmissionOperationId: null,
        paymentConfirmation: null,
        salespersonId: '12',
        lineSalespersons: { '123': '13' },
        giftCards: {
          '345': { number: 'synthetic', startDate: '2026-01-01', endDate: '2026-12-31' },
        },
        settlementNote: {
          hash: 'a'.repeat(64),
          message: 'Synthetic private payment note',
          payable: '150.00',
          cashReceived: '200.00',
        },
        orderNotifications: { sendSms: true, npsFeedback: true },
        busyOperationId: null,
        createdAt: time,
        updatedAt: time,
      });
      await native.db
        .get('writer')
        .insert(checkoutSessions)
        .values({ id: state.id, operatorId: user.id, storeId: '1', version: state.version, state });
      service = customerContactService(native.config, native.db, options, sender, () => time);
      worker = customerContactOutbox(native.config, native.db, options, sender, () => time);
    });
    afterAll(async () => {
      await native?.close();
    });
    async function request(kind: 'telephone' | 'email' = 'email', value = newEmail) {
      const current = await service.read(user, scope());
      return service.request(user, scope(), {
        operationId: randomUUID(),
        checkoutVersion: current.checkoutVersion,
        contactFingerprint: current.contactFingerprint,
        kind,
        value,
      });
    }
    async function prove(kind: 'telephone' | 'email' = 'email', value = newEmail) {
      let row = await request(kind, value);
      expect(row.stage).toBe('current');
      expect(await worker.drain(new AbortController().signal, 1)).toMatchObject({ delivered: 1 });
      const old = sent.at(-1)!;
      expect(old.stage).toBe('current');
      row = (
        await service.verify(user, scope(), row.id, {
          operationId: randomUUID(),
          version: row.version,
          stage: 'current',
          code: old.code,
        })
      ).challenge;
      expect(await worker.drain(new AbortController().signal, 1)).toMatchObject({ delivered: 1 });
      const target = sent.at(-1)!;
      expect(target.stage).toBe('new');
      return (
        await service.verify(user, scope(), row.id, {
          operationId: randomUUID(),
          version: row.version,
          stage: 'new',
          code: target.code,
        })
      ).challenge;
    }
    it('requires both exact purpose stages, then commits once with source audit, money preserved and exact checkout reset', async () => {
      const row = await prove(),
        operation = {
          operationId: randomUUID(),
          version: row.version,
          checkoutVersion: state.version,
        };
      const result = await service.commit(user, scope(), row.id, operation);
      expect(result.challenge.status).toBe('COMMITTING');
      expect(effects).toHaveLength(0);
      const [customers] = await native.connection.query<import('mysql2').RowDataPacket[]>(
        'SELECT email,telephone,is_email_verified,tss_money,tss_points FROM users WHERE id=7',
      );
      expect(customers[0]).toMatchObject({
        email: newEmail,
        telephone: '9876543210',
        is_email_verified: 1,
        tss_money: 321.45,
        tss_points: 100,
      });
      const [audits] = await native.connection.query<import('mysql2').RowDataPacket[]>(
        'SELECT user_id,user_type,type,previous_value,new_value,added_by FROM user_detail_logs',
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        user_id: '7',
        user_type: 2,
        type: 'EMAIL',
        previous_value: oldEmail,
        new_value: newEmail,
        added_by: '7',
      });
      const [saved] = await native.db
        .get('writer')
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, state.id));
      expect(saved?.state).toMatchObject({
        ...state,
        phase: 'open',
        version: 6,
        quote: null,
        verifiedCustomerUntil: null,
        verifiedCustomerContact: null,
        verificationChallenge: null,
        registrationId: null,
      });
      expect(saved?.state.settlementNote).toEqual(state.settlementNote);
      expect(await service.commit(user, scope(), row.id, operation)).toEqual(result);
      expect(
        await native.db
          .get('writer')
          .select()
          .from(mutations)
          .where(eq(mutations.id, operation.operationId)),
      ).toHaveLength(1);
      await worker.drain(new AbortController().signal, 1);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        operatorId: '1',
        customerId: '7',
        newValue: newEmail,
        kind: 'email',
      });
      expect((await service.challenge(user, scope(), row.id)).status).toBe('COMMITTED');
      expect(await revision()).toBe(1n);
    });
    it('adds a missing phone using current real email proof and preserves unrelated profile/2FA fields', async () => {
      await native.connection.query('UPDATE users SET email=?,telephone=?,is_two_fa=1 WHERE id=7', [
        'existing.fixture@example.test',
        '',
      ]);
      const row = await prove('telephone', '9876543212');
      expect(sent[0]).toMatchObject({
        channel: 'email',
        destination: 'existing.fixture@example.test',
      });
      await service.commit(user, scope(), row.id, {
        operationId: randomUUID(),
        version: row.version,
        checkoutVersion: 5,
      });
      const [rows] = await native.connection.query<import('mysql2').RowDataPacket[]>(
        'SELECT email,telephone,is_two_fa FROM users WHERE id=7',
      );
      expect(rows[0]).toMatchObject({
        email: 'existing.fixture@example.test',
        telephone: '9876543212',
        is_two_fa: 1,
      });
    });
    it('refuses arbitrary replacement and accounts without a real existing proof', async () => {
      await expect(request('telephone', '9876543212')).rejects.toMatchObject({
        code: 'CUSTOMER_CONTACT_ALREADY_PRESENT',
      });
      await native.connection.query('UPDATE users SET telephone=? WHERE id=7', ['']);
      expect((await service.read(user, scope())).addableKinds).toEqual([]);
      await expect(request()).rejects.toMatchObject({
        code: 'CUSTOMER_CONTACT_EXISTING_PROOF_UNAVAILABLE',
      });
      expect(await native.db.get('writer').select().from(deliveries)).toHaveLength(0);
    });
    it('counts failed proofs durably, replays a failed intent without another guess and locks after the configured phone bound', async () => {
      let row = await request();
      await worker.drain(new AbortController().signal, 1);
      const wrong = sent[0]!.code === '000000' ? '999999' : '000000';
      const intent = {
        operationId: randomUUID(),
        version: row.version,
        stage: 'current',
        code: wrong,
      };
      await expect(service.verify(user, scope(), row.id, intent)).rejects.toMatchObject({
        code: 'CUSTOMER_CONTACT_CODE_INVALID',
      });
      await expect(service.verify(user, scope(), row.id, intent)).rejects.toMatchObject({
        code: 'CUSTOMER_CONTACT_CODE_INVALID',
      });
      row = await service.challenge(user, scope(), row.id);
      expect(row.attemptsRemaining).toBe(2);
      for (let index = 0; index < 2; index++) {
        await expect(
          service.verify(user, scope(), row.id, {
            ...intent,
            operationId: randomUUID(),
            version: row.version,
          }),
        ).rejects.toBeInstanceOf(Error);
        row = await service.challenge(user, scope(), row.id);
      }
      expect(row).toMatchObject({ status: 'LOCKED', attemptsRemaining: 0 });
    });
    it('binds saved proofs to the current contact fingerprint, operator epoch, checkout version and active franchise scope', async () => {
      const row = await prove();
      await native.connection.query('UPDATE users SET telephone=? WHERE id=7', ['9876543219']);
      await expect(
        service.commit(user, scope(), row.id, {
          operationId: randomUUID(),
          version: row.version,
          checkoutVersion: 5,
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_CHANGED' });
      await native.connection.query('UPDATE users SET telephone=? WHERE id=7', ['9876543210']);
      await native.connection.query(
        "INSERT INTO pos_rewrite_operator_auth_epochs(operator_id,epoch) VALUES('1',1)",
      );
      await expect(
        service.commit(user, scope(), row.id, {
          operationId: randomUUID(),
          version: row.version,
          checkoutVersion: 5,
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_CHANGED' });
      await native.connection.query('UPDATE pos_user SET user_type=2 WHERE id=1');
      await expect(service.challenge(user, scope(), row.id)).rejects.toMatchObject({
        code: 'STORE_ACCESS_DENIED',
      });
    });
    it('rolls back customer, audit, checkout and effects on downstream transaction failure', async () => {
      const row = await prove();
      await native.connection.query(
        "CREATE TRIGGER contact_fixture_audit_failure BEFORE INSERT ON user_detail_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic audit failure'",
      );
      try {
        await expect(
          service.commit(user, scope(), row.id, {
            operationId: randomUUID(),
            version: row.version,
            checkoutVersion: 5,
          }),
        ).rejects.toThrow();
      } finally {
        await native.connection.query('DROP TRIGGER contact_fixture_audit_failure');
      }
      const [rows] = await native.connection.query<import('mysql2').RowDataPacket[]>(
        'SELECT email FROM users WHERE id=7',
      );
      expect(rows[0]?.email).toBe(oldEmail);
      expect((await service.challenge(user, scope(), row.id)).status).toBe('READY');
      expect(
        await native.db
          .get('writer')
          .select()
          .from(deliveries)
          .where(eq(deliveries.kind, 'source-effects')),
      ).toHaveLength(0);
      const [saved] = await native.db
        .get('writer')
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.id, state.id));
      expect(saved?.state).toEqual(state);
      expect(await revision()).toBe(0n);
    });
    it('serializes20 concurrent exact final commits and20 workers without duplicate audits or external sends', async () => {
      const row = await prove(),
        input = { operationId: randomUUID(), version: row.version, checkoutVersion: 5 };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => service.commit(user, scope(), row.id, input)),
      );
      expect(new Set(results.map((result) => result.receipt.id)).size).toBe(1);
      const [audits] = await native.connection.query<import('mysql2').RowDataPacket[]>(
        'SELECT id FROM user_detail_logs',
      );
      expect(audits).toHaveLength(1);
      await Promise.all(
        Array.from({ length: 20 }, () => worker.drain(new AbortController().signal, 1)),
      );
      expect(effects).toHaveLength(1);
      expect(await revision()).toBe(1n);
    });
    it('never revives an old proof when contact values are restored after an intervening mutation', async () => {
      const row = await prove();
      await native.db.get('writer').transaction(async (tx) => {
        await tx
          .select({ id: contactUsers.id })
          .from(contactUsers)
          .where(eq(contactUsers.id, 7n))
          .for('update');
        await tx.update(contactUsers).set({ email: newEmail }).where(eq(contactUsers.id, 7n));
        await bumpCurrentContactRevision(tx, '7');
      });
      // An external fixture restores the previous value. The perpetual fence is
      // intentionally retained; contact string equality cannot revive old OTPs.
      await native.connection.query('UPDATE users SET email=? WHERE id=7', [oldEmail]);
      await expect(
        service.commit(user, scope(), row.id, {
          operationId: randomUUID(),
          version: row.version,
          checkoutVersion: 5,
        }),
      ).rejects.toMatchObject({ code: 'CUSTOMER_CONTACT_CHANGED' });
      expect(await revision()).toBe(1n);
    });
    it('retries the exact idempotent effect obligation after uncertainty while leaving collected money and new contact intact', async () => {
      const row = await prove();
      await service.commit(user, scope(), row.id, {
        operationId: randomUUID(),
        version: row.version,
        checkoutVersion: 5,
      });
      effectResult = 'uncertain';
      expect(await worker.drain(new AbortController().signal, 1)).toMatchObject({ retry: 1 });
      expect((await service.challenge(user, scope(), row.id)).status).toBe('COMMITTING');
      time += 10000;
      effectResult = 'accepted';
      await worker.drain(new AbortController().signal, 1);
      expect(effects).toHaveLength(2);
      expect(effects[0]).toEqual(effects[1]);
      expect((await service.challenge(user, scope(), row.id)).status).toBe('COMMITTED');
    });
    it('never auto-resends an OTP after an expired sending lease, but accepts a legitimately arrived code', async () => {
      const row = await request(),
        [job] = await native.db
          .get('writer')
          .select()
          .from(deliveries)
          .where(eq(deliveries.challengeId, row.id));
      const payload = openContactOtp(secret, job!.id, job!.encryptedPayload);
      await native.db
        .get('writer')
        .update(deliveries)
        .set({ status: 'SENDING', leaseToken: randomUUID(), leaseExpiresAt: time - 1 })
        .where(eq(deliveries.id, job!.id));
      expect(await worker.drain(new AbortController().signal, 1)).toMatchObject({ uncertain: 1 });
      await worker.drain(new AbortController().signal, 1);
      expect(sent).toHaveLength(0);
      const saved = await service.verify(user, scope(), row.id, {
        operationId: randomUUID(),
        version: row.version,
        stage: 'current',
        code: payload.code,
      });
      expect(saved.challenge.stage).toBe('new');
    });
    it('cancels unsent OTP delivery after the current store is archived', async () => {
      const row = await request();
      await native.connection.query('UPDATE stores SET is_active=0 WHERE id=1');
      expect(await worker.drain(new AbortController().signal, 1)).toMatchObject({ cancelled: 1 });
      expect(sent).toHaveLength(0);
      const [job] = await native.db
        .get('writer')
        .select()
        .from(deliveries)
        .where(eq(deliveries.challengeId, row.id));
      expect(job).toMatchObject({ status: 'CANCELLED', encryptedPayload: '' });
    });
    it('expires only pending proofs and never prunes an already saved contact or its source obligation', async () => {
      const row = await prove();
      await service.commit(user, scope(), row.id, {
        operationId: randomUUID(),
        version: row.version,
        checkoutVersion: 5,
      });
      time += 31 * 86400000;
      await pruneCustomerContactProofs(native.db, time);
      const [saved] = await native.db
        .get('writer')
        .select()
        .from(challenges)
        .where(eq(challenges.id, row.id));
      expect(saved).toMatchObject({ status: 'COMMITTING', activeCustomerId: '7' });
      const jobs = await native.db
        .get('writer')
        .select()
        .from(deliveries)
        .where(eq(deliveries.kind, 'source-effects'));
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ status: 'PENDING' });
      expect(jobs[0]!.encryptedPayload.length).toBeGreaterThan(30);
    });
    it('prunes an expired pending proof and cancels its unsent code while retaining its audit identity', async () => {
      const row = await request();
      time += 21 * 60000;
      expect(await pruneCustomerContactProofs(native.db, time)).toMatchObject({ expiredProofs: 1 });
      const [saved] = await native.db
        .get('writer')
        .select()
        .from(challenges)
        .where(eq(challenges.id, row.id));
      expect(saved).toMatchObject({
        status: 'EXPIRED',
        activeCustomerId: null,
        codeHash: '',
        operatorId: '1',
        customerId: '7',
      });
      expect((await worker.drain(new AbortController().signal, 1)).delivered).toBe(0);
      expect(sent).toHaveLength(0);
    });
    it('accepts the actual committed Node effect proof in the MySQL bridge and fences20 duplicate accepts/workers', async () => {
      const row = await prove();
      await service.commit(user, scope(), row.id, {
        operationId: randomUUID(),
        version: row.version,
        checkoutVersion: 5,
      });
      nativeBridge = true;
      const outcome = await worker.drain(new AbortController().signal, 1);
      expect(nativeBridgeExit, JSON.stringify(nativeBridgeOutput)).toBe(0);
      expect(nativeBridgeOutput).toMatchObject({
        receiptCount: 1,
        jobCount: 5,
        succeeded: 5,
        publishCalls: 5,
      });
      expect(outcome).toMatchObject({ delivered: 1 });
      expect((await service.challenge(user, scope(), row.id)).status).toBe('COMMITTED');
    }, 30000);
  },
);
