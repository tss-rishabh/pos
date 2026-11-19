import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Principal } from '../../src/domain/access.js';
import { checkoutStateSchema, type CheckoutState } from '../../src/modules/checkout/contracts.js';
import {
  checkoutSessionStore,
  type CheckoutSessionStore,
} from '../../src/modules/checkout/session-store.js';
import { memoryStateStore, type PosStateStore } from '../../src/modules/checkout/state-store.js';
import { globalVoucherService } from '../../src/modules/global-vouchers/service.js';
import type {
  VoucherUpstream,
  VoucherUpstreamReply,
} from '../../src/modules/global-vouchers/upstream.js';
import { injectWriteFailure } from '../helpers/production-schema.js';
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
describe.skipIf(!template)('global vouchers on verified isolated MySQL and Redis state', () => {
  let native: Awaited<ReturnType<typeof globalVoucherFixture>>;
  let service: ReturnType<typeof globalVoucherService>,
    state: CheckoutState,
    store: PosStateStore,
    sessions: CheckoutSessionStore,
    replies: (VoucherUpstreamReply | Error)[];
  const now = Date.parse('2026-06-15T12:00:00+05:30');
  const calls: { segment: string; payload: unknown; authorization: string }[] = [];
  const upstream: VoucherUpstream = {
    call: vi.fn(async (segment, payload, authorization) => {
      calls.push({ segment, payload, authorization });
      const next = replies.shift();
      if (!next) throw new Error('No fixture reply');
      if (next instanceof Error) throw next;
      return next;
    }),
  };
  function build(flag: number) {
    return globalVoucherService(
      { ...native.config, ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT: flag },
      native.db,
      {},
      {
        stateStore: store,
        sessions,
        upstream,
        assertCheckIn: async () => undefined,
        tokenKeys: { hs256: 'synthetic-checkout-signing-key-'.repeat(2) },
      },
      () => now,
    );
  }
  beforeAll(async () => {
    native = await globalVoucherFixture(template!);
  });
  afterAll(async () => native?.close());
  beforeEach(async () => {
    const [tables] = await native.connection.query<RowDataPacket[]>('SHOW TABLES');
    for (const table of tables)
      await native.connection.query('DELETE FROM `' + String(Object.values(table)[0]) + '`');
    calls.length = 0;
    replies = [];
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
    store = memoryStateStore(() => now);
    sessions = checkoutSessionStore(store, () => now);
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
    await sessions.write(state);
    service = build(1);
  });
  const lookup = () => service.lookup(actor, { email: 'fixture@example.test' });
  async function issue(amount = '25.49') {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount };
    return { input, result: await service.issue(actor, input) };
  }
  async function counts() {
    const [rows] = await native.connection.query<RowDataPacket[]>(
      'SELECT (SELECT COUNT(*) FROM coupons) coupons,(SELECT COUNT(*) FROM gift_vouchers) vouchers,(SELECT COUNT(*) FROM gift_voucher_history) histories,(SELECT COUNT(*) FROM pos_special_permission_activity_log) audits',
    );
    return z
      .object({
        coupons: z.coerce.number().int(),
        vouchers: z.coerce.number().int(),
        histories: z.coerce.number().int(),
        audits: z.coerce.number().int(),
      })
      .parse(rows[0]);
  }

  it('issues with the production-schema values legacy stores and replays from Redis', async () => {
    const { input, result } = await issue();
    expect(result).toMatchObject({
      kind: 'issuance',
      amount: '25.49',
      nonExpiring: true,
      message: `Gift Voucher ${result.voucherCode} Has been created for fixture@example.test and amount is 25.49`,
    });
    const [[voucher], [history], [coupon], [audit]] = await Promise.all(
      [
        'SELECT start_date,end_date,status,voucher_value FROM gift_vouchers',
        'SELECT platform,comment,added_user,added_amt FROM gift_voucher_history',
        'SELECT end_date,voucher_type FROM coupons',
        'SELECT platform,recipient,comment FROM pos_special_permission_activity_log',
      ].map(
        async (query) =>
          (await native.connection.query<RowDataPacket[]>(query))[0] as RowDataPacket[],
      ),
    );
    expect(voucher).toMatchObject({
      start_date: '0000-00-00 00:00:00',
      end_date: '0000-00-00 00:00:00',
      status: 1,
    });
    expect(history).toMatchObject({
      platform: '',
      comment: 'GV ADD: Gift Voucher Amount Added',
      added_user: '0',
    });
    expect(coupon).toMatchObject({ end_date: '0000-00-00 00:00:00' });
    expect(audit).toMatchObject({
      platform: 'Gift Voucher',
      recipient: 'fixture@example.test',
      comment: result.message,
    });
    expect(await service.issue(actor, input)).toEqual(result);
    expect(await service.get(actor, input.operationId)).toEqual({
      status: 'succeeded',
      receipt: result,
    });
    await expect(service.issue(actor, { ...input, amount: '30' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(
      service.issue(actor, { ...input, operationId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'GLOBAL_VOUCHER_SCOPE_CHANGED' });
    expect(await counts()).toEqual({ coupons: 1, vouchers: 1, histories: 1, audits: 1 });
    await expect(service.get({ ...actor, id: '2' }, input.operationId)).rejects.toMatchObject({
      code: 'GLOBAL_VOUCHER_OPERATION_NOT_FOUND',
    });
  });
  it('rolls back a failed issuance, releases the claim and selection, and permits the exact retry', async () => {
    const selection = await lookup(),
      input = { operationId: randomUUID(), selectionId: selection.selectionId, amount: '10' };
    const restore = await injectWriteFailure(native.connection, {
      table: 'pos_special_permission_activity_log',
      event: 'INSERT',
      message: 'isolated audit failure',
    });
    try {
      await expect(service.issue(actor, input)).rejects.toThrow();
    } finally {
      await restore();
    }
    expect(await counts()).toEqual({ coupons: 0, vouchers: 0, histories: 0, audits: 0 });
    expect((await service.issue(actor, input)).amount).toBe('10.00');
  });
  it('fences a cancelled operation and refuses unknown or franchise issuers', async () => {
    const selection = await lookup(),
      operationId = randomUUID();
    expect(
      await service.cancel(actor, operationId, {
        kind: 'issuance',
        selectionId: selection.selectionId,
      }),
    ).toEqual({ status: 'cancelled', receipt: null });
    await expect(
      service.issue(actor, { operationId, selectionId: selection.selectionId, amount: '5' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.lookup(actor, { email: 'missing@example.test' })).rejects.toMatchObject({
      status: 404,
      message: 'User Does not exists',
    });
    await native.connection.query('UPDATE pos_user SET user_type=2 WHERE id=1');
    await expect(lookup()).rejects.toMatchObject({ code: 'GLOBAL_VOUCHER_ACCESS_DENIED' });
    expect(await counts()).toEqual({ coupons: 0, vouchers: 0, histories: 0, audits: 0 });
  });
  it('honours ENABLE_VOUCHER_TO_MONEY_CHECK_AND_COVERT and a verified customer', async () => {
    const disabled = build(0);
    expect(await disabled.conversionCapabilities(actor, '1', state.id)).toEqual({
      enabled: false,
    });
    await expect(
      disabled.check(actor, '1', state.id, { voucherCode: 'GFV1' }),
    ).rejects.toMatchObject({ code: 'VOUCHER_TO_MONEY_DISABLED' });
    expect(await service.conversionCapabilities(actor, '1', state.id)).toEqual({ enabled: true });
    await sessions.write({ ...state, verifiedCustomerUntil: now - 1 });
    await expect(
      service.check(actor, '1', state.id, { voucherCode: 'GFV1' }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_VERIFICATION_REQUIRED' });
    expect(calls).toHaveLength(0);
  });
  it('checks balance and validity through API-v2 with the legacy form payload and PIN prompts', async () => {
    replies = [
      { status: 200, body: { voucher_value: 25.49, voucher_validity: '0000-00-00 00:00:00' } },
      { status: 400, body: { title: { is_pin_required: true, title: 'Please enter PIN' } } },
      {
        status: 400,
        body: { title: { is_pin_required: true, is_pin_valid: false, title: 'Invalid PIN' } },
      },
      { status: 200, body: { voucher_value: '40', voucher_validity: '2027-01-31 23:59:59' } },
      { status: 400, body: { title: 'Voucher Does Not Exist' } },
    ];
    expect(await service.check(actor, '1', state.id, { voucherCode: 'GFV1' })).toEqual({
      voucherCode: 'GFV1',
      voucherValue: '25.49',
      validity: '0000-00-00',
      nonExpiring: true,
      pinUsed: false,
    });
    expect(calls[0]).toMatchObject({
      segment: 'gift_voucher_check',
      payload: {
        user_id: '7',
        gift_voucher_code: 'GFV1',
        gc_pin: '0',
        user_email: 'fixture@example.test',
      },
    });
    expect(calls[0]!.authorization).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    await expect(service.check(actor, '1', state.id, { voucherCode: 'GC1' })).rejects.toMatchObject(
      { code: 'GIFT_CARD_PIN_REQUIRED', status: 422 },
    );
    await expect(
      service.check(actor, '1', state.id, { voucherCode: 'GC1', giftCardPin: '111111' }),
    ).rejects.toMatchObject({ code: 'GIFT_CARD_PIN_INVALID', message: 'Invalid PIN' });
    expect(
      await service.check(actor, '1', state.id, { voucherCode: 'GC1', giftCardPin: '123456' }),
    ).toMatchObject({ validity: '2027-01-31', nonExpiring: false, pinUsed: true });
    expect(calls[3]!.payload).toMatchObject({ gc_pin: '123456' });
    await expect(
      service.check(actor, '1', state.id, { voucherCode: 'NOPE' }),
    ).rejects.toMatchObject({ code: 'VOUCHER_REJECTED', message: 'Voucher Does Not Exist' });
  });
  it('tops up through API-v2 once, invalidates the quote and never resends an unknown outcome', async () => {
    replies = [{ status: 200, body: { status: true, title: 'ok' } }];
    const input = { operationId: randomUUID(), voucherCode: 'GFV1' };
    const result = await service.convert(actor, '1', state.id, input);
    expect(result).toMatchObject({
      kind: 'conversion',
      message: "Gift Voucher Amount Has Been Transfered To User's TSS Money",
    });
    expect(calls[0]).toMatchObject({ segment: 'gift_voucher_to_tss_money' });
    expect(await sessions.read(state.id)).toMatchObject({ phase: 'open', quote: null, version: 2 });
    expect(await service.convert(actor, '1', state.id, input)).toEqual(result);
    expect(calls).toHaveLength(1);
    // A definite PIN rejection releases the operation so the same ID can carry the PIN.
    await sessions.write({ ...state, version: 3 });
    replies = [
      { status: 400, body: { title: { is_pin_required: true, title: 'Enter PIN' } } },
      { status: 200, body: { status: true } },
    ];
    const card = { operationId: randomUUID(), voucherCode: 'GC1' };
    await expect(service.convert(actor, '1', state.id, card)).rejects.toMatchObject({
      code: 'GIFT_CARD_PIN_REQUIRED',
    });
    expect(
      await service.convert(actor, '1', state.id, { ...card, giftCardPin: '123456' }),
    ).toMatchObject({ message: "Gift Card Amount Has Been Transfered To User's TSS Money" });
    replies = [new Error('socket hang up')];
    const lost = { operationId: randomUUID(), voucherCode: 'GFV2' };
    await expect(service.convert(actor, '1', state.id, lost)).rejects.toThrow();
    await expect(service.convert(actor, '1', state.id, lost)).rejects.toMatchObject({
      code: 'VOUCHER_OPERATION_UNCONFIRMED',
    });
    expect(calls).toHaveLength(4);
  });
  it('refuses a top-up while a voucher is applied to the sale', async () => {
    await sessions.write({
      ...state,
      cart: { ...state.cart!, meta: { items: [{ name: 'gift_voucher', gift_voucher_value: 10 }] } },
    });
    await expect(
      service.convert(actor, '1', state.id, { operationId: randomUUID(), voucherCode: 'GFV1' }),
    ).rejects.toMatchObject({ code: 'VOUCHER_ALREADY_APPLIED' });
    expect(calls).toHaveLength(0);
  });
});
