import { outboundAllowlistEnabled, outboundPermitted } from '../../outbound/allowlist.js';

/**
 * Synchronous Slack incoming-webhook post, as legacy `Helpers.slack_text_notification`
 * (helpers/helpers.py:1093-1131): one POST with a 5 s timeout; a failure is reported to the
 * caller and never retried or raised, because legacy logs and drops it.
 *
 * Security (kept from the rewrite): only credential/query-free HTTPS `hooks.slack.com` URLs are
 * contacted, redirects are refused, and mention/link parsing and unfurls are disabled.
 */
export type SlackPoster = (url: string | undefined, text: string) => Promise<boolean>;
export function slackWebhookAllowed(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export const postSlackText: SlackPoster = async (url, text) => {
  if (!slackWebhookAllowed(url)) return false;
  // Allowlist guard (w25): a suppressed post reports success, as an accepted one does.
  if (
    outboundAllowlistEnabled() &&
    !(await outboundPermitted({
      channel: 'slack',
      module: 'operational-reports',
      flow: 'report-slack-post',
      targets: [{ kind: 'slack-webhook', value: url }],
    }))
  )
    return true;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        parse: 'none',
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
};
