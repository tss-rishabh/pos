import { readOutboundAllowlist } from '../../src/config.js';
import {
  installOutboundAllowlist,
  resetOutboundAllowlist,
  type OutboundContacts,
} from '../../src/outbound/allowlist.js';

/** Synthetic contacts only (reserved test ranges / example domains). */
export const listedPhone = '9000000001';
export const unlistedPhone = '9000000002';
export const listedEmail = 'qa.listed@example.test';
export const unlistedEmail = 'someone@example.test';
export const listedWebhook = 'https://hooks.slack.com/services/T000/B000/listedfixture';
export const unlistedWebhook = 'https://hooks.slack.com/services/T000/B000/otherfixture';

export type Mode = 'disabled' | 'allowed' | 'suppressed';
export interface Recorded {
  url: string;
  method: string | undefined;
  body: string;
}
export type LoggedEvent = Record<string, string | number | boolean | null>;

/**
 * Installs the guard for one case. `allowed` / `suppressed` enable the allowlist; the fake
 * directory resolves order 101 and customer 201 to listed contacts and 102 / 202 to unlisted.
 */
export function useAllowlist(mode: Mode) {
  resetOutboundAllowlist();
  const events: LoggedEvent[] = [];
  const contacts = (listed: boolean): OutboundContacts =>
    listed
      ? { phones: [listedPhone, `+91 ${listedPhone}`], emails: [listedEmail.toUpperCase()] }
      : { phones: [listedPhone, unlistedPhone], emails: [listedEmail] };
  installOutboundAllowlist({
    allowlist: readOutboundAllowlist(
      mode === 'disabled'
        ? {}
        : {
            OUTBOUND_ALLOWLIST_ENABLED: 'true',
            OUTBOUND_ALLOWLIST_PHONES: `+91-${listedPhone}`,
            OUTBOUND_ALLOWLIST_EMAILS: listedEmail.toUpperCase(),
            OUTBOUND_ALLOWLIST_SLACK_WEBHOOKS: listedWebhook,
          },
    ),
    log: { warn: (event) => events.push(event) },
    directory: {
      order: async (id) => (id === '101' ? contacts(true) : id === '102' ? contacts(false) : null),
      customer: async (id) =>
        id === '201' ? contacts(true) : id === '202' ? contacts(false) : null,
    },
  });
  // Drop the one-off startup warning; cases assert on suppression events only.
  events.length = 0;
  return events;
}

/** A fetch double that records every request and answers with `reply()`. */
export function recordingFetch(reply: () => Response = () => new Response('{}')) {
  const requests: Recorded[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = init?.body;
    requests.push({
      url: input instanceof Request ? input.url : String(input),
      method: init?.method,
      body: body === undefined || body === null ? '' : String(body),
    });
    return reply();
  };
  return { requests, fetcher };
}
