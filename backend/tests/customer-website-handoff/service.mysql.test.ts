import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../../src/domain/access.js';
import type { SessionCredential } from '../../src/auth/sessions.js';
import { testSessions } from '../helpers/auth-sessions.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { readCustomerContactBinding } from '../../src/modules/checkout/customer-contact-authority.js';
import { checkoutCustomerOtpScope } from '../../src/modules/checkout/customer-verification.js';
import { customerOtpService } from '../../src/modules/customer-otp/service.js';
import { customerOtpOutbox } from '../../src/modules/customer-otp/worker.js';
import { readCustomerOtpOptions } from '../../src/modules/customer-otp/options.js';
import type {
  CustomerOtpDelivery,
  CustomerOtpPayload,
} from '../../src/modules/customer-otp/contracts.js';
import { readCustomerWebsiteHandoffOptions } from '../../src/modules/customer-website-handoff/options.js';
import { customerWebsiteHandoffService } from '../../src/modules/customer-website-handoff/service.js';
import { customerWebsiteHandoffs as grants } from '../../src/modules/customer-website-handoff/schema.js';
import { websiteHandoffFixture } from './mysql-fixture.js';

const template = process.env.CUSTOMER_WEBSITE_HANDOFF_MYSQL_TEST_URL;
const options = readCustomerWebsiteHandoffOptions({
  CUSTOMER_WEBSITE_HANDOFF_ENABLED: 'true',
  CUSTOMER_WEBSITE_HANDOFF_CONTRACT: 'pos-customer-website-handoff-v1',
  CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL: 'https://website.fixture.test/pos/secure-login',
  CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY: 'synthetic-website-receiver-private-key-'.repeat(2),
});
const actor: Principal = {
  id: '1',
  role: 2,
  userType: 1,
  storeIds: ['1'],
  name: 'Synthetic operator',
  email: '',
};
describe.skipIf(!template)('purpose-bound website handoff on isolated MySQL', () => {
  let native: Awaited<ReturnType<typeof websiteHandoffFixture>>;
  let state: CheckoutState, session: SessionCredential, now: number;
  let service: ReturnType<typeof customerWebsiteHandoffService>;
  let verification: ReturnType<typeof customerOtpService>;
  const sent: CustomerOtpPayload[] = [];
  const sender: CustomerOtpDelivery = {
    assertReady: () => undefined,
    async send(_id, payload) {
      sent.push(payload);
      return 'accepted';
    },
  };
  const scope = () => ({ storeId: state.storeId, checkoutId: state.id });
  const credential = () => ({ id: session.sessionId, expiresAt: session.expires });
  const issue = (operationId: string = randomUUID()) =>
    service.issue(
      actor,
      scope(),
      {
        operationId,
        expectedVersion: state.version,
        customerConsent: true,
      },
      credential(),
    );
  const redemption = (url: string) => ({
    token: new URL(url).hash.slice(1),
    operationId: randomUUID(),
    browserBinding: 'b'.repeat(43),
  });
  async function save() {
    await native.db
      .get('writer')
      .update(checkoutSessions)
      .set({ state, version: state.version })
      .where(eq(checkoutSessions.id, state.id));
  }
  beforeAll(async () => {
    native = await websiteHandoffFixture(template!);
  });
  beforeEach(async () => {
    await native.reset();
    now = Date.now();
    sent.length = 0;
    await native.fixture.insert('pos_user', {
      id: '1',
      username: 'synthetic-operator',
      password: 'synthetic-not-a-password-hash',
      is_active: 1,
      role: 2,
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
    await native.fixture.insert('user_stores', { id: '1', django_user_id: '1', store_id: '1' });
    await native.fixture.insert('users', {
      id: '7',
      email: 'website.customer@example.test',
      telephone: '9876543210',
      user_type: '2',
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
    await native.fixture.insert('users', {
      id: '88',
      email: 'website.operator@example.test',
      telephone: '9123456780',
      user_type: '8',
      pos_admin_id: '1',
      status: 1,
      is_block: 0,
      is_disabled: 0,
    });
    await checkInService(native.db, native.config).set(actor, '1', '1');
    session = await testSessions(native.config, native.db).create(actor.id, now + 1200000);
    const contact = await native.db
      .get('writer')
      .transaction((tx) => readCustomerContactBinding(tx, '7'));
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
        id: randomUUID(),
        contact,
        expiresAt: now + 300000,
        attempts: 0,
        sent: false,
        lastSentAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
    await native.db.get('writer').insert(checkoutSessions).values({
      id: state.id,
      operatorId: actor.id,
      storeId: '1',
      state,
      version: state.version,
    });
    const otpOptions = readCustomerOtpOptions({
      CUSTOMER_OTP_ENABLED: 'true',
      CUSTOMER_OTP_CONTRACT: 'pos-customer-otp-v1',
      CUSTOMER_OTP_SECRET: 'synthetic-website-handoff-otp-purpose-secret-'.repeat(2),
      CUSTOMER_OTP_WORKER_ENABLED: 'true',
    });
    verification = customerOtpService(native.config, native.db, otpOptions, sender, () => now);
    await verification.request(
      actor,
      checkoutCustomerOtpScope(state),
      state.verificationChallenge!.id,
      randomUUID(),
      contact,
    );
    const worker = customerOtpOutbox(
      native.config,
      native.db,
      otpOptions,
      sender,
      () => now,
      () => undefined,
    );
    for (let i = 0; i < 4; i++) await worker.drain(new AbortController().signal, 10);
    const verified = await verification.verify(
      actor,
      checkoutCustomerOtpScope(state),
      state.verificationChallenge!.id,
      randomUUID(),
      sent[0]!.code,
    );
    state.verifiedCustomerUntil = verified.verifiedUntil;
    state.verifiedCustomerContact = contact;
    await save();
    service = customerWebsiteHandoffService(
      native.config,
      native.db,
      options,
      verification,
      () => now,
      testSessions(native.config, native.db).alive,
    );
  });
  afterAll(async () => {
    await native?.close();
  });

  it('serializes concurrent current-verification capability checks without shared-lock upgrades', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.capabilities(actor, scope(), credential())),
    );
    expect(
      results.every(
        (result) =>
          result.available && !result.requiresVerification && result.checkoutVersion === 1,
      ),
    ).toBe(true);
    expect(await native.db.get('writer').select().from(grants)).toHaveLength(0);
  }, 20000);

  it('20 exact issue and consume retries preserve one grant, fixed expiry and original identities without token storage', async () => {
    const operationId = randomUUID();
    const links = await Promise.all(Array.from({ length: 20 }, () => issue(operationId)));
    expect(new Set(links.map((v) => v.url)).size).toBe(1);
    const link = links[0]!,
      input = redemption(link.url);
    const receipts = await Promise.all(Array.from({ length: 20 }, () => service.redeem(input)));
    expect(receipts.every((v) => JSON.stringify(v) === JSON.stringify(receipts[0]))).toBe(true);
    expect(receipts[0]).toMatchObject({
      customerId: '7',
      operatorId: '1',
      operatorCustomerId: '88',
      storeId: '1',
      counterId: '1',
      checkoutId: state.id,
      checkoutVersion: 1,
      sessionExpiresAt: now + 300000,
    });
    const rows = await native.db.get('writer').select().from(grants);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'CONSUMED', consumedOperationId: input.operationId });
    expect(
      JSON.stringify(rows[0], (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(input.token);
    expect(new URL(link.url).search).toBe('');
    expect(new URL(link.url).hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
    await expect(service.redeem({ ...input, operationId: randomUUID() })).rejects.toMatchObject({
      status: 410,
    });
    await expect(
      service.redeem({ ...input, browserBinding: 'c'.repeat(43) }),
    ).rejects.toMatchObject({ status: 410 });
  }, 20000);
  it('keeps the original issue expiry on lost replies and expires instead of renewing an old intent', async () => {
    const op = randomUUID(),
      link = await issue(op);
    now += 1000;
    expect(await issue(op)).toMatchObject({ url: link.url, expiresAt: link.expiresAt });
    now = link.expiresAt;
    await expect(issue(op)).rejects.toMatchObject({ code: 'CUSTOMER_WEBSITE_HANDOFF_EXPIRED' });
    await expect(service.redeem(redemption(link.url))).rejects.toMatchObject({
      code: 'CUSTOMER_WEBSITE_HANDOFF_EXPIRED',
    });
  });
  it('allows only one competing browser/operation to consume the same link', async () => {
    const link = await issue();
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        service.redeem({
          token: new URL(link.url).hash.slice(1),
          operationId: randomUUID(),
          browserBinding: String(index).padStart(43, 'a'),
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(11);
    expect(await native.db.get('writer').select().from(grants)).toHaveLength(1);
  }, 20000);
  it('revokes superseded links and an explicit revocation cannot be undone by issue replay', async () => {
    const first = await issue(),
      second = await issue();
    await expect(service.redeem(redemption(first.url))).rejects.toMatchObject({ status: 410 });
    expect(await service.revoke(actor, scope(), second.id)).toEqual({
      id: second.id,
      state: 'REVOKED',
    });
    await expect(service.redeem(redemption(second.url))).rejects.toMatchObject({ status: 410 });
    await expect(issue(second.operationId)).rejects.toMatchObject({ status: 410 });
  });
  it('requires the exact original POS session and invalidates an outstanding capability on logout', async () => {
    const link = await issue();
    const other = await testSessions(native.config, native.db).create(actor.id, now + 1200000);
    await expect(
      service.issue(
        actor,
        scope(),
        { operationId: link.operationId, expectedVersion: 1, customerConsent: true },
        { id: other.sessionId, expiresAt: other.expires },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_WEBSITE_OPERATION_CONFLICT' });
    await testSessions(native.config, native.db).revoke(session.sessionId);
    await expect(service.redeem(redemption(link.url))).rejects.toMatchObject({ status: 410 });
  });
  it.each([
    ['revoked assignment', 'DELETE FROM user_stores WHERE django_user_id=1'],
    ['inactive store', 'UPDATE stores SET is_active=0 WHERE id=1'],
    ['inactive operator', 'UPDATE pos_user SET is_active=0 WHERE id=1'],
    ['operator role change', 'UPDATE pos_user SET role=3 WHERE id=1'],
    ['customer contact change', "UPDATE users SET telephone='9765432109' WHERE id=7"],
    ['blocked customer', 'UPDATE users SET is_block=1 WHERE id=7'],
    ['operator customer reassigned', 'UPDATE users SET pos_admin_id=2 WHERE id=88'],
    ['check-in removed', "DELETE FROM pos_rewrite_operator_checkins WHERE operator_id='1'"],
  ])('rejects %s before website authentication', async (_label, sql) => {
    const link = await issue();
    await native.connection.query(sql);
    await expect(service.redeem(redemption(link.url))).rejects.toBeDefined();
    const [row] = await native.db.get('writer').select().from(grants);
    expect(row?.state).toBe('ISSUED');
  });
  it('refuses a changed checkout/version and never treats cached verification flags as a native proof', async () => {
    const link = await issue();
    state.version++;
    await save();
    await expect(service.redeem(redemption(link.url))).rejects.toMatchObject({ status: 410 });
    await native.connection.query(
      "UPDATE pos_rewrite_customer_otp_challenges SET state='CANCELLED'",
    );
    await expect(issue()).rejects.toBeDefined();
  });
  it('binds approved receiver/configuration and refuses a forged stored lifetime', async () => {
    const link = await issue();
    const rotated = customerWebsiteHandoffService(
      native.config,
      native.db,
      {
        ...options,
        CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL: 'https://other.fixture.test/pos/secure-login',
      },
      verification,
      () => now,
    );
    await expect(rotated.redeem(redemption(link.url))).rejects.toMatchObject({ status: 410 });
    await native.db
      .get('writer')
      .update(grants)
      .set({ sessionExpiresAt: BigInt(now + 800000) })
      .where(eq(grants.id, link.id));
    await expect(service.redeem(redemption(link.url))).rejects.toMatchObject({ status: 410 });
  });
});
