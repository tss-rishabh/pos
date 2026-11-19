import { afterEach, expect, it } from 'vitest';
import {
  normaliseIndianPhone,
  readConfig,
  readOutboundAllowlist,
  slackWebhookDigest,
} from '../../src/config.js';
import {
  installOutboundAllowlist,
  outboundAllowlistEnabled,
  outboundPermitted,
  resetOutboundAllowlist,
} from '../../src/outbound/allowlist.js';
import { withRequestTrace } from '../../src/observability/context.js';
import type { LoggedEvent } from './harness.js';

const base = {
  SESSION_SECRET: 'fixture-session-secret-with-32-characters!',
  MYSQL_PRIMARY_READER_URL: 'mysql://reader@127.0.0.1/fixture',
};
const webhook = 'https://hooks.slack.com/services/T000/B000/configfixture';

afterEach(() => resetOutboundAllowlist());

it('is off by default and adds nothing to a config that does not set it', () => {
  const config = readConfig(base);
  expect(config.outboundAllowlist.enabled).toBe(false);
  expect(config.outboundAllowlist.phones.size).toBe(0);
  // The .env.example placeholders (all empty) keep it off.
  expect(
    readOutboundAllowlist({
      OUTBOUND_ALLOWLIST_ENABLED: '',
      OUTBOUND_ALLOWLIST_PHONES: '',
      OUTBOUND_ALLOWLIST_EMAILS: '',
      OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS: '',
    }).enabled,
  ).toBe(false);
  resetOutboundAllowlist();
  expect(outboundAllowlistEnabled()).toBe(false);
});

it('fails validation when enabled with every list empty, in any environment', () => {
  expect(() => readConfig({ ...base, OUTBOUND_ALLOWLIST_ENABLED: 'true' })).toThrow(
    /OUTBOUND_ALLOWLIST_ENABLED requires at least one/,
  );
  expect(() => readOutboundAllowlist({ OUTBOUND_ALLOWLIST_ENABLED: 'true' })).toThrow();
  expect(() => readConfig({ ...base, OUTBOUND_ALLOWLIST_ENABLED: 'yes' })).toThrow();
});

it('may be enabled in production, where it only ever stops messages', () => {
  const config = readConfig({
    ...base,
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://pos.example.test',
    MYSQL_WRITER_URL: 'mysql://writer@db.example.test/fixture',
    MYSQL_PRIMARY_READER_URL: 'mysql://reader@db.example.test/fixture',
    MYSQL_DATA_READER_URL: 'mysql://data@db.example.test/fixture',
    REDIS_URL: 'rediss://redis.example.test:6379/0',
    OUTBOUND_ALLOWLIST_ENABLED: 'true',
    OUTBOUND_ALLOWLIST_EMAILS: 'qa@example.test',
  });
  expect(config.outboundAllowlist.enabled).toBe(true);
});

it('rejects invalid entries without echoing them', () => {
  for (const [key, value] of [
    ['OUTBOUND_ALLOWLIST_PHONES', '12-34'],
    ['OUTBOUND_ALLOWLIST_EMAILS', 'not-an-email-secretvalue'],
    ['OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS', 'http://hooks.slack.com/services/secretvalue'],
  ] as const) {
    let message = '';
    try {
      readConfig({ ...base, OUTBOUND_ALLOWLIST_ENABLED: 'true', [key]: value });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(`${key} contains an invalid entry.`);
    expect(message).not.toContain('secretvalue');
    expect(message).not.toContain('12-34');
  }
});

it('normalises Indian numbers, folds email case and keeps only webhook digests', () => {
  expect(
    ['+91 90000 00001', '919000000001', '09000000001', '9000000001'].map(normaliseIndianPhone),
  ).toEqual(['9000000001', '9000000001', '9000000001', '9000000001']);
  const list = readOutboundAllowlist({
    OUTBOUND_ALLOWLIST_ENABLED: 'true',
    OUTBOUND_ALLOWLIST_PHONES: ' +91-90000-00001 , 9000000003,',
    OUTBOUND_ALLOWLIST_EMAILS: 'QA.Tester@Example.TEST',
    OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS: webhook,
  });
  expect([...list.phones]).toEqual(['9000000001', '9000000003']);
  expect([...list.emails]).toEqual(['qa.tester@example.test']);
  expect([...list.slackWebhookDigests]).toEqual([slackWebhookDigest(webhook)]);
  expect(JSON.stringify([...list.slackWebhookDigests])).not.toContain('configfixture');
});

it('logs one startup warning with list sizes only', () => {
  const events: LoggedEvent[] = [];
  const allowlist = readOutboundAllowlist({
    OUTBOUND_ALLOWLIST_ENABLED: 'true',
    OUTBOUND_ALLOWLIST_PHONES: '9000000001,9000000003',
    OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS: webhook,
  });
  const log = { warn: (event: LoggedEvent) => events.push(event) };
  installOutboundAllowlist({ allowlist, log });
  installOutboundAllowlist({ allowlist, log });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    eventId: 'outbound.allowlist.active',
    phones: 2,
    emails: 0,
    slackWebhooks: 1,
  });
  const logged = JSON.stringify(events);
  expect(logged).not.toContain('9000000001');
  expect(logged).not.toContain('configfixture');
  resetOutboundAllowlist();
  const quiet: LoggedEvent[] = [];
  installOutboundAllowlist({
    allowlist: readOutboundAllowlist({}),
    log: { warn: (event) => quiet.push(event) },
  });
  expect(quiet).toEqual([]);
});

it('carries the request trace and fails closed when an order or customer cannot be resolved', async () => {
  const events: LoggedEvent[] = [];
  installOutboundAllowlist({
    allowlist: readOutboundAllowlist({
      OUTBOUND_ALLOWLIST_ENABLED: 'true',
      OUTBOUND_ALLOWLIST_PHONES: '9000000001',
    }),
    log: { warn: (event) => events.push(event) },
  });
  const requestId = '7d0f3c1e-8a9b-4c2d-9e1f-0a1b2c3d4e5f';
  // No recipient directory is installed: API-v2 sends by order or customer id are suppressed.
  const permitted = await withRequestTrace(
    { requestId, userId: '42', module: 'checkout', resource: 'order' },
    () =>
      outboundPermitted({
        channel: 'api-v2',
        module: 'checkout',
        flow: 'order-sms',
        targets: [{ kind: 'order', id: '101' }],
      }),
  );
  expect(permitted).toBe(false);
  expect(
    await outboundPermitted({ channel: 'sms', module: 'checkout', flow: 'x', targets: [] }),
  ).toBe(false);
  expect(events[0]).toMatchObject({ eventId: 'outbound.allowlist.active' });
  expect(events[1]).toMatchObject({
    eventId: 'outbound.suppressed',
    reason: 'unresolved',
    traceId: requestId,
    requestId,
    userId: '42',
  });
  // A contact list with an unlisted entry is suppressed even when one entry is listed.
  installOutboundAllowlist({
    allowlist: readOutboundAllowlist({
      OUTBOUND_ALLOWLIST_ENABLED: 'true',
      OUTBOUND_ALLOWLIST_PHONES: '9000000001',
    }),
    log: { warn: (event) => events.push(event) },
    directory: {
      order: async () => ({ phones: ['9000000001'], emails: ['customer@example.test'] }),
      customer: async () => {
        throw new Error('database unavailable');
      },
    },
  });
  expect(
    await outboundPermitted({
      channel: 'api-v2',
      module: 'checkout',
      flow: 'order-sms',
      targets: [{ kind: 'order', id: '101' }],
    }),
  ).toBe(false);
  expect(
    await outboundPermitted({
      channel: 'api-v2',
      module: 'customer-otp',
      flow: 'customer-otp',
      targets: [{ kind: 'customer', id: '201' }],
    }),
  ).toBe(false);
  expect(events.slice(-2).map((event) => event.reason)).toEqual(['not-allowlisted', 'unresolved']);
});
