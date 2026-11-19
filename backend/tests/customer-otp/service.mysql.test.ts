import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import type { Principal } from '../../src/domain/access.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import {
  readCustomerContactBinding,
  type CustomerContactBinding,
} from '../../src/modules/checkout/customer-contact-authority.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore, type PosStateStore } from '../../src/modules/checkout/state-store.js';
import { bumpCurrentContactRevision } from '../../src/modules/customer-contacts/revisions.js';
import type {
  CustomerOtpApi,
  CustomerOtpApiReply,
  CustomerOtpScope,
} from '../../src/modules/customer-otp/contracts.js';
import { readCustomerOtpOptions } from '../../src/modules/customer-otp/options.js';
import { customerOtpKeys, customerOtpService } from '../../src/modules/customer-otp/service.js';
import { customerContactFixture } from '../customer-contacts/mysql-fixture.js';

const template = process.env.CUSTOMER_OTP_MYSQL_TEST_URL;
const options = readCustomerOtpOptions({});
const actor: Principal = {
  id: '1',
  role: 1,
  userType: 1,
  name: 'Synthetic operator',
  email: 'operator.fixture@example.test',
  storeIds: ['1'],
};
describe.skipIf(!template)(
  'customer OTP through API-v2 with Redis proofs on isolated MySQL',
  () => {
    let native: Awaited<ReturnType<typeof customerContactFixture>>;
    let store: PosStateStore,
      state: CheckoutState,
      scope: CustomerOtpScope,
      contact: CustomerContactBinding,
      challengeId: string,
      now: number,
      service: ReturnType<typeof customerOtpService>;
    const calls: { kind: 'send' | 'verify'; userId: number | bigint; otp?: number }[] = [];
    let sendReply: CustomerOtpApiReply, verifyReply: (otp: number) => CustomerOtpApiReply;
    const api: CustomerOtpApi = {
      assertReady: () => undefined,
      sendOtp: async (userId) => {
        calls.push({ kind: 'send', userId });
        return sendReply;
      },
      verifyOtp: async (userId, otp) => {
        calls.push({ kind: 'verify', userId, otp });
        return verifyReply(otp);
      },
    };
    const binding = () =>
      native.db.get('writer').transaction((tx) => readCustomerContactBinding(tx, '7'));
    const sessions = () => checkoutSessionStore(store);
    const request = (operationId = randomUUID()) =>
      service.request(actor, scope, challengeId, operationId, contact);
    const verify = (code: string, operationId = randomUUID()) =>
      service.verify(actor, scope, challengeId, operationId, code);
    beforeAll(async () => {
      native = await customerContactFixture(
        template!,
        ['users', 'pos_user', 'stores', 'store_counters', 'user_stores'],
        'pos_rewrite_customer_otp_test',
      );
      for (const path of [
        'src/modules/administration/migration.sql',
        'migrations/0006_operator_auth_epochs.sql',
      ])
        for (const statement of readFileSync(path, 'utf8')
          .replace(/^--.*$/gm, '')
          .split(';')
          .filter((value) => value.trim()))
          await native.connection.query(statement);
    });
    beforeEach(async () => {
      const [tables] = await native.connection.query<RowDataPacket[]>('SHOW TABLES');
      for (const table of tables)
        await native.connection.query('DELETE FROM `' + String(Object.values(table)[0]) + '`');
      now = Date.parse('2026-06-15T12:00:00+05:30');
      calls.length = 0;
      sendReply = { status: 200, body: { mobile: true, email: true } };
      verifyReply = (otp) =>
        otp === 1234
          ? { status: 200, body: { message: 'OTP verified successfully!' } }
          : { status: 400, body: { message: 'Invalid OTP' } };
      await native.fixture.insert('pos_user', {
        id: '1',
        username: 'synthetic-operator',
        password: 'synthetic-not-a-password-hash',
        is_active: 1,
        role: 1,
        user_type: 1,
      });
      await native.fixture.insert('stores', {
        id: '1',
        store_name: 'Synthetic store',
        is_active: 1,
        type: 'STORE',
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
        email: 'otp.fixture@example.test',
        telephone: '9876543210',
        user_type: '2',
        status: 1,
        is_block: 0,
        is_disabled: 0,
      });
      await checkInService(native.db, native.config).set(actor, '1', '1');
      contact = await binding();
      challengeId = randomUUID();
      state = checkoutStateSchema.parse({
        id: randomUUID(),
        operatorId: '1',
        operatorCustomerId: '88',
        storeId: '1',
        counterId: '1',
        tabId: 1,
        customerId: '7',
        phase: 'open',
        version: 1,
        verifiedCustomerUntil: null,
        cart: { products: { items: [] } },
        quote: null,
        orderId: null,
        paymentConfirmation: null,
        salespersonId: null,
        lineSalespersons: {},
        giftCards: {},
        busyOperationId: null,
        verificationChallenge: {
          id: challengeId,
          contact,
          expiresAt: now + 300000,
          attempts: 0,
          sent: false,
          lastSentAt: now,
        },
        createdAt: now,
        updatedAt: now,
      });
      scope = {
        operatorId: '1',
        storeId: '1',
        counterId: '1',
        customerId: '7',
        purpose: 'checkout-benefits',
        subjectId: state.id,
        orderId: null,
      };
      store = memoryStateStore(() => now);
      await sessions().write(state);
      service = customerOtpService(native.config, native.db, options, {
        stateStore: store,
        api,
        clock: () => now,
      });
    });
    afterAll(async () => {
      await native?.close();
    });

    it('sends once through API-v2, replays the same operation and refuses a different one', async () => {
      const operationId = randomUUID();
      const first = await request(operationId);
      expect(first).toMatchObject({ id: challengeId, status: 'sent', verifiedUntil: null });
      expect(await request(operationId)).toEqual(first);
      expect(calls).toEqual([{ kind: 'send', userId: 7 }]);
      await expect(request()).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      const saved = await store.get(customerOtpKeys.challenge(challengeId));
      expect(saved).not.toContain('9876543210');
      expect(saved).not.toContain('otp.fixture');
      expect(await service.readOperation(actor, scope, challengeId, operationId)).toEqual({
        kind: 'request',
        result: first,
        error: null,
      });
    });
    it('maps legacy "OTP Not Sent" and unknown send outcomes', async () => {
      sendReply = { status: 200, body: { mobile: false, email: false } };
      const operationId = randomUUID();
      await expect(request(operationId)).rejects.toMatchObject({
        code: 'CUSTOMER_OTP_NOT_SENT',
        status: 400,
      });
      expect(await service.readOperation(actor, scope, challengeId, operationId)).toMatchObject({
        kind: 'request',
        error: 'CUSTOMER_OTP_NOT_SENT',
        result: { status: 'rejected' },
      });
      challengeId = randomUUID();
      state = {
        ...state,
        verificationChallenge: { ...state.verificationChallenge!, id: challengeId },
      };
      await sessions().write(state);
      sendReply = null;
      expect(await request()).toMatchObject({ status: 'uncertain' });
    });
    it('verifies a 4-digit code, keeps the proof fixed and checks it inside a caller transaction', async () => {
      await request();
      await expect(verify('123456')).rejects.toMatchObject({ code: 'CUSTOMER_OTP_FORMAT' });
      await expect(verify('9999')).rejects.toMatchObject({
        code: 'CUSTOMER_OTP_INVALID',
        status: 400,
      });
      const operationId = randomUUID(),
        verified = await verify('1234', operationId);
      expect(verified.verifiedUntil).toBe(now + options.REDIS_VERIFIED_USER_OBJECT_EXPIRY * 1000);
      expect(calls.filter((call) => call.kind === 'verify').map((call) => call.otp)).toEqual([
        9999, 1234,
      ]);
      now += 1000;
      expect(await verify('1234', operationId)).toEqual(verified);
      expect(calls.filter((call) => call.kind === 'verify')).toHaveLength(2);
      await expect(
        native.db
          .get('writer')
          .transaction((tx) =>
            service.assertVerified(tx, actor, scope, challengeId, contact, verified.verifiedUntil!),
          ),
      ).resolves.toBeUndefined();
      await expect(
        native.db
          .get('writer')
          .transaction((tx) =>
            service.assertVerified(
              tx,
              actor,
              scope,
              challengeId,
              contact,
              verified.verifiedUntil! + 1,
            ),
          ),
      ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED', status: 403 });
    });
    it('locks after the configured wrong codes and never asks API-v2 again', async () => {
      await request();
      for (let index = 1; index < options.CUSTOMER_OTP_FAILURES_PER_WINDOW; index++)
        await expect(verify('0000')).rejects.toMatchObject({ code: 'CUSTOMER_OTP_INVALID' });
      await expect(verify('0000')).rejects.toMatchObject({
        code: 'CUSTOMER_OTP_ATTEMPT_LIMIT',
        status: 429,
      });
      const asked = calls.length;
      await expect(verify('1234')).rejects.toMatchObject({ status: 403 });
      expect(calls).toHaveLength(asked);
    });
    it('expires the challenge after five minutes although API-v2 keeps the code', async () => {
      await request();
      now += 5 * 60_000;
      await expect(verify('1234')).rejects.toMatchObject({ code: 'CUSTOMER_OTP_EXPIRED' });
      expect(calls.some((call) => call.kind === 'verify')).toBe(false);
    });
    it('does not spend an attempt when API-v2 does not answer', async () => {
      await request();
      verifyReply = () => null;
      await expect(verify('1234')).rejects.toMatchObject({
        code: 'CUSTOMER_OTP_VERIFY_UNAVAILABLE',
        status: 503,
      });
      verifyReply = () => ({ status: 200, body: { message: 'OTP verified successfully!' } });
      expect((await verify('1234')).verifiedUntil).not.toBeNull();
    });
    it('rejects a changed sale, customer contact or daily send budget', async () => {
      await sessions().write({
        ...state,
        verificationChallenge: { ...state.verificationChallenge!, id: randomUUID() },
      });
      await expect(request()).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
      await sessions().write(state);
      await request();
      await native.db.get('writer').transaction((tx) => bumpCurrentContactRevision(tx, '7'));
      await expect(verify('1234')).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
      contact = await binding();
      for (let index = 1; index < options.CUSTOMER_OTP_SENDS_PER_DAY; index++) {
        challengeId = randomUUID();
        await sessions().write({
          ...state,
          verificationChallenge: { ...state.verificationChallenge!, id: challengeId, contact },
        });
        await request();
      }
      challengeId = randomUUID();
      await sessions().write({
        ...state,
        verificationChallenge: { ...state.verificationChallenge!, id: challengeId, contact },
      });
      await expect(request()).rejects.toMatchObject({
        code: 'CUSTOMER_OTP_SEND_LIMIT',
        status: 429,
      });
    });
  },
);
