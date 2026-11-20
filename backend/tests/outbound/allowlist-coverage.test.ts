import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Static bypass check (w25-allowlist.md). Any backend module that names a messaging provider or
 * a messaging endpoint and makes a network call must import the guard and call it once per
 * listed flow; anything else that matches must be listed as exempt with a reason. A new sender
 * that skips the guard therefore fails this test.
 */
const backend = fileURLToPath(new URL('../../', import.meta.url));
const source = join(backend, 'src');
const frontend = join(backend, '..', 'frontend');

/** Every guarded sender: file → the flows it guards (each must appear as a literal). */
const guarded: Record<string, readonly string[]> = {
  'src/auth/delivery.ts': [
    'customer-registration-otp',
    'staff-login-otp',
    'staff-login-otp-resend',
    'login-security-alert',
    'whatsapp-failure-alert',
  ],
  'src/modules/checkout/discounts/delivery.ts': ['pg-discount-mail'],
  'src/modules/gift-card-batches/delivery.ts': ['gift-card-batch-mail'],
  'src/modules/checkout/order-sms.ts': ['order-sms'],
  'src/modules/customer-otp/api-v2.ts': ['customer-otp'],
  'src/modules/checkout/service-verification.ts': ['customer-otp'],
  'src/modules/invoice-documents/adapter.ts': ['whatsapp-invoice'],
  'src/modules/checkout/return-workflow/gateway.ts': [
    'return-mail',
    'exchange-mail',
    'exchange-alert',
  ],
  'src/modules/fulfillment/effects.ts': ['fulfillment-slack-alert', 'out-for-delivery-mail'],
  'src/modules/legacy-fulfillment/gateway.ts': [
    'onedirect-ticket',
    'hyperlocal-slack-alert',
    'hyperlocal-new-order-mail',
  ],
  'src/modules/administration/settings-adapters.ts': ['settings-slack-notice'],
  'src/modules/operational-reports/slack.ts': ['report-slack-post'],
};
/** Files that match the provider patterns but deliver no message. */
const exempt: Record<string, string> = {
  'src/modules/operational-reports/scheduled-data.ts':
    'Freshdesk ticket status GET for the CRM report; reads, never creates or emails.',
  'src/modules/administration/slack-provider.ts':
    'Slack OAuth code exchange (oauth.v2.access); posts no message.',
  'src/modules/invoice-documents/options.ts':
    'Builds the mailr URL only; adapter.ts sends it through the guard.',
  'src/modules/fulfillment/options.ts': 'Reads MJML_HOST / SLACK_URL only.',
  'src/modules/legacy-fulfillment/options.ts': 'Reads MJML_HOST / SLACK_URL only.',
  'src/modules/gift-card-batches/options.ts': 'Reads NETCORE_* only.',
  'src/modules/operational-reports/scheduled-options.ts': 'Reads Slack/Freshdesk settings only.',
  'src/modules/administration/settings-options.ts': 'Reads SLACK_URL only.',
};

/** Provider hosts, credentials and messaging endpoints. */
const providerPattern =
  /smsgupshup\.com|GUPSHUP_|NETCORE_|sendgrid|hooks\.slack(?:-gov)?\.com|SLACK_URL|slackUrl|slack_group_url|SLACK_\w*WEBHOOK|freshdesk|onedirect|create-od-ticket|omnichannel-(?:sms|sendotp)|mailr\/|MJML_HOST|mailHost|whatsappInvoiceUrl/i;
/** A network call, or an API-v2 gateway call naming a messaging endpoint. */
const networkPattern =
  /\b(?:fetch|fetcher|tracedFetch)\s*\(|\.api\(\s*'(?:omnichannel-(?:sms|sendotp)|create-od-ticket)'/;

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
    return /\.(?:ts|tsx|cjs|mjs|js)$/.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
  });
}
const relativeName = (path: string) => relative(backend, path).split('\\').join('/');

it('every module that messages through a provider calls the allowlist guard', () => {
  const senders = files(source)
    .filter((path) => !path.includes(`${join('src', 'outbound')}`))
    .map((path) => ({ name: relativeName(path), text: readFileSync(path, 'utf8') }))
    .filter(({ text }) => providerPattern.test(text) && networkPattern.test(text));
  const unlisted = senders
    .map(({ name }) => name)
    .filter((name) => !(name in guarded) && !(name in exempt));
  expect(unlisted, 'new outbound sender: add the guard and list it here').toEqual([]);
  for (const [name, flows] of Object.entries(guarded)) {
    const text = readFileSync(join(backend, name), 'utf8');
    expect(text, name).toMatch(/from '(?:\.\.\/)+outbound\/allowlist\.js'/);
    expect(text, name).toMatch(/outboundAllowlistEnabled\(\)/);
    const calls = text.match(/outboundPermitted\(/g)?.length ?? 0;
    expect(calls, name).toBeGreaterThan(0);
    for (const flow of flows) expect(text, `${name} guards ${flow}`).toContain(`'${flow}'`);
  }
});

it('keeps the expected number of guard calls in each sender', () => {
  // One call per send site; return-workflow notify() and the hyperlocal suppressed() helper each
  // guard three flows, and the staff-login Slack call covers both alert webhooks.
  const expected: Record<string, number> = {
    'src/auth/delivery.ts': 5,
    'src/modules/checkout/discounts/delivery.ts': 1,
    'src/modules/gift-card-batches/delivery.ts': 1,
    'src/modules/checkout/order-sms.ts': 1,
    'src/modules/customer-otp/api-v2.ts': 1,
    'src/modules/checkout/service-verification.ts': 1,
    'src/modules/invoice-documents/adapter.ts': 1,
    'src/modules/checkout/return-workflow/gateway.ts': 1,
    'src/modules/fulfillment/effects.ts': 2,
    'src/modules/legacy-fulfillment/gateway.ts': 1,
    'src/modules/administration/settings-adapters.ts': 1,
    'src/modules/operational-reports/slack.ts': 1,
  };
  expect(Object.keys(expected).sort()).toEqual(Object.keys(guarded).sort());
  for (const [name, count] of Object.entries(expected))
    expect(
      readFileSync(join(backend, name), 'utf8').match(/outboundPermitted\(/g)?.length,
      name,
    ).toBe(count);
});

it('the desktop shell contacts no messaging provider; offline sync uses the backend senders', () => {
  const shell = files(join(frontend, 'electron')).concat(files(join(frontend, 'src')));
  const hosts =
    /smsgupshup\.com|hooks\.slack|netcore|pepipost|sendgrid|freshdesk|onedirect|omnichannel-|mailr\//i;
  const direct = shell
    .filter((path) => hosts.test(readFileSync(path, 'utf8')))
    .map((path) => relative(frontend, path));
  expect(direct).toEqual([]);
  // Offline orders sync through the backend order finalizer, which enqueues the guarded order SMS.
  const sync = readFileSync(join(source, 'modules/offline-sync/routes.ts'), 'utf8'),
    finalizer = readFileSync(join(source, 'modules/checkout/finalizer.ts'), 'utf8');
  expect(sync).toContain("from '../checkout/finalizer.js'");
  expect(finalizer).toMatch(/enqueueOrderSms\(/);
});
