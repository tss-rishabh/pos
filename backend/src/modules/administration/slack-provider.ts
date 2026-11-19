import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { slackWebhook } from './slack-url.js';

const optional = (schema: z.ZodType<string>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
/** Legacy settings `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_OAUTH_REDIRECT_URI`. */
export function readSlackOAuthOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      SLACK_CLIENT_ID: optional(z.string().regex(/^\d+\.\d+$/)),
      SLACK_CLIENT_SECRET: optional(
        z
          .string()
          .min(16)
          .max(512)
          .regex(/^[A-Za-z0-9_-]+$/),
      ),
      SLACK_OAUTH_REDIRECT_URI: optional(z.url().max(2048)),
    })
    .parse(env);
}
export type SlackOAuthExchange =
  { ok: true; webhook: string; channel: string } | { ok: false; error: string };
export interface SlackOAuthProvider {
  authorize(state: string): string;
  exchange(code: string, signal?: AbortSignal): Promise<SlackOAuthExchange>;
}
export interface SlackConnectionOptions {
  slackOAuth?: SlackOAuthProvider;
}
export const slackCallbackPath = '/api/v1/admin/slack/oauth/callback';
const response = z.object({
  ok: z.boolean().optional(),
  error: z.string().max(256).optional(),
  incoming_webhook: z
    .object({ url: z.string().max(1000).optional(), channel: z.string().max(255).optional() })
    .optional(),
});
/** Slack error codes are short identifiers; anything else is not echoed (`slack_helpers.py:56`). */
const slackErrorCode = /^[a-z0-9_]{1,64}$/;

/**
 * Legacy `helpers/slack_helpers.py`: authorize with scope `incoming-webhook`, then exchange the
 * code at `oauth.v2.access` (10 s timeout). Undefined (not configured) without a client id and
 * secret, as `SlackConnectView` (`stores/views.py:315-323`).
 */
export function createSlackOAuthProvider(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE' | 'WEB_ORIGIN'>,
  options: ReturnType<typeof readSlackOAuthOptions>,
  fetcher: typeof fetch = fetch,
): SlackOAuthProvider | undefined {
  const { SLACK_CLIENT_ID: clientId, SLACK_CLIENT_SECRET: secret } = options;
  if (config.DEMO_MODE || !clientId || !secret) return undefined;
  const web = new URL(config.WEB_ORIGIN),
    redirectUri = options.SLACK_OAUTH_REDIRECT_URI || new URL(slackCallbackPath, web).href,
    uri = new URL(redirectUri);
  // The authorization code must only ever reach this application's own callback.
  if (
    (uri.protocol !== 'https:' && config.NODE_ENV === 'production') ||
    uri.origin !== web.origin ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    uri.pathname !== slackCallbackPath
  )
    throw new AppError(
      503,
      'SLACK_OAUTH_CONFIGURATION_INVALID',
      'Configure SLACK_OAUTH_REDIRECT_URI as this application’s Slack callback.',
    );
  return {
    authorize(state) {
      z.string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(state);
      const url = new URL('https://slack.com/oauth/v2/authorize');
      url.search = new URLSearchParams({
        client_id: clientId,
        scope: 'incoming-webhook',
        redirect_uri: redirectUri,
        state,
      }).toString();
      return url.href;
    },
    async exchange(code, signal) {
      let data: z.infer<typeof response>;
      try {
        const reply = await fetcher('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
          },
          body: new URLSearchParams({ code, redirect_uri: redirectUri }).toString(),
        });
        data = response.parse(await boundedJson(reply, 32768));
      } catch {
        return { ok: false, error: 'Could not reach Slack. Please try again.' };
      }
      const webhook = data.incoming_webhook?.url;
      if (!data.ok || !webhook || !slackWebhook.safeParse(webhook).success)
        return {
          ok: false,
          error: `Slack connect failed: ${
            data.error && slackErrorCode.test(data.error) ? data.error : 'no webhook returned'
          }`,
        };
      return { ok: true, webhook, channel: data.incoming_webhook?.channel || '' };
    },
  };
}
