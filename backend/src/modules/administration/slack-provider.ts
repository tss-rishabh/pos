import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { AppError } from '../../domain/errors.js';
import { boundedJson } from '../../domain/http-json.js';
import { slackWebhook } from './slack-url.js';

const optional = (schema: z.ZodType<string>) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
export const slackTeamId = z.string().regex(/^T[A-Z0-9]{8,32}$/);
export function readSlackOAuthOptions(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      SLACK_OAUTH_ENABLED: z.preprocess(
        (value) =>
          value === undefined ? false : value === 'true' ? true : value === 'false' ? false : value,
        z.boolean(),
      ),
      SLACK_CLIENT_ID: optional(z.string().regex(/^\d+\.\d+$/)),
      SLACK_CLIENT_SECRET: optional(
        z
          .string()
          .min(16)
          .max(512)
          .regex(/^[A-Za-z0-9_-]+$/),
      ),
      SLACK_OAUTH_REDIRECT_URI: optional(z.url().max(2048)),
      SLACK_OAUTH_TEAM_IDS: z
        .string()
        .max(2000)
        .default('')
        .transform((value) =>
          value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
        )
        .pipe(z.array(slackTeamId).max(20)),
    })
    .parse(env);
}
export interface SlackOAuthGrant {
  webhook: string;
  channel: string;
  channelId: string;
  teamId: string;
}
export interface SlackOAuthProvider {
  readonly configurationVersion: string;
  authorize(state: string): string;
  exchange(code: string, signal?: AbortSignal): Promise<SlackOAuthGrant>;
}
export interface SlackConnectionOptions {
  slackOAuth?: SlackOAuthProvider;
}
const result = z.object({
  ok: z.literal(true),
  scope: z.string().max(2048),
  team: z.object({ id: slackTeamId }),
  incoming_webhook: z.object({
    url: slackWebhook,
    channel: z.string().min(1).max(255),
    channel_id: z.string().regex(/^[CG][A-Z0-9]{8,32}$/),
  }),
});
export function createSlackOAuthProvider(
  config: Pick<Config, 'NODE_ENV' | 'DEMO_MODE' | 'WEB_ORIGIN' | 'SESSION_SECRET'>,
  options: ReturnType<typeof readSlackOAuthOptions>,
  fetcher: typeof fetch = fetch,
): SlackOAuthProvider | undefined {
  if (!options.SLACK_OAUTH_ENABLED || config.DEMO_MODE) return undefined;
  const {
    SLACK_CLIENT_ID: clientId,
    SLACK_CLIENT_SECRET: secret,
    SLACK_OAUTH_REDIRECT_URI: redirectUri,
  } = options;
  const invalid = () =>
    new AppError(
      503,
      'SLACK_OAUTH_CONFIGURATION_INVALID',
      'Configure the approved Slack app, callback and workspace IDs.',
    );
  if (!clientId || !secret || !redirectUri || !options.SLACK_OAUTH_TEAM_IDS.length) throw invalid();
  const uri = new URL(redirectUri),
    web = new URL(config.WEB_ORIGIN);
  if (
    uri.protocol !== 'https:' ||
    uri.origin !== web.origin ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    uri.pathname !== '/api/v1/admin/slack/oauth/callback'
  )
    throw invalid();
  return {
    configurationVersion: createHmac('sha256', config.SESSION_SECRET + ':slack-configuration')
      .update(
        JSON.stringify([clientId, secret, redirectUri, [...options.SLACK_OAUTH_TEAM_IDS].sort()]),
      )
      .digest('hex'),
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
      try {
        z.string()
          .min(1)
          .max(2048)
          .regex(/^[A-Za-z0-9._-]+$/)
          .parse(code);
        const response = await fetcher('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(clientId + ':' + secret).toString('base64'),
          },
          body: new URLSearchParams({
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }).toString(),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error('rejected');
        }
        const grant = result.parse(await boundedJson(response, 32768));
        if (
          !grant.scope.split(',').includes('incoming-webhook') ||
          !options.SLACK_OAUTH_TEAM_IDS.includes(grant.team.id)
        )
          throw new Error('scope');
        return {
          webhook: grant.incoming_webhook.url,
          channel: grant.incoming_webhook.channel,
          channelId: grant.incoming_webhook.channel_id,
          teamId: grant.team.id,
        };
      } catch {
        throw new AppError(
          503,
          'SLACK_OAUTH_EXCHANGE_FAILED',
          'Slack authorization could not be completed. Start a new connection.',
        );
      }
    },
  };
}
