import { beforeEach, describe, expect, it } from 'vitest';
import type { Databases } from '../../src/db/pools.js';
import type { CheckoutState } from '../../src/modules/checkout/contracts.js';
import {
  customerRegistrationService,
  registrationKeys,
  type RegistrationOtpSender,
} from '../../src/modules/checkout/customers/service.js';
import type { CustomerRegistrations } from '../../src/modules/checkout/customers/contracts.js';
import { checkoutSessionStore } from '../../src/modules/checkout/session-store.js';
import { memoryStateStore, type PosStateStore } from '../../src/modules/checkout/state-store.js';
import { FixtureGateway, identity } from './fixtures.js';

/** S36 "Self Verify (Without OTP)": `create_order.html:4856,4996`, `order/views.py:2429-2448`. */
const telephone = '9876500001';
const details = {
  name: 'Self Verify Customer',
  telephone,
  email: 'self.verify@example.com',
  birthdate: '',
  customerType: 'B2C' as const,
  gstin: '',
};
/** Writer reads: duplicate checks answer "none"; queued rows answer the account confirmation. */
function fakeDb(queue: unknown[][]): Databases {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(queue.shift() ?? []),
  };
  return { get: () => chain } as unknown as Databases;
}
function baseState(id: string, registrationId: string | null): CheckoutState {
  return {
    id,
    operatorId: '44',
    operatorCustomerId: '777',
    storeId: '1',
    counterId: '3',
    tabId: 2,
    customerId: null,
    verifiedCustomerUntil: null,
    verificationChallenge: null,
    version: 1,
    phase: 'open',
    cart: null,
    quote: null,
    orderId: null,
    orderSubmissionOperationId: null,
    paymentConfirmation: null,
    salespersonId: null,
    lineSalespersons: {},
    giftCards: {},
    busyOperationId: registrationId,
    registrationId,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('customer registration self verify (S36)', () => {
  let clock: number,
    store: PosStateStore,
    queue: unknown[][],
    smsFails: boolean,
    audits: Record<string, unknown>[],
    registrations: CustomerRegistrations,
    gateway: FixtureGateway;
  const sender: RegistrationOtpSender = {
    assertReady: (channel) => {
      if (channel === 'whatsapp') throw new Error('not configured');
    },
    send: async () => {
      if (smsFails) throw new Error('provider down');
    },
  };
  beforeEach(() => {
    clock = 1_800_000_000_000;
    store = memoryStateStore(() => clock);
    queue = [];
    smsFails = false;
    audits = [];
    gateway = new FixtureGateway();
    const sessions = checkoutSessionStore(store, () => clock);
    registrations = customerRegistrationService(
      fakeDb(queue),
      gateway,
      { secret: 'fixture-registration-secret-'.repeat(3), ttlSeconds: 180, fallbackSeconds: 20 },
      sender,
      'Asia/Kolkata',
      {
        stateStore: store,
        sessions,
        now: () => clock,
        schedule: () => undefined,
        log: { info: (value) => audits.push(value) },
      },
    );
  });
  async function requested() {
    const registrationId = crypto.randomUUID(),
      state = baseState(crypto.randomUUID(), registrationId);
    await checkoutSessionStore(store, () => clock).write(state);
    await registrations.request(state, registrationId, details);
    return state;
  }

  it('is refused when no registration OTP was sent for the sale', async () => {
    await expect(
      registrations.selfVerify(baseState(crypto.randomUUID(), null), telephone),
    ).rejects.toMatchObject({ status: 409, code: 'CUSTOMER_SELF_VERIFY_OTP_NOT_SENT' });
    smsFails = true;
    const state = await requested();
    await expect(registrations.selfVerify(state, telephone)).rejects.toMatchObject({
      status: 409,
      code: 'CUSTOMER_SELF_VERIFY_OTP_NOT_SENT',
    });
    expect(audits).toEqual([]);
  });

  it('is refused for a different phone or another checkout', async () => {
    const state = await requested();
    await expect(registrations.selfVerify(state, '9876500002')).rejects.toMatchObject({
      status: 409,
      code: 'CUSTOMER_SELF_VERIFY_PHONE_MISMATCH',
    });
    const other = { ...baseState(crypto.randomUUID(), state.registrationId ?? null) };
    await expect(registrations.selfVerify(other, telephone)).rejects.toMatchObject({
      status: 404,
      code: 'CUSTOMER_REGISTRATION_NOT_FOUND',
    });
    expect((await registrations.read(state))?.status).toBe('pending');
  });

  it('is refused once the OTP window has ended', async () => {
    const state = await requested();
    clock += 180_000;
    await expect(registrations.selfVerify(state, telephone)).rejects.toMatchObject({
      status: 409,
      code: 'CUSTOMER_SELF_VERIFY_EXPIRED',
    });
  });

  it('registers and audits with identifiers only, without a verified-customer proof', async () => {
    const state = await requested();
    clock += 179_000;
    const verified = await registrations.selfVerify(state, telephone);
    expect(verified).toMatchObject({ status: 'verified', selfVerified: true });
    const customerId = '9001';
    gateway.intercept = async (path) => (path === 'store-register' ? { user_id: 9001 } : undefined);
    queue.push(
      [],
      [
        {
          id: 9001n,
          email: details.email,
          telephone,
          active: 1,
          blocked: 0,
        },
      ],
    );
    const registered = await registrations.register(state);
    expect(registered).toMatchObject({ status: 'registered', customerId, selfVerified: true });
    // S33: benefits still need a verified customer proof.
    expect(
      await registrations.verifiedCustomerUntil(state, {
        ...identity(customerId),
        telephone,
        email: details.email,
      }),
    ).toBeNull();
    expect(audits.map((event) => event.eventId)).toEqual([
      'checkout.customer-registration.self-verify-accepted',
      'checkout.customer-registration.self-verify-registered',
    ]);
    expect(audits[1]).toMatchObject({
      userId: '44',
      storeId: '1',
      checkoutId: state.id,
      registrationId: state.registrationId,
      customerId,
    });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(telephone);
    expect(serialized).not.toContain(details.email);
    expect(await store.get(registrationKeys.record(state.registrationId ?? ''))).not.toContain(
      telephone,
    );
  });
});
