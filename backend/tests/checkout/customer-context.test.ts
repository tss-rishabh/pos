import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import {
  assertCustomerContextReady,
  checkoutTokenSubject,
  customerContextContract,
  customerContextSegments,
} from '../../src/modules/checkout/customer-context.js';
import { issueCustomerToken } from '../../src/modules/checkout/crypto.js';
import { checkoutEnvironment, checkoutGateway } from '../../src/modules/checkout/gateway.js';
import { identity, signingEnvironment } from './fixtures.js';

const environment = {
  ...signingEnvironment,
  customerContextContract,
  customerContextKey: 'fixture-separate-private-context-key-'.repeat(2),
};
const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'private-context-test-session-key-'.repeat(3),
  TSS_API_BASE_URL: 'http://127.0.0.1:9/api/v2/',
});
const customer = identity('9007199254740993');
const token = () => issueCustomerToken(customer, environment);

it('verifies the pinned Python middleware candidate and its hostile input/cache bypass cases', () => {
  const output = execFileSync(
    'python3',
    [
      '-m',
      'unittest',
      'discover',
      '-s',
      'compatibility/upstream/customer-context',
      '-p',
      'test_*.py',
    ],
    { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(output).toBe('');
});

it('requires the explicit context contract and its own correctly formed purpose key', () => {
  expect(() => assertCustomerContextReady(environment)).not.toThrow();
  for (const candidate of [
    { ...environment, customerContextContract: undefined },
    { ...environment, customerContextContract: 'unknown' },
    { ...environment, customerContextKey: undefined },
    { ...environment, customerContextKey: 'bad\nkey'.repeat(20) },
  ])
    expect(() => assertCustomerContextReady(candidate)).toThrowError(
      expect.objectContaining({ code: 'CUSTOMER_CONTEXT_CONTRACT_UNVERIFIED' }),
    );
  expect(
    checkoutEnvironment({
      UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT: customerContextContract,
      TSS_POS_CUSTOMER_CONTEXT_KEY: environment.customerContextKey,
    }),
  ).toMatchObject({
    customerContextContract,
    customerContextKey: environment.customerContextKey,
  });
});

it('verifies HS256/HS512 identity, expiry and BIGINT subject without trusting decoded claims', () => {
  const now = Date.now();
  expect(
    checkoutTokenSubject(issueCustomerToken(customer, environment, now), environment, now),
  ).toBe(customer.id);
  const twoFactor = issueCustomerToken({ ...customer, twoFactor: true }, environment, now);
  expect(checkoutTokenSubject(twoFactor, environment, now)).toBe(customer.id);
  const valid = issueCustomerToken(customer, environment, now);
  const parts = valid.split('.');
  const claims = Buffer.from(JSON.stringify({ sub: '777', iat: 1, exp: 9_999_999_999 })).toString(
    'base64url',
  );
  for (const candidate of [
    undefined,
    '',
    'fixture-unsigned-jwt',
    `${parts[0]}.${claims}.${parts[2]}`,
    `2f.${valid}`,
    twoFactor.slice(3),
    `${valid}=`,
    issueCustomerToken(customer, environment, now - 4000_000),
    issueCustomerToken(customer, environment, now + 60_000),
  ])
    expect(() => checkoutTokenSubject(candidate, environment, now)).toThrowError(
      expect.objectContaining({ code: 'CUSTOMER_CONTEXT_IDENTITY_INVALID' }),
    );
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const message = `${header}.${claims}`;
  const signature = createHmac('sha256', environment.hs256).update(message).digest('base64url');
  expect(() => checkoutTokenSubject(`${message}.${signature}`, environment, now)).toThrowError(
    expect.objectContaining({ code: 'CUSTOMER_CONTEXT_IDENTITY_INVALID' }),
  );
});

it('binds all cart/order calls to fresh context and keeps the separate key off other services', async () => {
  const calls: { url: URL; headers: Headers; body: string }[] = [];
  const gateway = checkoutGateway(
    config,
    { ...environment, paymentOrderUrl: 'https://payment.example.test/order' },
    async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: new URL(String(url)), headers, body: String(init?.body) });
      return Response.json(
        { success: true },
        {
          headers: headers.has('X-POS-Customer-Context')
            ? {
                'X-POS-Customer-Context': customerContextContract,
                'X-POS-Customer-ID': customer.id,
              }
            : {},
        },
      );
    },
  );
  for (const segment of customerContextSegments)
    await gateway.api(segment, { is_pos: true, store_id: 1, tab_id: 123 }, token());
  expect(() => gateway.api('omnichannel-sendotp', { phone: '9876543210' })).toThrowError(
    expect.objectContaining({ code: 'CUSTOMER_VERIFICATION_SERVICE_UNAVAILABLE' }),
  );
  await gateway.confirm({}, token());
  expect(calls).toHaveLength(customerContextSegments.length + 1);
  for (const call of calls.slice(0, customerContextSegments.length)) {
    expect(call.headers.get('X-POS-Customer-Context')).toBe(customerContextContract);
    expect(call.headers.get('X-POS-Customer-Context-Key')).toBe(environment.customerContextKey);
    expect(call.headers.get('X-POS-Customer-ID')).toBe(customer.id);
    expect(call.headers.has('X-POS-Projection-Key')).toBe(false);
    expect(JSON.parse(call.body)).toMatchObject({ is_pos: true, store_id: 1, tab_id: 123 });
  }
  for (const call of calls.slice(customerContextSegments.length)) {
    expect(call.headers.has('X-POS-Customer-Context-Key')).toBe(false);
    expect(call.headers.has('X-POS-Customer-ID')).toBe(false);
  }
  expect(calls.at(-1)!.headers.get('X-POS-Projection-Key')).toBe(environment.checkoutProjectionKey);
});

it('never dispatches unconfigured, forged or unscoped private context requests', async () => {
  let dispatches = 0;
  const fetcher: typeof fetch = async () => {
    dispatches++;
    return Response.json({});
  };
  await expect(async () =>
    checkoutGateway(config, signingEnvironment, fetcher).api(
      'cart',
      { is_pos: true, store_id: 1 },
      token(),
    ),
  ).rejects.toMatchObject({ code: 'CUSTOMER_CONTEXT_CONTRACT_UNVERIFIED' });
  const gateway = checkoutGateway(config, environment, fetcher);
  await expect(async () => gateway.api('cart', { is_pos: true }, 'forged')).rejects.toMatchObject({
    code: 'CUSTOMER_CONTEXT_IDENTITY_INVALID',
  });
  await expect(async () => gateway.api('cart', {}, token())).rejects.toMatchObject({
    code: 'CUSTOMER_CONTEXT_SCOPE_INVALID',
  });
  expect(dispatches).toBe(0);
});

it('freezes successful but unproven or wrong-customer POST outcomes instead of trusting the body', async () => {
  const headerCases: Record<string, string>[] = [
    {},
    { 'X-POS-Customer-Context': 'old-version', 'X-POS-Customer-ID': customer.id },
    { 'X-POS-Customer-Context': customerContextContract, 'X-POS-Customer-ID': '777' },
  ];
  for (const headers of headerCases) {
    let dispatches = 0;
    const gateway = checkoutGateway(config, environment, async () => {
      dispatches++;
      return Response.json({ success: true }, { headers });
    });
    await expect(gateway.api('cart', { is_pos: true }, token())).rejects.toMatchObject({
      code: 'CUSTOMER_CONTEXT_PROOF_MISSING',
      uncertain: true,
    });
    expect(dispatches).toBe(1);
  }
});
