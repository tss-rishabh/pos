import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import { registerCustomerWebsiteHandoff } from '../../src/modules/customer-website-handoff/index.js';
import {
  readCustomerWebsiteHandoffOptions,
  configuredWebsiteHandoff,
} from '../../src/modules/customer-website-handoff/options.js';
const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'synthetic-web-session-private-secret-'.repeat(2),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_integration',
});
const options = readCustomerWebsiteHandoffOptions({
  CUSTOMER_WEBSITE_HANDOFF_ENABLED: 'true',
  CUSTOMER_WEBSITE_HANDOFF_CONTRACT: 'pos-customer-website-handoff-v1',
  CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL: 'https://website.fixture.test/pos/secure-login',
  CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY: 'synthetic-private-website-receiver-key-'.repeat(2),
});
describe('website receiver credential boundary', () => {
  it.each([
    ['absent', undefined, 'https://website.fixture.test', 401],
    ['invalid', 'invalid', 'https://website.fixture.test', 401],
    [
      'wrong origin',
      options.CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY,
      'https://other.fixture.test',
      403,
    ],
    ['absent origin', options.CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY, undefined, 403],
  ])(
    'rejects %s service credentials before any database work even with browser cookies',
    async (_name, key, origin, status) => {
      let work = 0;
      const db: Databases = {
        get() {
          work++;
          throw new Error('No DB allowed');
        },
        async close() {},
      };
      const app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        const code =
          typeof error === 'object' && error !== null && 'status' in error
            ? Number(error.status)
            : 500;
        void reply.code(code).send({ error: 'denied' });
      });
      registerCustomerWebsiteHandoff(app, config, db, undefined, options);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/customer-website-handoffs/redemptions',
        headers: {
          cookie: 'pos_session=synthetic-authenticated-browser',
          ...(key ? { 'x-customer-website-handoff-key': key } : {}),
          ...(origin ? { origin } : {}),
        },
        payload: {},
      });
      expect(response.statusCode).toBe(status);
      expect(work).toBe(0);
      await app.close();
    },
  );
  it('requires an explicit contract, TLS destination, separate private key and no query credentials', () => {
    expect(configuredWebsiteHandoff(config, options).url.origin).toBe(
      'https://website.fixture.test',
    );
    for (const receiver of [
      'http://website.fixture.test/pos/secure-login',
      'https://u:p@website.fixture.test/pos/secure-login',
      'https://website.fixture.test/pos/secure-login?token=secret',
      'https://website.fixture.test/pos/secure-login#secret',
      'https://website.fixture.test/other',
    ])
      expect(() =>
        configuredWebsiteHandoff(config, {
          ...options,
          CUSTOMER_WEBSITE_HANDOFF_RECEIVER_URL: receiver,
        }),
      ).toThrow();
    expect(() =>
      configuredWebsiteHandoff(config, {
        ...options,
        CUSTOMER_WEBSITE_HANDOFF_SERVICE_KEY: config.SESSION_SECRET,
      }),
    ).toThrow();
    expect(() => configuredWebsiteHandoff(config, readCustomerWebsiteHandoffOptions({}))).toThrow();
  });
});
