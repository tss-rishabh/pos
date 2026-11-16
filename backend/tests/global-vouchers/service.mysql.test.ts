import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/domain/access.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import { readCustomerContactBinding } from '../../src/modules/checkout/customer-contact-authority.js';
import {
  giftCardIssuanceContract,
  giftCardIssuances,
  giftCardIssuanceHashSql,
} from '../../src/modules/checkout/gift-card-issuance.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { sourceGiftCardPin } from '../../src/modules/gift-card-batches/generation.js';
import { customerOtpService } from '../../src/modules/customer-otp/service.js';
import { customerOtpOutbox } from '../../src/modules/customer-otp/worker.js';
import { readCustomerOtpOptions } from '../../src/modules/customer-otp/options.js';
import type { CustomerOtpDelivery } from '../../src/modules/customer-otp/contracts.js';
import {
  exactVoucherValueContract,
  globalVoucherContract,
  nonExpiringVoucherContract,
  type VoucherReceipt,
} from '../../src/modules/global-vouchers/contracts.js';
import { globalVouchers } from '../../src/modules/global-vouchers/legacy-schema.js';
import { voucherPinBudgets } from '../../src/modules/global-vouchers/schema.js';
import { readGlobalVoucherOptions } from '../../src/modules/global-vouchers/options.js';
import { globalVoucherService } from '../../src/modules/global-vouchers/service.js';
import { globalVoucherFixture } from './mysql-fixture.js';

const template = process.env.GLOBAL_VOUCHERS_MYSQL_TEST_URL;
const actor: Principal = {
  id: '1',
  role: 1,
  userType: 1,
  name: 'Fixture operator',
  email: 'operator@example.test',
  storeIds: ['1'],
};
const options = readGlobalVoucherOptions({
  GLOBAL_VOUCHERS_ENABLED: 'true',
  GLOBAL_VOUCHERS_CONTRACT: globalVoucherContract,
  GLOBAL_VOUCHER_VALUE_CONTRACT: exactVoucherValueContract,
  GLOBAL_VOUCHER_LEGACY_CONTRACT: nonExpiringVoucherContract,
  GLOBAL_BENEFIT_WALLET_LOCK_CONTRACT: 'pos-wallet-user-lock-v1',
  GLOBAL_VOUCHER_SECRET: 'synthetic-voucher-test-secret-'.repeat(2),
  GLOBAL_VOUCHER_CONVERSION_ENABLED: 'true',
});
describe.skipIf(!template)('atomic global vouchers on verified isolated MySQL', () => {
  let native: Awaited<ReturnType<typeof globalVoucherFixture>>;
  let service: ReturnType<typeof globalVoucherService>, state: CheckoutState;
  const now = Date.parse('2026-06-15T12:00:00+05:30');
  const assertVerified = vi.fn(async () => undefined);
  beforeAll(async () => {
    native = await globalVoucherFixture(template!);
    await native.applyLegacyCandidate();
  });
  afterAll(async () => native?.close());
  beforeEach(async () => {
    const [tables] = await native.connection.query<RowDataPacket[]>('SHOW TABLES');
    for (const table of tables)
      await native.connection.query('DELETE FROM `' + String(Object.values(table)[0]) + '`');
    assertVerified.mockClear();
    await native.fixture.insert('pos_user', {
      id: '1',
      username: 'fixture-operator',
      is_active: 1,
      role: 1,
      user_type: 1,
    });
    await native.fixture.insert('users', {
      id: '7',
      firstname: 'Fixture',
      lastname: 'Customer',
      email: 'fixture@example.test',
      telephone: '9876543210',
      user_type: '2',
      status: 1,
      is_block: 0,
      is_disabled: 0,
      tss_money: 100,
      cashback: 7,
    });
    await native.fixture.insert('stores', {
      id: '1',
      store_name: 'Fixture store',
      is_active: 1,
      type: 'STORE',
      category: 'IN_HOUSE',
    });
    await native.fixture.insert('store_counters', {
      id: '1',
      counter_name: 'Fixture counter',
      store_id: '1',
      is_active: 1,
    });
    await checkInService(native.db, native.config).set(actor, '1', '1');
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
      phase: 'quoted',
      version: 1,
      verifiedCustomerUntil: now + 900000,
      verifiedCustomerContact: contact,
      verificationChallenge: {
        id: randomUUID(),
        contact,
        expiresAt: now + 300000,
        attempts: 0,
        sent: true,
        lastSentAt: now,
      },
      cart: { products: { items: [{ prod_id: '12', quantity: 1 }] }, meta: { items: [] } },
      quote: { total: 200 },
      orderId: null,
      paymentConfirmation: null,
      salespersonId: '3',
      lineSalespersons: { '12': '3' },
      giftCards: {},
      busyOperationId: null,
      createdAt: now,
      updatedAt: now,
    });
    await native.db
      .get('writer')
      .insert(checkoutSessions)
      .values({ id: state.id, operatorId: actor.id, storeId: '1', version: 1, state });
    service = globalVoucherService(
      native.config,
      native.db,
      options,
      { customerOtp: { assertVerified } },
      () => now,
    );
  });
  const lookup = () => service.lookup(actor, { email: 'fixture@example.test' });
  async function issue(amount = '25.49') {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount };
    return { input, result: await service.issue(actor, input) };
  }
  async function counts() {
    const [rows] = await native.connection.query<RowDataPacket[]>(
      'SELECT (SELECT COUNT(*) FROM coupons) coupons,(SELECT COUNT(*) FROM gift_vouchers) vouchers,(SELECT COUNT(*) FROM gift_voucher_history) histories,(SELECT COUNT(*) FROM tss_money_history) money,(SELECT COUNT(*) FROM reward_point_history) rewards',
    );
    return z
      .object({
        coupons: z.coerce.number().int(),
        vouchers: z.coerce.number().int(),
        histories: z.coerce.number().int(),
        money: z.coerce.number().int(),
        rewards: z.coerce.number().int(),
      })
      .parse(rows[0]);
  }
  async function wallet() {
    const [rows] = await native.connection.query<RowDataPacket[]>(
      'SELECT CAST(tss_money AS CHAR) money,CAST(cashback AS CHAR) cashback FROM users WHERE id=7',
    );
    return rows[0];
  }
  function conversion(receipt: VoucherReceipt, extra: Record<string, unknown> = {}) {
    return {
      operationId: randomUUID(),
      expectedVersion: state.version,
      voucherCode: receipt.voucherCode,
      ...extra,
    };
  }
  async function saveState() {
    await native.db
      .get('writer')
      .update(checkoutSessions)
      .set({ state, version: state.version })
      .where(eq(checkoutSessions.id, state.id));
  }
  async function fundCard(result: VoucherReceipt, requiresPin = false) {
    const id = BigInt(result.voucherId),
      serial = 999901111n;
    await native.fixture.insert('gift_card_collection', {
      id: '1',
      size: 1,
      is_block: 1,
      is_printed: 1,
      is_completed: 1,
    });
    await native.db
      .get('writer')
      .update(globalVouchers)
      .set({
        kind: 'GIFT_CARD',
        collectionId: 1n,
        serial,
        orderId: 77n,
        requiresPin: requiresPin ? 1 : 0,
        startsAt: '2026-01-01 00:00:00',
        expiresAt: '2027-01-01 00:00:00',
      })
      .where(eq(globalVouchers.id, id));
    const [card] = await native.db
      .get('writer')
      .select({ hash: sql<string>`${sql.raw(giftCardIssuanceHashSql)}` })
      .from(globalVouchers)
      .where(eq(globalVouchers.id, id));
    await native.db.get('writer').insert(giftCardIssuances).values({
      voucherId: id,
      orderId: 77n,
      collectionId: 1n,
      serial,
      inputHash: card!.hash,
      contract: giftCardIssuanceContract,
      activatedAt: '2026-06-15 12:00:00',
    });
    return sourceGiftCardPin(String(serial));
  }
  it('fences an uncommitted operation permanently without cancelling an already committed voucher', async () => {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount: '100' };
    expect(
      await service.cancel(actor, input.operationId, {
        kind: 'issuance',
        selectionId: selection.selectionId,
      }),
    ).toMatchObject({ status: 'cancelled' });
    await expect(service.issue(actor, input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await counts()).toMatchObject({ coupons: 0, vouchers: 0 });
    const { input: committed, result } = await issue('100');
    expect(
      await service.cancel(actor, committed.operationId, {
        kind: 'issuance',
        selectionId: committed.selectionId,
      }),
    ).toMatchObject({ status: 'succeeded', receipt: result });
    expect(await counts()).toMatchObject({ coupons: 1, vouchers: 1 });
  });
  it('serializes cancellation against concurrent financial dispatch with either zero or exactly one issuance', async () => {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount: '100' };
    const [sent, stopped] = await Promise.allSettled([
      service.issue(actor, input),
      service.cancel(actor, input.operationId, {
        kind: 'issuance',
        selectionId: input.selectionId,
      }),
    ]);
    expect(stopped.status).toBe('fulfilled');
    if (stopped.status !== 'fulfilled')
      throw new Error('Cancellation reconciliation did not complete.');
    const confirmed = stopped.value.status === 'succeeded';
    expect(await counts()).toMatchObject({
      coupons: confirmed ? 1 : 0,
      vouchers: confirmed ? 1 : 0,
    });
    expect(sent.status).toBe(confirmed ? 'fulfilled' : 'rejected');
  });
  it('records wrong PIN intents once, shares the voucher-wide limit, and permits no monetary writes', async () => {
    const { result } = await issue(),
      expected = await fundCard(result, true),
      wrong = expected === '000000' ? '999999' : '000000';
    const input = conversion(result, { giftCardPin: wrong });
    await expect(service.convert(actor, '1', state.id, input)).rejects.toMatchObject({
      code: 'GIFT_CARD_PIN_INVALID',
    });
    await expect(service.convert(actor, '1', state.id, input)).rejects.toMatchObject({
      code: 'GIFT_CARD_PIN_INVALID',
    });
    expect(await service.get(actor, input.operationId)).toMatchObject({
      status: 'rejected',
      errorCode: 'GIFT_CARD_PIN_INVALID',
      receipt: null,
    });
    for (let index = 0; index < 5; index++)
      await expect(
        service.convert(actor, '1', state.id, conversion(result, { giftCardPin: wrong })),
      ).rejects.toMatchObject({ code: 'GIFT_CARD_PIN_INVALID' });
    await expect(
      service.convert(actor, '1', state.id, conversion(result, { giftCardPin: expected })),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_PIN_LIMIT' });
    expect(await counts()).toMatchObject({ histories: 1, money: 0 });
    expect(await wallet()).toMatchObject({ money: '100', cashback: '7' });
  });
  it('consumes a valid PIN gift card and never extends the financial outcome on replay', async () => {
    const { result } = await issue(),
      expected = await fundCard(result, true),
      input = conversion(result, { giftCardPin: expected });
    const receipt = await service.convert(actor, '1', state.id, input);
    expect(await service.convert(actor, '1', state.id, input)).toEqual(receipt);
    expect(await counts()).toMatchObject({ histories: 2, money: 1, rewards: 0 });
  });
  it('checks an actual durable customer OTP proof inside the same native financial transaction', async () => {
    const { result } = await issue(),
      codes: string[] = [];
    const otpOptions = readCustomerOtpOptions({
      CUSTOMER_OTP_ENABLED: 'true',
      CUSTOMER_OTP_WORKER_ENABLED: 'true',
      CUSTOMER_OTP_CONTRACT: 'pos-customer-otp-v1',
      CUSTOMER_OTP_SECRET: 'synthetic-voucher-real-proof-secret-'.repeat(2),
    });
    const sender: CustomerOtpDelivery = {
      assertReady: () => undefined,
      async send(_id, payload) {
        codes.push(payload.code);
        return 'accepted';
      },
    };
    const otp = customerOtpService(native.config, native.db, otpOptions, sender, () => now),
      worker = customerOtpOutbox(native.config, native.db, otpOptions, sender, () => now),
      scope = {
        operatorId: '1',
        storeId: '1',
        counterId: '1',
        customerId: '7',
        purpose: 'checkout-benefits' as const,
        subjectId: state.id,
        orderId: null,
      },
      contact = await native.db
        .get('writer')
        .transaction((tx) => readCustomerContactBinding(tx, '7'));
    await otp.request(actor, scope, state.verificationChallenge!.id, randomUUID(), contact);
    for (let index = 0; index < 4; index++) await worker.drain(new AbortController().signal, 10);
    await otp.verify(actor, scope, state.verificationChallenge!.id, randomUUID(), codes[0]!);
    const backed = globalVoucherService(
      native.config,
      native.db,
      options,
      { customerOtp: otp },
      () => now,
    );
    expect((await backed.convert(actor, '1', state.id, conversion(result))).walletAfter).toBe(
      '125.49',
    );
    expect(assertVerified).not.toHaveBeenCalled();
  });
  it('serializes 20 same customer lookups without a shared-lock upgrade deadlock', async () => {
    const selections = await Promise.all(Array.from({ length: 20 }, () => lookup()));
    expect(new Set(selections.map((item) => item.selectionId)).size).toBe(20);
    expect(selections.every((item) => item.customerId === '7')).toBe(true);
    expect(await counts()).toMatchObject({ coupons: 0, vouchers: 0 });
  });
  it('shares six durable wrong PIN intents across concurrent operators and their independent checkouts', async () => {
    const { result } = await issue(),
      expected = await fundCard(result, true),
      wrong = expected === '000000' ? '999999' : '000000';
    const other: Principal = { ...actor, id: '2', role: 5 };
    await native.fixture.insert('pos_user', {
      id: '2',
      username: 'second-fixture',
      role: 5,
      user_type: 1,
      is_active: 1,
    });
    await native.fixture.insert('user_stores', { django_user_id: '2', store_id: '1' });
    await checkInService(native.db, native.config).set(other, '1', '1');
    const second = checkoutStateSchema.parse({
      ...state,
      id: randomUUID(),
      operatorId: '2',
      operatorCustomerId: '89',
    });
    await native.db
      .get('writer')
      .insert(checkoutSessions)
      .values({ id: second.id, operatorId: '2', storeId: '1', version: 1, state: second });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_item, index) =>
        service.convert(
          index % 2 ? other : actor,
          '1',
          index % 2 ? second.id : state.id,
          conversion(result, { giftCardPin: wrong }),
        ),
      ),
    );
    const codes = outcomes.map((outcome) => {
      expect(outcome.status).toBe('rejected');
      if (outcome.status !== 'rejected') return '';
      const failure: unknown = outcome.reason;
      return z.object({ code: z.string() }).parse(failure).code;
    });
    expect(codes.filter((code) => code === 'GIFT_CARD_PIN_INVALID')).toHaveLength(6);
    expect(codes.filter((code) => code === 'GIFT_CARD_PIN_LIMIT')).toHaveLength(6);
    const [budget] = await native.db.get('writer').select().from(voucherPinBudgets);
    expect(budget?.failures).toBe(6);
    expect(await counts()).toMatchObject({ money: 0, histories: 1 });
  });
  it('refreshes the source 86400-second TTL for each new wrong intent, while exact replay cannot extend it', async () => {
    let time = now;
    const { result } = await issue(),
      expected = await fundCard(result, true),
      wrong = expected === '000000' ? '999999' : '000000';
    const backing = globalVoucherService(
      native.config,
      native.db,
      options,
      { customerOtp: { assertVerified } },
      () => time,
    );
    const first = conversion(result, { giftCardPin: wrong });
    async function attempt(input = conversion(result, { giftCardPin: wrong })) {
      // The injected proof authority isolates this native test to the PIN budget;
      // the separate real-OTP case proves production proof validation/locking.
      state.verifiedCustomerUntil = time + 900000;
      await saveState();
      await expect(backing.convert(actor, '1', state.id, input)).rejects.toMatchObject({
        code: 'GIFT_CARD_PIN_INVALID',
      });
    }
    await attempt(first);
    time += 1800000;
    await attempt(first);
    let [budget] = await native.db.get('writer').select().from(voucherPinBudgets);
    expect(budget).toMatchObject({ failures: 1, windowStartedAt: now });
    await attempt();
    [budget] = await native.db.get('writer').select().from(voucherPinBudgets);
    expect(budget).toMatchObject({ failures: 2, windowStartedAt: time });
    time = now + 86400000;
    await attempt();
    [budget] = await native.db.get('writer').select().from(voucherPinBudgets);
    expect(budget).toMatchObject({ failures: 3, windowStartedAt: time });
    time += 86400000;
    await attempt();
    [budget] = await native.db.get('writer').select().from(voucherPinBudgets);
    expect(budget).toMatchObject({ failures: 1, windowStartedAt: time });
    expect(await counts()).toMatchObject({ money: 0 });
  });
  it('races a correct PIN against a wrong intent without double credit or reviving the consumed value', async () => {
    const { result } = await issue(),
      expected = await fundCard(result, true),
      wrong = expected === '000000' ? '999999' : '000000';
    const good = conversion(result, { giftCardPin: expected });
    const [accepted, rejected] = await Promise.allSettled([
      service.convert(actor, '1', state.id, good),
      service.convert(actor, '1', state.id, conversion(result, { giftCardPin: wrong })),
    ]);
    expect(accepted.status).toBe('fulfilled');
    expect(rejected.status).toBe('rejected');
    if (accepted.status !== 'fulfilled') throw new Error('The correct PIN did not settle.');
    expect(await service.convert(actor, '1', state.id, good)).toEqual(accepted.value);
    expect(await counts()).toMatchObject({ histories: 2, money: 1, rewards: 0 });
    expect(await wallet()).toMatchObject({ money: '125.49', cashback: '7' });
  });

  it('stores exact ordinary value with complete strict fields, legacy zero-date display contract and bigint audit IDs', async () => {
    await native.connection.query('ALTER TABLE gift_vouchers AUTO_INCREMENT=9007199254740993');
    await native.connection.query(
      'ALTER TABLE gift_voucher_history AUTO_INCREMENT=9007199254740993',
    );
    const { result } = await issue();
    expect(BigInt(result.voucherId)).toBeGreaterThan(9007199254740992n);
    expect(BigInt(result.voucherHistoryId)).toBeGreaterThan(9007199254740992n);
    expect(result).toMatchObject({
      amount: '25.49',
      nonExpiring: true,
      kind: 'issuance',
      status: 'success',
    });
    const [rows] = await native.connection.query<RowDataPacket[]>(
      'SELECT c.voucher_val shadow,c.initial_val initial,g.voucher_value value,g.start_date starts,g.end_date ends,g.platform platform,h.platform historyPlatform FROM coupons c JOIN gift_vouchers g ON g.coupon_id=c.id JOIN gift_voucher_history h ON h.gv_id=g.id',
    );
    expect(rows[0]).toMatchObject({
      shadow: 25,
      initial: 25.49,
      value: 25.49,
      starts: null,
      ends: null,
      platform: 'both',
      historyPlatform: 'GV_ADD',
    });
    expect(await wallet()).toMatchObject({ money: '100', cashback: '7' });
  });
  it('executes the source INT-to-DOUBLE copy on real strict MySQL and demonstrates the exact-value correction', async () => {
    const rows = [];
    for (const input of ['100', '25.50', '25.49', '0.01']) {
      await native.fixture.insert('coupons', {
        user_id: '7',
        voucher_code: 'SYNTHETIC' + input.replace('.', ''),
        voucher_val: input,
        initial_val: input,
      });
      const [stored] = await native.connection.query<RowDataPacket[]>(
        'SELECT voucher_val,initial_val FROM coupons WHERE id=LAST_INSERT_ID()',
      );
      rows.push({ input, stored: stored[0]?.voucher_val, history: stored[0]?.initial_val });
    }
    expect(rows).toEqual([
      { input: '100', stored: 100, history: 100 },
      { input: '25.50', stored: 26, history: 25.5 },
      { input: '25.49', stored: 25, history: 25.49 },
      { input: '0.01', stored: 0, history: 0.01 },
    ]);
    expect((await issue('0.01')).result.amount).toBe('0.01');
    const [actual] = await native.db
      .get('writer')
      .select({ value: globalVouchers.value })
      .from(globalVouchers);
    expect(actual?.value).toBe(0.01);
  });
  it('replays20 concurrent same commands once and preserves the original response after customer contact changes', async () => {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount: '100' };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.issue(actor, input)),
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(
      true,
    );
    expect(await counts()).toMatchObject({ coupons: 1, vouchers: 1, histories: 1 });
    await native.connection.query("UPDATE users SET email='changed@example.test' WHERE id=7");
    expect(await service.get(actor, input.operationId)).toMatchObject({
      status: 'succeeded',
      receipt: results[0],
    });
  });
  it('prevents two new operation IDs consuming the same selection and rejects changed immutable requests', async () => {
    const { input } = await issue('100');
    await expect(service.issue(actor, { ...input, amount: '101' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(
      service.issue(actor, { ...input, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'GLOBAL_VOUCHER_SCOPE_CHANGED' });
    expect(await counts()).toMatchObject({ coupons: 1, histories: 1 });
  });
  it('rechecks role/type/active/customer contact and cancels a stale selection without partial issuance', async () => {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount: '100' };
    await native.connection.query('UPDATE pos_user SET user_type=2 WHERE id=1');
    await expect(service.issue(actor, input)).rejects.toMatchObject({
      code: 'GLOBAL_VOUCHER_ACCESS_DENIED',
    });
    await native.connection.query('UPDATE pos_user SET user_type=1 WHERE id=1');
    await native.connection.query("UPDATE users SET telephone='9876543211' WHERE id=7");
    await expect(service.issue(actor, input)).rejects.toMatchObject({
      code: 'GLOBAL_VOUCHER_SCOPE_CHANGED',
    });
    expect(await counts()).toMatchObject({ coupons: 0, vouchers: 0, histories: 0 });
  });
  it('uses approved exact paise by default while retaining generic coupon INT semantics', async () => {
    const defaultValues = readGlobalVoucherOptions({}).GLOBAL_VOUCHER_VALUE_CONTRACT;
    expect(defaultValues).toBe(exactVoucherValueContract);
    const approved = globalVoucherService(
      native.config,
      native.db,
      { ...options, GLOBAL_VOUCHER_VALUE_CONTRACT: defaultValues },
      {},
      () => now,
    );
    const selection = await lookup();
    expect(
      (
        await approved.issue(actor, {
          operationId: randomUUID(),
          selectionId: selection.selectionId,
          amount: '0.01',
        })
      ).amount,
    ).toBe('0.01');
    const second = await lookup();
    expect(
      (
        await approved.issue(actor, {
          operationId: randomUUID(),
          selectionId: second.selectionId,
          amount: '100',
        })
      ).amount,
    ).toBe('100.00');
  });
  it('consumes a voucher and credits Money once without touching cashback/reward history, then invalidates the quote', async () => {
    const { result } = await issue(),
      input = conversion(result);
    const receipts = await Promise.all(
      Array.from({ length: 20 }, () => service.convert(actor, '1', state.id, input)),
    );
    expect(
      receipts.every((receipt) => JSON.stringify(receipt) === JSON.stringify(receipts[0])),
    ).toBe(true);
    expect(receipts[0]).toMatchObject({
      amount: '25.49',
      walletBefore: '100.00',
      walletAfter: '125.49',
      checkoutVersion: 2,
    });
    expect(await counts()).toMatchObject({ histories: 2, money: 1, rewards: 0 });
    expect(await wallet()).toMatchObject({ money: '125.49', cashback: '7' });
    const [saved] = await native.db
      .get('writer')
      .select()
      .from(checkoutSessions)
      .where(eq(checkoutSessions.id, state.id));
    expect(saved?.state).toMatchObject({
      quote: null,
      phase: 'open',
      version: 2,
      cart: state.cart,
      salespersonId: '3',
      lineSalespersons: { '12': '3' },
      verifiedCustomerUntil: state.verifiedCustomerUntil,
    });
    expect(assertVerified).toHaveBeenCalledTimes(1);
    await expect(
      service.convert(actor, '1', state.id, {
        ...input,
        operationId: randomUUID(),
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'VOUCHER_VALUE_REPAIR_REQUIRED' });
  });
  it('requires current proof/contact and rejects applied or malformed meta before value writes', async () => {
    const { result } = await issue(),
      input = conversion(result);
    state.cart = { ...state.cart!, meta: { items: [{ name: 'gift_voucher', voucher_value: 0 }] } };
    await saveState();
    await expect(service.convert(actor, '1', state.id, input)).rejects.toMatchObject({
      code: 'VOUCHER_ALREADY_APPLIED',
    });
    state.cart = { products: { items: [] } };
    await saveState();
    await expect(service.convert(actor, '1', state.id, input)).rejects.toMatchObject({
      code: 'VOUCHER_CART_REFRESH_REQUIRED',
    });
    state.cart = { products: { items: [] }, meta: { items: [] } };
    state.verifiedCustomerUntil = null;
    await saveState();
    await expect(service.convert(actor, '1', state.id, input)).rejects.toMatchObject({
      code: 'CUSTOMER_VERIFICATION_REQUIRED',
    });
    expect(await counts()).toMatchObject({ histories: 1, money: 0 });
  });
  it('rolls back coupon/voucher/history atomically if a later physical write fails', async () => {
    await native.connection.query(
      "CREATE TRIGGER fixture_audit_failure BEFORE INSERT ON pos_special_permission_activity_log FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic failure'",
    );
    try {
      await expect(issue()).rejects.toBeInstanceOf(Error);
      expect(await counts()).toMatchObject({ coupons: 0, vouchers: 0, histories: 0 });
    } finally {
      await native.connection.query('DROP TRIGGER fixture_audit_failure');
    }
  });
  it('fails closed on corrupt saved evidence instead of inventing a successful receipt or issuing again', async () => {
    const { input } = await issue();
    await native.connection.query('DELETE FROM gift_voucher_history');
    await expect(service.get(actor, input.operationId)).rejects.toMatchObject({
      code: 'VOUCHER_OPERATION_UNCONFIRMED',
    });
    await expect(service.issue(actor, input)).rejects.toMatchObject({
      code: 'VOUCHER_OPERATION_UNCONFIRMED',
    });
    expect(await counts()).toMatchObject({ coupons: 1, vouchers: 1, histories: 0 });
  });
  it('requires verifiable gift-card funding then consumes a funded no-PIN card even if its batch was later blocked', async () => {
    const { result } = await issue(),
      id = BigInt(result.voucherId),
      serial = 999901111n;
    await native.fixture.insert('gift_card_collection', {
      id: '1',
      size: 1,
      is_block: 1,
      is_printed: 1,
      is_completed: 1,
    });
    await native.db
      .get('writer')
      .update(globalVouchers)
      .set({
        kind: 'GIFT_CARD',
        collectionId: 1n,
        serial,
        orderId: 77n,
        startsAt: '2026-01-01 00:00:00',
        expiresAt: '2027-01-01 00:00:00',
      })
      .where(eq(globalVouchers.id, id));
    const input = conversion(result);
    await expect(service.convert(actor, '1', state.id, input)).rejects.toMatchObject({
      code: 'GIFT_CARD_FUNDING_UNCONFIRMED',
    });
    const [card] = await native.db
      .get('writer')
      .select({ hash: sql<string>`${sql.raw(giftCardIssuanceHashSql)}` })
      .from(globalVouchers)
      .where(eq(globalVouchers.id, id));
    await native.db.get('writer').insert(giftCardIssuances).values({
      voucherId: id,
      orderId: 77n,
      collectionId: 1n,
      serial,
      inputHash: card!.hash,
      contract: giftCardIssuanceContract,
      activatedAt: '2026-06-15 12:00:00',
    });
    const receipt = await service.convert(actor, '1', state.id, input);
    expect(receipt.amount).toBe('25.49');
    const [stored] = await native.db
      .get('writer')
      .select()
      .from(globalVouchers)
      .where(eq(globalVouchers.id, id));
    expect(stored).toMatchObject({ value: 0, status: 0 });
  });
  it('does not expose another actor receipt and does not put PII in the special-permission audit', async () => {
    const { input } = await issue();
    await expect(service.get({ ...actor, id: '2' }, input.operationId)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    const [rows] = await native.connection.query<RowDataPacket[]>(
      'SELECT comment,recipient FROM pos_special_permission_activity_log',
    );
    expect(rows[0]?.recipient).toBe('7');
    expect(String(rows[0]?.comment)).not.toContain('@');
    expect(String(rows[0]?.comment)).not.toContain('Fixture');
  });
});
