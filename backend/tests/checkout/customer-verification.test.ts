import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import { checkoutService, publicState } from '../../src/modules/checkout/service.js';
import { sameCustomerContact } from '../../src/modules/checkout/customer-contact-authority.js';
import type { CustomerVerificationClient } from '../../src/modules/checkout/customer-verification.js';
import type {
  CustomerOtpOperationView,
  CustomerOtpView,
} from '../../src/modules/customer-otp/index.js';
import {
  FixtureGateway,
  MemoryCheckoutRepository,
  operator,
  signingEnvironment,
} from './fixtures.js';

const input = (version: number) => ({ operationId: crypto.randomUUID(), expectedVersion: version });
async function fixture() {
  const repository = new MemoryCheckoutRepository(),
    gateway = new FixtureGateway(),
    clock = Date.now(),
    operations = new Map<string, CustomerOtpOperationView>();
  let current: CustomerOtpView | null = null,
    requestCount = 0,
    verifyCount = 0,
    revoked = false,
    lostRequest = false,
    lostVerify = false;
  async function own() {
    if (!current) throw new AppError(404, 'CUSTOMER_OTP_NOT_FOUND', 'Fixture challenge not found.');
    if (revoked || !sameCustomerContact(current.contact, await repository.customerContact('1001')))
      throw new AppError(409, 'CUSTOMER_OTP_SCOPE_CHANGED', 'Fixture authority changed.');
    return structuredClone(current);
  }
  const customerOtp: CustomerVerificationClient = {
    async request(_user, _scope, id, operationId, contact) {
      requestCount++;
      current = { id, status: 'pending', expiresAt: clock + 300000, verifiedUntil: null, contact };
      operations.set(operationId, {
        kind: 'request',
        result: structuredClone(current),
        error: null,
      });
      if (lostRequest) throw new Error('Fixture lost request acknowledgement.');
      return structuredClone(current);
    },
    async read() {
      return own();
    },
    async verify(_user, _scope, _id, operationId, code) {
      verifyCount++;
      await own();
      const error = code === '123456' ? null : 'CUSTOMER_OTP_INVALID';
      if (!error) current = { ...current!, verifiedUntil: clock + 900000 };
      operations.set(operationId, { kind: 'verify', result: structuredClone(current), error });
      if (lostVerify) throw new Error('Fixture lost verification acknowledgement.');
      if (error) throw new AppError(422, error, 'Fixture wrong code.');
      return structuredClone(current!);
    },
    async readOperation(_user, _scope, _id, operationId) {
      const view = await own(),
        receipt = operations.get(operationId);
      return receipt ? { ...receipt, result: view } : null;
    },
  };
  const service = checkoutService(repository, gateway, signingEnvironment, {
    migrationV2: true,
    assertCheckIn: async () => {},
    customerOtp,
    now: () => clock,
  });
  const created = await service.create(operator, '1', '3');
  await service.attachCustomer(operator, '1', created.id, input(0), '1001');
  return {
    repository,
    gateway,
    service,
    id: created.id,
    operations,
    customerOtp,
    view: () => current!,
    counts: () => ({ requestCount, verifyCount }),
    delivered: (status: 'sent' | 'uncertain' = 'sent') => {
      current = { ...current!, status };
    },
    loseRequest: () => {
      lostRequest = true;
    },
    loseVerify: () => {
      lostVerify = true;
    },
    revoke: () => {
      revoked = true;
    },
  };
}

describe('purpose-bound local customer verification and checkpoint recovery', () => {
  it('keeps queued delivery distinct from sent and never calls the legacy OTP endpoints', async () => {
    const f = await fixture(),
      sent = await f.service.sendVerification(operator, '1', f.id, input(1));
    expect(sent.status).toBe('succeeded');
    expect(sent.state.verificationChallenge).toMatchObject({
      sent: false,
      deliveryStatus: 'pending',
    });
    await expect(f.service.verify(operator, '1', f.id, input(2), '123456')).rejects.toMatchObject({
      code: 'CUSTOMER_OTP_CHALLENGE_REQUIRED',
    });
    expect(f.counts()).toEqual({ requestCount: 1, verifyCount: 0 });
    f.delivered('uncertain');
    const read = await f.service.read(operator, '1', f.id);
    expect(read.verificationChallenge).toMatchObject({ sent: false, deliveryStatus: 'uncertain' });
    const verified = await f.service.verify(operator, '1', f.id, input(2), '123456');
    expect(verified.state.verifiedCustomerUntil).toBe(f.view().verifiedUntil);
    expect(gatewayOtpCalls(f.gateway)).toBe(0);
    const visible = JSON.stringify(publicState(verified.state));
    expect(visible).not.toContain(f.view().contact.digest);
    expect(visible).not.toContain('verifiedCustomerContact');
  });

  it('repairs a lost committed request from its original receipt without dispatch or stale state overwrite', async () => {
    const f = await fixture(),
      request = input(1);
    f.loseRequest();
    await expect(f.service.sendVerification(operator, '1', f.id, request)).rejects.toMatchObject({
      code: 'CHECKOUT_OUTCOME_UNCERTAIN',
    });
    const pending = f.repository.states.get(f.id)!;
    expect(pending.phase).toBe('open');
    const recovered = await f.service.reconcileVerification(operator, '1', f.id, request);
    expect(recovered.status).toBe('succeeded');
    expect(recovered.state.version).toBe(2);
    await f.service.setLine(operator, '1', f.id, input(2), '10', 3);
    const replay = await f.service.reconcileVerification(operator, '1', f.id, request);
    expect(replay.state.version).toBe(3);
    expect(replay.state.cart?.products.items[0]?.quantity).toBe(3);
    expect(f.counts()).toEqual({ requestCount: 1, verifyCount: 0 });
  });

  it('uses only GET evidence when a request has no proved commit', async () => {
    const f = await fixture(),
      request = input(1);
    f.loseRequest();
    await expect(f.service.sendVerification(operator, '1', f.id, request)).rejects.toThrow();
    f.operations.clear();
    const recovered = await f.service.reconcileVerification(operator, '1', f.id, request);
    expect(recovered).toMatchObject({
      status: 'uncertain',
      errorCode: 'CUSTOMER_VERIFICATION_OUTCOME_UNPROVED',
    });
    expect(f.repository.states.get(f.id)!.version).toBe(1);
    expect(f.counts()).toEqual({ requestCount: 1, verifyCount: 0 });
  });
  it('closes only the original revoked OTP action so the sale can request fresh verification', async () => {
    const f = await fixture(),
      request = input(1);
    f.loseRequest();
    await expect(f.service.sendVerification(operator, '1', f.id, request)).rejects.toThrow();
    f.revoke();
    const reply = await f.service.reconcileVerification(operator, '1', f.id, request);
    expect(reply).toMatchObject({ status: 'rejected', errorCode: 'CUSTOMER_OTP_SCOPE_CHANGED' });
    expect(reply.state).toMatchObject({
      phase: 'open',
      busyOperationId: null,
      verifiedCustomerUntil: null,
    });
    expect(reply.state.verificationChallenge?.deliveryStatus).toBe('rejected');
    expect(f.counts()).toEqual({ requestCount: 1, verifyCount: 0 });
  });

  it.each(['123456', '654321'])(
    'repairs a lost verify %s without consuming another attempt',
    async (code) => {
      const f = await fixture();
      await f.service.sendVerification(operator, '1', f.id, input(1));
      f.delivered('uncertain');
      f.loseVerify();
      const verify = input(2);
      await expect(f.service.verify(operator, '1', f.id, verify, code)).rejects.toMatchObject({
        code: 'CHECKOUT_OUTCOME_UNCERTAIN',
      });
      const before = await f.service.read(operator, '1', f.id);
      expect(before.verifiedCustomerUntil).toBeNull();
      const reply = await f.service.reconcileVerification(operator, '1', f.id, verify);
      expect(reply.status).toBe(code === '123456' ? 'succeeded' : 'rejected');
      expect(reply.state.verifiedCustomerUntil).toBe(
        code === '123456' ? f.view().verifiedUntil : null,
      );
      expect(reply.state.verificationChallenge?.attempts).toBe(1);
      await f.service.reconcileVerification(operator, '1', f.id, verify);
      expect(f.counts()).toEqual({ requestCount: 1, verifyCount: 1 });
    },
  );
  it('rejects an expired committed verification outcome without extending proof or trying the code again', async () => {
    const f = await fixture();
    await f.service.sendVerification(operator, '1', f.id, input(1));
    f.delivered();
    f.loseVerify();
    const verification = input(2);
    await expect(f.service.verify(operator, '1', f.id, verification, '123456')).rejects.toThrow();
    f.view().verifiedUntil = null;
    const reply = await f.service.reconcileVerification(operator, '1', f.id, verification);
    expect(reply).toMatchObject({
      status: 'rejected',
      errorCode: 'CUSTOMER_OTP_EXPIRED',
      state: { verifiedCustomerUntil: null, busyOperationId: null },
    });
    expect(f.counts()).toEqual({ requestCount: 1, verifyCount: 1 });
  });

  it('rechecks actor/contact authority before spending and does not grant from another action', async () => {
    const f = await fixture();
    await f.service.sendVerification(operator, '1', f.id, input(1));
    f.delivered();
    await f.service.verify(operator, '1', f.id, input(2), '123456');
    f.revoke();
    const gateway = vi.spyOn(f.gateway, 'api');
    await expect(
      f.service.wallet(operator, '1', f.id, input(3), {
        money: true,
        points: false,
        appliedMoney: '1',
        custom: false,
      }),
    ).rejects.toMatchObject({ code: 'CUSTOMER_OTP_SCOPE_CHANGED' });
    expect(gateway).not.toHaveBeenCalled();
    expect((await f.service.read(operator, '1', f.id)).verifiedCustomerUntil).toBeNull();
  });
});
function gatewayOtpCalls(gateway: FixtureGateway) {
  return gateway.calls.filter((call) => call.path.startsWith('omnichannel-')).length;
}
