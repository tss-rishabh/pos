import { randomUUID } from 'node:crypto';
import {
  normaliseAllowlistEmail,
  normaliseIndianPhone,
  readOutboundAllowlist,
  slackWebhookDigest,
  type OutboundAllowlist,
} from '../config.js';
import { currentRequestTrace } from '../observability/context.js';

/**
 * Outbound-recipient allowlist guard (backend/parity/w25-allowlist.md).
 *
 * Every adapter that delivers a message to a person or a channel (SMS, WhatsApp, email, Slack,
 * OneDirect, and the API-v2 / mailr endpoints that message a customer or operator) calls
 * `outboundAllowlistEnabled()` and, when it is on, `outboundPermitted(...)` immediately before
 * its network call. A suppressed send makes no request; the adapter returns the result a
 * successful send returns, so the flow continues.
 *
 * Disabled (the default): `outboundAllowlistEnabled()` is false, nothing else runs and the
 * adapters behave exactly as before. tests/outbound/allowlist-coverage.test.ts fails when a
 * sender stops calling the guard.
 */

/** Registered outbound events. They never carry a recipient, message body or webhook URL. */
export const outboundEventIds = ['outbound.suppressed', 'outbound.allowlist.active'] as const;
export type OutboundEventId = (typeof outboundEventIds)[number];

export type OutboundChannel = 'sms' | 'whatsapp' | 'email' | 'slack' | 'onedirect' | 'api-v2';
/**
 * Who a send reaches. API-v2 / mailr endpoints receive only an order or customer id and resolve
 * the contact themselves, so the guard resolves every contact on record for that id.
 */
export type OutboundTarget =
  | { kind: 'phone'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'slack-webhook'; value: string | URL }
  | { kind: 'customer'; id: string | number | bigint }
  | { kind: 'order'; id: string | number | bigint };
export interface OutboundAttempt {
  channel: OutboundChannel;
  /** Calling module, e.g. `checkout`; a static identifier. */
  module: string;
  /** Static flow identifier, e.g. `order-sms`; listed in w25-allowlist.md. */
  flow: string;
  targets: readonly OutboundTarget[];
}
/** Contacts on record. Values are compared and discarded, never logged. */
export interface OutboundContacts {
  phones: readonly string[];
  emails: readonly string[];
}
/** Resolves the contacts an API-v2 message for an order or customer would reach. */
export interface OutboundRecipientDirectory {
  customer(id: string): Promise<OutboundContacts | null>;
  order(id: string): Promise<OutboundContacts | null>;
}
export interface OutboundEventSink {
  warn(event: Record<string, string | number | boolean | null>, message: string): void;
}

let allowlist: OutboundAllowlist | undefined;
let directory: OutboundRecipientDirectory | undefined;
let announced = false;
/** Without an installed logger (scripts, tests), events go to stderr as one JSON line. */
const stderrSink: OutboundEventSink = {
  warn(event, message) {
    process.stderr.write(JSON.stringify({ level: 40, ...event, msg: message }) + '\n');
  },
};
let sink: OutboundEventSink = stderrSink;

function current(): OutboundAllowlist {
  // A process that never installed the guard (a tool, a test) still honours the environment.
  allowlist ??= readOutboundAllowlist(process.env);
  return allowlist;
}

/**
 * Called once at startup by the API server (`buildApp`) and the job worker. Logs a single
 * warning, with list sizes only, when the allowlist is active.
 */
export function installOutboundAllowlist(input: {
  allowlist: OutboundAllowlist | undefined;
  log?: OutboundEventSink;
  directory?: OutboundRecipientDirectory;
}) {
  const next = input.allowlist ?? readOutboundAllowlist(process.env);
  allowlist = next;
  sink = input.log ?? stderrSink;
  directory = input.directory;
  if (next.enabled && !announced) {
    announced = true;
    sink.warn(
      {
        eventId: 'outbound.allowlist.active',
        eventInstanceId: randomUUID(),
        module: 'outbound',
        resource: 'allowlist',
        requestId: null,
        userId: null,
        phones: next.phones.size,
        emails: next.emails.size,
        slackWebhooks: next.slackWebhookDigests.size,
      },
      'Outbound allowlist is active: messages go only to allowlisted recipients',
    );
  }
}
/** Test helper: forget the installed state so the next call reads the environment again. */
export function resetOutboundAllowlist() {
  allowlist = undefined;
  directory = undefined;
  announced = false;
  sink = stderrSink;
}

/** Synchronous and side-effect free; when false the caller sends exactly as before. */
export function outboundAllowlistEnabled(): boolean {
  return current().enabled;
}

type Verdict = 'allowed' | 'not-allowlisted' | 'unresolved';
async function verdict(list: OutboundAllowlist, target: OutboundTarget): Promise<Verdict> {
  const phone = (value: string) => list.phones.has(normaliseIndianPhone(value)),
    email = (value: string) => list.emails.has(normaliseAllowlistEmail(value));
  switch (target.kind) {
    case 'phone':
      return phone(target.value) ? 'allowed' : 'not-allowlisted';
    case 'email':
      return email(target.value) ? 'allowed' : 'not-allowlisted';
    case 'slack-webhook':
      return list.slackWebhookDigests.has(slackWebhookDigest(target.value))
        ? 'allowed'
        : 'not-allowlisted';
    case 'customer':
    case 'order': {
      const id = String(target.id);
      if (!directory || !/^[1-9]\d{0,19}$/.test(id)) return 'unresolved';
      let contacts: OutboundContacts | null;
      try {
        contacts =
          target.kind === 'order' ? await directory.order(id) : await directory.customer(id);
      } catch {
        return 'unresolved';
      }
      if (!contacts) return 'unresolved';
      const phones = contacts.phones.filter((value) => value.trim()),
        emails = contacts.emails.filter((value) => value.trim());
      // The provider picks the channel, so every contact it could reach must be listed.
      if (!phones.length && !emails.length) return 'unresolved';
      return phones.every(phone) && emails.every(email) ? 'allowed' : 'not-allowlisted';
    }
  }
}

/**
 * True when the send may go ahead. False means: do not send, the `outbound.suppressed` event is
 * logged, and the caller returns its success result. Never throws; a recipient that cannot be
 * resolved is suppressed (fail closed).
 */
export async function outboundPermitted(attempt: OutboundAttempt): Promise<boolean> {
  const list = current();
  if (!list.enabled) return true;
  let reason: Verdict = attempt.targets.length ? 'allowed' : 'unresolved';
  for (const target of attempt.targets) {
    const result = await verdict(list, target);
    if (result !== 'allowed') {
      reason = result;
      break;
    }
  }
  if (reason === 'allowed') return true;
  const trace = currentRequestTrace();
  sink.warn(
    {
      eventId: 'outbound.suppressed',
      eventInstanceId: randomUUID(),
      module: attempt.module,
      resource: 'outbound-message',
      flow: attempt.flow,
      channel: attempt.channel,
      reason,
      traceId: trace?.traceId ?? null,
      requestId: trace?.requestId ?? null,
      userId: trace?.userId ?? null,
    },
    'Outbound message suppressed by the allowlist',
  );
  return false;
}
