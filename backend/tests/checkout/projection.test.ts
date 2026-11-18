import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { checkoutGateway } from '../../src/modules/checkout/gateway.js';
import { customerContextContract } from '../../src/modules/checkout/customer-context.js';
import { issueCustomerToken } from '../../src/modules/checkout/crypto.js';
import { readConfig } from '../../src/config.js';
import { registerRequestTrace } from '../../src/observability/context.js';
import {
  operator,
  signingEnvironment,
  FixtureGateway,
  MemoryCheckoutRepository,
  identity,
} from './fixtures.js';
import { checkoutService } from '../../src/modules/checkout/service.js';

it('refuses order creation before calling upstream when projection deployment is unverified', async () => {
  const gateway = new FixtureGateway(),
    repository = new MemoryCheckoutRepository(),
    service = checkoutService(
      repository,
      gateway,
      { ...signingEnvironment, checkoutProjectionContract: undefined },
      {
        migrationV2: true,
        assertCheckIn: async () => {},
        finalizeOrder: async () => ({ transactionId: 'FIXTURE', invoice: null }),
      },
    );
  const state = await service.create(operator, '1', '3');
  await service.quote(operator, '1', state.id, {
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
  });
  const before = gateway.calls.length;
  await expect(
    service.submit(operator, '1', state.id, {
      operationId: crypto.randomUUID(),
      expectedVersion: 1,
    }),
  ).rejects.toMatchObject({ code: 'CHECKOUT_PROJECTION_CONTRACT_UNVERIFIED' });
  expect(gateway.calls).toHaveLength(before);
  expect(repository.receipts.size).toBe(1);
});

it('restricts the private projection key and operator correlation header to order confirmation', async () => {
  const calls: { url: string; headers: Headers }[] = [],
    config = readConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SESSION_SECRET: 'projection-fixture-secret-'.repeat(3),
      TSS_API_BASE_URL: 'http://127.0.0.1:9/',
    }),
    gateway = checkoutGateway(
      config,
      {
        ...signingEnvironment,
        customerContextContract,
        customerContextKey: 'separate-context-fixture-key-'.repeat(3),
        paymentOrderUrl: 'https://payments.example.test/order',
      },
      async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return Response.json(
          { success: true },
          {
            headers: {
              'X-POS-Customer-Context': customerContextContract,
              'X-POS-Customer-ID': '777',
            },
          },
        );
      },
    ),
    app = Fastify({ logger: false, genReqId: () => 'projection-request-fixture' });
  app.decorateRequest('principal', null);
  registerRequestTrace(app);
  app.get('/fixture', async (request) => {
    request.principal = operator;
    await gateway.api(
      'pos/order',
      { is_pos: true },
      issueCustomerToken(identity('777'), signingEnvironment),
    );
    await gateway.confirm({}, 'fixture-customer-jwt');
    return { success: true };
  });
  try {
    expect((await app.inject('/fixture')).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.has('X-POS-Projection-Key')).toBe(false);
    expect(calls[0]!.headers.has('X-POS-Operator-ID')).toBe(false);
    expect(calls[1]!.headers.get('X-POS-Projection-Key')).toBe(
      signingEnvironment.checkoutProjectionKey,
    );
    expect(calls[1]!.headers.get('X-POS-Operator-ID')).toBe(operator.id);
    expect(
      calls.every((call) => call.headers.get('X-Request-ID') === 'projection-request-fixture'),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
it('blocks order creation and confirmation when the approved refund contract/hash is missing without dispatching', async () => {
  let calls = 0;
  const config = readConfig({
    NODE_ENV: 'test',
    DEMO_MODE: 'true',
    SESSION_SECRET: 'refund-gateway-fixture-'.repeat(3),
    TSS_API_BASE_URL: 'http://127.0.0.1:9/',
  });
  for (const environment of [
    { ...signingEnvironment, refundAllocationContract: undefined },
    { ...signingEnvironment, refundSourcePatchHash: undefined },
    { ...signingEnvironment, refundSourcePatchHash: '0'.repeat(64) },
  ]) {
    const gateway = checkoutGateway(
      config,
      { ...environment, paymentOrderUrl: 'https://payments.example.test/order' },
      async () => {
        calls++;
        return Response.json({});
      },
    );
    await expect(async () => gateway.api('pos/order', {}, 'fixture-jwt')).rejects.toMatchObject({
      code: 'REFUND_ALLOCATION_CONTRACT_UNVERIFIED',
    });
    await expect(async () => gateway.confirm({}, 'fixture-jwt')).rejects.toMatchObject({
      code: 'REFUND_ALLOCATION_CONTRACT_UNVERIFIED',
    });
  }
  expect(calls).toBe(0);
});
