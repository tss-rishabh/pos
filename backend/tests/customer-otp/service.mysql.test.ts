import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2';
import type { Principal } from '../../src/domain/access.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { returnVerifications } from '../../src/modules/checkout/return-workflow/schema.js';
import {
  readCustomerContactBinding,
  type CustomerContactBinding,
} from '../../src/modules/checkout/customer-contact-authority.js';
import { contactUsers } from '../../src/modules/customer-contacts/legacy-schema.js';
import { bumpCurrentContactRevision } from '../../src/modules/customer-contacts/revisions.js';
import { readCustomerOtpOptions } from '../../src/modules/customer-otp/options.js';
import { customerOtpService } from '../../src/modules/customer-otp/service.js';
import {
  customerOtpOutbox,
  type CustomerOtpWorkerEvent,
} from '../../src/modules/customer-otp/worker.js';
import { openCustomerOtp } from '../../src/modules/customer-otp/crypto.js';
import { pruneCustomerOtpProofs } from '../../src/modules/customer-otp/prune.js';
import type {
  CustomerOtpDelivery,
  CustomerOtpPayload,
  CustomerOtpScope,
} from '../../src/modules/customer-otp/contracts.js';
import {
  customerOtpBudgets as budgets,
  customerOtpChallenges as challenges,
  customerOtpDeliveries as deliveries,
  customerOtpOperations as operations,
} from '../../src/modules/customer-otp/schema.js';
import { customerContactFixture } from '../customer-contacts/mysql-fixture.js';

const template = process.env.CUSTOMER_OTP_MYSQL_TEST_URL;
const secret = 'synthetic-purpose-bound-customer-otp-secret-'.repeat(2);
const options = readCustomerOtpOptions({
  CUSTOMER_OTP_ENABLED: 'true',
  CUSTOMER_OTP_CONTRACT: 'pos-customer-otp-v1',
  CUSTOMER_OTP_SECRET: secret,
  CUSTOMER_OTP_WORKER_ENABLED: 'true',
});
const actor: Principal = {
  id: '1',
  role: 1,
  userType: 1,
  name: 'Synthetic operator',
  email: 'operator.fixture@example.test',
  storeIds: ['1'],
};
describe.skipIf(!template)('customer OTP proofs on real isolated MySQL', () => {
  let native: Awaited<ReturnType<typeof customerContactFixture>>;
  let state: CheckoutState,
    scope: CustomerOtpScope,
    contact: CustomerContactBinding,
    challengeId: string,
    now: number;
  let service: ReturnType<typeof customerOtpService>, worker: ReturnType<typeof customerOtpOutbox>;
  let status: 'accepted' | 'uncertain' = 'accepted';
  const sent: CustomerOtpPayload[] = [],
    events: CustomerOtpWorkerEvent[] = [];
  const sender: CustomerOtpDelivery = {
    assertReady: () => undefined,
    async send(_id, payload) {
      sent.push(payload);
      return status;
    },
  };
  async function migrate(path: string) {
    for (const statement of readFileSync(path, 'utf8')
      .replace(/^--.*$/gm, '')
      .split(';')
      .filter((value) => value.trim()))
      await native.connection.query(statement);
  }
  async function binding() {
    return native.db.get('writer').transaction((tx) => readCustomerContactBinding(tx, '7'));
  }
  async function saveState() {
    await native.db
      .get('writer')
      .update(checkoutSessions)
      .set({ state, version: state.version })
      .where(eq(checkoutSessions.id, state.id));
  }
  async function checkpoint(id: string) {
    challengeId = id;
    contact = await binding();
    state.verificationChallenge = {
      id,
      contact,
      expiresAt: now + 300000,
      lastSentAt: now,
      attempts: 0,
      sent: false,
    };
    await saveState();
  }
  async function request(id = challengeId, operationId = randomUUID()) {
    return service.request(actor, scope, id, operationId, contact);
  }
  async function drainAll() {
    for (let index = 0; index < 4; index++) await worker.drain(new AbortController().signal, 10);
  }
  async function returnProof() {
    const subjectId = randomUUID(),
      id = randomUUID();
    const bound: CustomerOtpScope = { ...scope, purpose: 'order-return', subjectId, orderId: '77' };
    await native.db
      .get('writer')
      .insert(returnVerifications)
      .values({
        id: subjectId,
        state: {
          id: subjectId,
          operatorId: '1',
          storeId: '1',
          counterId: '1',
          customerId: '7',
          orderId: '77',
          requestHash: 'a'.repeat(64),
          sent: false,
          expiresAt: now + 300000,
          verifiedUntil: null,
          busyOperationId: null,
          otpChallengeId: id,
          contact,
        },
      });
    return { scope: bound, id };
  }
  beforeAll(async () => {
    native = await customerContactFixture(
      template!,
      ['users', 'pos_user', 'stores', 'store_counters', 'user_stores'],
      'pos_rewrite_customer_otp_test',
    );
    for (const path of [
      'src/modules/administration/migration.sql',
      'src/modules/checkout/migrations/0002_checkout.sql',
      'src/modules/checkout/migrations/0004_returns.sql',
      'src/modules/checkout/migrations/0008_checkout_draft_binding.sql',
      'src/modules/customer-otp/migration.sql',
    ])
      await migrate(path);
  });
  beforeEach(async () => {
    const [tables] = await native.connection.query<RowDataPacket[]>('SHOW TABLES');
    for (const table of tables)
      await native.connection.query('DELETE FROM `' + String(Object.values(table)[0]) + '`');
    // Budget-window assertions must not accidentally cross a business date.
    // The check-in service deliberately keeps its independent real authority clock.
    now = Date.parse('2026-06-15T12:00:00+05:30');
    status = 'accepted';
    sent.length = 0;
    events.length = 0;
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
    await native.db
      .get('writer')
      .insert(checkoutSessions)
      .values({ id: state.id, operatorId: '1', storeId: '1', version: state.version, state });
    service = customerOtpService(native.config, native.db, options, sender, () => now);
    worker = customerOtpOutbox(
      native.config,
      native.db,
      options,
      sender,
      () => now,
      (event) => events.push(event),
    );
  });
  afterAll(async () => {
    await native?.close();
  });

  it('queues one bound dual-channel code across20 exact requests/workers and never extends its verified expiry', async () => {
    const operationId = randomUUID();
    const replies = await Promise.all(
      Array.from({ length: 20 }, () => request(challengeId, operationId)),
    );
    expect(replies.every((value) => value.id === challengeId && value.status === 'pending')).toBe(
      true,
    );
    expect(await native.db.get('writer').select().from(challenges)).toHaveLength(1);
    expect(await native.db.get('writer').select().from(deliveries)).toHaveLength(2);
    const [budget] = await native.db
      .get('writer')
      .select()
      .from(budgets)
      .where(eq(budgets.key, 'customer:7'));
    expect(budget?.sends).toBe(1);
    await Promise.all(
      Array.from({ length: 20 }, () => worker.drain(new AbortController().signal, 2)),
    );
    await drainAll();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.code).toMatch(/^\d{6}$/);
    expect(sent[0]?.code).toBe(sent[1]?.code);
    expect(new Set(sent.map((value) => value.channel))).toEqual(new Set(['sms', 'email']));
    expect((await request(challengeId, operationId)).status).toBe('sent');
    await expect(request(challengeId, randomUUID())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await service.readOperation(actor, scope, challengeId, operationId)).toMatchObject({
      kind: 'request',
      error: null,
      result: { id: challengeId, status: 'sent' },
    });
    const created = now,
      verifyOperation = randomUUID();
    now += 270000;
    const verified = await service.verify(
      actor,
      scope,
      challengeId,
      verifyOperation,
      sent[0]!.code,
    );
    expect(verified.verifiedUntil).toBe(created + 900000);
    now += 1000;
    expect(await service.verify(actor, scope, challengeId, verifyOperation, sent[0]!.code)).toEqual(
      verified,
    );
    expect(
      (await service.verify(actor, scope, challengeId, randomUUID(), '000000')).verifiedUntil,
    ).toBe(created + 900000);
    const [stored] = await native.db.get('writer').select().from(challenges);
    expect(stored?.codeHash).toBe('');
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({
        module: 'customer-otp',
        resource: 'customer-otp-delivery',
        userId: '1',
        challengeId,
      });
      expect(Object.keys(event).sort()).toEqual(
        [
          'challengeId',
          'deliveryId',
          'eventId',
          'eventInstanceId',
          'module',
          'requestId',
          'resource',
          'userId',
        ].sort(),
      );
    }
  });
  it('commits wrong-code budgets once per immutable intent and shares them across checkout/return scopes', async () => {
    await request();
    await drainAll();
    const wrong = sent[0]!.code === '000000' ? '999999' : '000000';
    const operationId = randomUUID();
    await expect(
      service.verify(actor, scope, challengeId, operationId, wrong),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_INVALID' });
    await expect(
      service.verify(actor, scope, challengeId, operationId, wrong),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_INVALID' });
    let [row] = await native.db.get('writer').select().from(challenges);
    expect(row?.attempts).toBe(1);
    expect(await service.readOperation(actor, scope, challengeId, operationId)).toMatchObject({
      kind: 'verify',
      error: 'CUSTOMER_OTP_INVALID',
      result: { verifiedUntil: null },
    });
    expect(await service.readOperation(actor, scope, challengeId, randomUUID())).toBeNull();
    for (let count = 0; count < 4; count++)
      await expect(
        service.verify(actor, scope, challengeId, randomUUID(), wrong),
      ).rejects.toBeInstanceOf(Error);
    [row] = await native.db.get('writer').select().from(challenges);
    expect(row).toMatchObject({ state: 'LOCKED', attempts: 5, codeHash: '' });
    now += 60001;
    const returned = await returnProof();
    await expect(
      service.request(actor, returned.scope, returned.id, randomUUID(), contact),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_ATTEMPT_LIMIT' });
    now += 300000;
    expect(
      (await service.request(actor, returned.scope, returned.id, randomUUID(), contact)).status,
    ).toBe('pending');
    const [budget] = await native.db
      .get('writer')
      .select()
      .from(budgets)
      .where(eq(budgets.key, 'customer:7'));
    expect(budget).toMatchObject({ sends: 2, failures: 5, windowFailures: 0 });
  });
  it('resets daily budgets at business midnight while retaining the shared attempt window and send cooldown', async () => {
    now = Date.parse('2026-06-15T23:59:30+05:30');
    await checkpoint(challengeId);
    await request();
    await drainAll();
    const wrong = sent[0]!.code === '000000' ? '999999' : '000000';
    await expect(
      service.verify(actor, scope, challengeId, randomUUID(), wrong),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_INVALID' });
    now += 31000;
    await expect(
      service.verify(actor, scope, challengeId, randomUUID(), wrong),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_INVALID' });
    const [atMidnight] = await native.db
      .get('writer')
      .select()
      .from(budgets)
      .where(eq(budgets.key, 'customer:7'));
    expect(atMidnight).toMatchObject({
      day: '2026-06-16',
      sends: 0,
      failures: 1,
      windowFailures: 2,
    });
    await checkpoint(randomUUID());
    const operationId = randomUUID();
    await expect(request(challengeId, operationId)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SEND_LIMIT',
    });
    now += 30000;
    expect((await request(challengeId, operationId)).status).toBe('pending');
    const [afterCooldown] = await native.db
      .get('writer')
      .select()
      .from(budgets)
      .where(eq(budgets.key, 'customer:7'));
    expect(afterCooldown).toMatchObject({
      day: '2026-06-16',
      sends: 1,
      failures: 1,
      windowFailures: 2,
    });
  });
  it('rejects wrong actor/purpose/subject/counter and will not consume a checkout code as return proof', async () => {
    await request();
    await drainAll();
    await expect(service.read({ ...actor, id: '2' }, scope, challengeId)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SCOPE_CHANGED',
    });
    await expect(
      service.read(actor, { ...scope, counterId: '2' }, challengeId),
    ).rejects.toMatchObject({ code: 'CHECK_IN_REQUIRED' });
    const returned = await returnProof();
    await expect(
      service.verify(actor, returned.scope, challengeId, randomUUID(), sent[0]!.code),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
    await expect(
      service.read(actor, { ...scope, subjectId: randomUUID() }, challengeId),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
  });
  it('never reissues unknown delivery and accepts only the legitimately arrived uncertain code', async () => {
    await native.connection.query('UPDATE users SET email=? WHERE id=7', ['9876543210@temp.id']);
    await checkpoint(challengeId);
    status = 'uncertain';
    await request();
    expect(await worker.drain(new AbortController().signal, 10)).toMatchObject({ uncertain: 1 });
    expect((await service.read(actor, scope, challengeId)).status).toBe('uncertain');
    await drainAll();
    expect(sent).toHaveLength(1);
    expect(
      (await service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code)).verifiedUntil,
    ).toBe(now + 900000);
  });
  it('freezes an expired sending lease without another HTTP call but preserves an arrived code', async () => {
    await native.connection.query('UPDATE users SET email=? WHERE id=7', ['9876543210@temp.id']);
    await checkpoint(challengeId);
    await request();
    const [job] = await native.db.get('writer').select().from(deliveries);
    const payload = openCustomerOtp(secret, job!.id, job!.encryptedPayload);
    await native.db
      .get('writer')
      .update(deliveries)
      .set({ state: 'SENDING', leaseToken: randomUUID(), leaseExpiresAt: now - 1 })
      .where(eq(deliveries.id, job!.id));
    expect(await worker.drain(new AbortController().signal, 10)).toMatchObject({ uncertain: 1 });
    expect(sent).toHaveLength(0);
    expect(
      (await service.verify(actor, scope, challengeId, randomUUID(), payload.code)).verifiedUntil,
    ).toBe(now + 900000);
  });
  it('fences a contact mutation and restoration permanently with the shared contact revision', async () => {
    await request();
    await drainAll();
    await native.db.get('writer').transaction(async (tx) => {
      await tx
        .select({ id: contactUsers.id })
        .from(contactUsers)
        .where(eq(contactUsers.id, 7n))
        .for('update');
      await tx
        .update(contactUsers)
        .set({ email: 'new.fixture@example.test' })
        .where(eq(contactUsers.id, 7n));
      await bumpCurrentContactRevision(tx, '7');
    });
    await expect(
      service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
    await native.connection.query('UPDATE users SET email=? WHERE id=7', [
      'otp.fixture@example.test',
    ]);
    await expect(
      service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
    await expect(service.read(actor, scope, challengeId)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SCOPE_CHANGED',
    });
  });
  it.each(['store', 'operator', 'disabled-customer'] as const)(
    'cancels queued delivery after current %s revocation',
    async (kind) => {
      await request();
      if (kind === 'store')
        await native.connection.query('UPDATE stores SET is_active=0 WHERE id=1');
      if (kind === 'operator')
        await native.connection.query('UPDATE pos_user SET is_active=0 WHERE id=1');
      if (kind === 'disabled-customer')
        await native.connection.query('UPDATE users SET is_disabled=1 WHERE id=7');
      await drainAll();
      expect(sent).toHaveLength(0);
      const jobs = await native.db.get('writer').select().from(deliveries);
      expect(jobs.every((job) => job.state === 'CANCELLED' && job.encryptedPayload === '')).toBe(
        true,
      );
    },
  );
  it('retains old-code invalidation when an operator credential is restored with a newer auth epoch', async () => {
    await request();
    await drainAll();
    await native.connection.query(
      "INSERT INTO pos_rewrite_operator_auth_epochs(operator_id,epoch) VALUES('1',1)",
    );
    await expect(
      service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
  });
  it('expires pending secrets without erasing receipts/budgets and never refreshes proof validity by replay', async () => {
    const operationId = randomUUID();
    await request(challengeId, operationId);
    now += 300001;
    expect(await pruneCustomerOtpProofs(native.db, now)).toEqual({ expired: 1 });
    expect((await service.read(actor, scope, challengeId)).status).toBe('rejected');
    expect((await request(challengeId, operationId)).status).toBe('rejected');
    await drainAll();
    expect(sent).toHaveLength(0);
    expect(await native.db.get('writer').select().from(operations)).toHaveLength(1);
    expect(await native.db.get('writer').select().from(budgets)).toHaveLength(3);
  });
  it('rolls back code, budget and receipts if a delivery obligation cannot commit', async () => {
    await native.connection.query(
      "CREATE TRIGGER otp_fixture_failure BEFORE INSERT ON pos_rewrite_customer_otp_deliveries FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Synthetic OTP failure'",
    );
    try {
      await expect(request()).rejects.toThrow();
    } finally {
      await native.connection.query('DROP TRIGGER otp_fixture_failure');
    }
    expect(await native.db.get('writer').select().from(challenges)).toHaveLength(0);
    expect(await native.db.get('writer').select().from(budgets)).toHaveLength(0);
    expect(await native.db.get('writer').select().from(operations)).toHaveLength(0);
    expect((await request()).status).toBe('pending');
  });
  it('supersedes a prior scope code, preserving shared send limits and rejecting the obsolete checkpoint', async () => {
    const old = challengeId;
    await request();
    now += 60001;
    await checkpoint(randomUUID());
    await request();
    await drainAll();
    expect(sent).toHaveLength(2);
    const [previous] = await native.db
      .get('writer')
      .select()
      .from(challenges)
      .where(eq(challenges.id, old));
    expect(previous).toMatchObject({ state: 'SUPERSEDED', codeHash: '', activeScopeHash: null });
    await expect(service.read(actor, scope, old)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SCOPE_CHANGED',
    });
  });
  it.each([false, true])(
    'delays optional WhatsApp fallback and cancels it after verification=%s',
    async (verified) => {
      const configured = { ...options, CUSTOMER_OTP_WHATSAPP_FALLBACK_ENABLED: true };
      service = customerOtpService(native.config, native.db, configured, sender, () => now);
      worker = customerOtpOutbox(native.config, native.db, configured, sender, () => now);
      await request();
      await drainAll();
      expect(sent).toHaveLength(2);
      expect(sent.some((payload) => payload.channel === 'whatsapp')).toBe(false);
      if (verified) await service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code);
      now += configured.CUSTOMER_OTP_WHATSAPP_DELAY_MS;
      await drainAll();
      expect(sent).toHaveLength(verified ? 2 : 3);
      const jobs = await native.db.get('writer').select().from(deliveries);
      expect(jobs.find((job) => job.channel === 'whatsapp')?.state).toBe(
        verified ? 'CANCELLED' : 'ACCEPTED',
      );
      const [budget] = await native.db
        .get('writer')
        .select()
        .from(budgets)
        .where(eq(budgets.key, 'customer:7'));
      expect(budget?.sends).toBe(1);
    },
  );
  it('honors the source employee mobile restriction and sends only to the real company email', async () => {
    await native.connection.query('UPDATE users SET email=? WHERE id=7', [
      'otp.fixture@thesouledstore.com',
    ]);
    await checkpoint(challengeId);
    await request();
    await drainAll();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: 'email',
      destination: 'otp.fixture@thesouledstore.com',
    });
  });
  it('keeps a late provider acknowledgement uncertain when another worker already fenced its expired lease', async () => {
    await native.connection.query('UPDATE users SET email=? WHERE id=7', ['9876543210@temp.id']);
    await checkpoint(challengeId);
    await request();
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed: CustomerOtpDelivery = {
      assertReady: () => undefined,
      async send(_id, payload) {
        sent.push(payload);
        started!();
        await gate;
        return 'accepted';
      },
    };
    const concurrent = customerOtpOutbox(native.config, native.db, options, delayed, () => now);
    const pending = concurrent.drain(new AbortController().signal, 1);
    try {
      await ready;
      now += options.CUSTOMER_OTP_LEASE_MS + 1;
      expect(await concurrent.drain(new AbortController().signal, 1)).toMatchObject({
        uncertain: 1,
      });
    } finally {
      release!();
    }
    expect(await pending).toMatchObject({ delivered: 0, uncertain: 1 });
    expect(sent).toHaveLength(1);
    expect((await service.read(actor, scope, challengeId)).status).toBe('uncertain');
    expect(
      (await service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code)).verifiedUntil,
    ).toBeGreaterThan(now);
  });
  it('reconciles a never-committed request as absent without guessing or creating a new receipt', async () => {
    const operationId = randomUUID();
    expect(await service.readOperation(actor, scope, challengeId, operationId)).toBeNull();
    expect(await native.db.get('writer').select().from(operations)).toHaveLength(0);
    expect(await native.db.get('writer').select().from(deliveries)).toHaveLength(0);
    await expect(
      service.readOperation({ ...actor, id: '2' }, scope, challengeId, operationId),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
  });
  it('asserts an existing proof atomically in the supplied writer transaction without sends or new operations', async () => {
    await request();
    await drainAll();
    const assert = (until: number) =>
      native.db
        .get('writer')
        .transaction((tx) => service.assertVerified(tx, actor, scope, challengeId, contact, until));
    await expect(assert(now + 900000)).rejects.toMatchObject({
      code: 'CUSTOMER_VERIFICATION_REQUIRED',
    });
    const proof = await service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code);
    const count = (await native.db.get('writer').select().from(operations)).length;
    await expect(assert(proof.verifiedUntil!)).resolves.toBeUndefined();
    await expect(assert(proof.verifiedUntil! + 1)).rejects.toMatchObject({
      code: 'CUSTOMER_VERIFICATION_REQUIRED',
    });
    now = proof.verifiedUntil!;
    await expect(assert(proof.verifiedUntil!)).rejects.toMatchObject({
      code: 'CUSTOMER_VERIFICATION_REQUIRED',
    });
    expect(await native.db.get('writer').select().from(operations)).toHaveLength(count);
    expect(sent).toHaveLength(2);
  });
  it('permits only reading/asserting an exact frozen order consent and never issues or verifies codes after order creation', async () => {
    const requestId = randomUUID();
    await request(challengeId, requestId);
    await drainAll();
    const proof = await service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code);
    state.phase = 'order-created';
    state.orderId = '77';
    state.verifiedCustomerUntil = proof.verifiedUntil;
    state.verifiedCustomerContact = contact;
    state.orderCustomerConsent = {
      v: 1,
      contract: 'pos-customer-contact-consent-v1',
      orderId: '77',
      customerId: '7',
      operatorId: '1',
      storeId: '1',
      counterId: '1',
      contact,
      expiresAt: proof.verifiedUntil!,
    };
    await saveState();
    expect((await service.read(actor, scope, challengeId)).verifiedUntil).toBe(proof.verifiedUntil);
    await expect(
      native.db
        .get('writer')
        .transaction((tx) =>
          service.assertVerified(tx, actor, scope, challengeId, contact, proof.verifiedUntil!),
        ),
    ).resolves.toBeUndefined();
    await expect(request(challengeId, requestId)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SCOPE_CHANGED',
    });
    await expect(
      service.verify(actor, scope, challengeId, randomUUID(), sent[0]!.code),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
    state.orderCustomerConsent = { ...state.orderCustomerConsent, orderId: '78' };
    await saveState();
    await expect(service.read(actor, scope, challengeId)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SCOPE_CHANGED',
    });
    state.orderCustomerConsent = {
      ...state.orderCustomerConsent,
      orderId: '77',
      expiresAt: proof.verifiedUntil! + 1000,
    };
    state.verifiedCustomerUntil = proof.verifiedUntil! + 1000;
    await saveState();
    await expect(service.read(actor, scope, challengeId)).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_SCOPE_CHANGED',
    });
  });
});
