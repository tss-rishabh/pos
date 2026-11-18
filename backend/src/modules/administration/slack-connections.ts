import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { assertCurrentOperatorRole } from './authorization.js';
import type { SlackConnectionOptions } from './slack-provider.js';

/** Legacy `SLACK_CONNECT_BROADCAST_CHANNEL` (`helpers/slack_helpers.py:14`). */
export const slackBroadcastChannel = 'tss-slack-connect';
/** Legacy `SLACK_OAUTH_STATE_MAX_AGE = 600` (`helpers/slack_helpers.py:11`). */
export const slackStateSeconds = 600;
export const slackStateKey = (state: string) =>
  `pos:slack_oauth:${createHash('sha256').update(state).digest('hex')}`;

export const slackConnectInput = z
  .object({
    nonce: z
      .string()
      .regex(/^[A-Za-z0-9]{0,64}$/)
      .default(''),
  })
  .strict();
export const slackCallbackInput = z.object({
  state: z.string().max(256).default(''),
  code: z.string().max(2048).default(''),
  error: z.string().max(256).optional(),
});
const pendingState = z
  .object({ userId: z.string(), nonce: z.string(), sessionBinding: z.string() })
  .strict();

/** `slack_callback_result` (`stores/views.py:310-312`): rendered into the popup. */
export interface SlackConnectResult {
  ok: boolean;
  error: string | null;
  url: string | null;
  channel: string | null;
  nonce: string | null;
}
const failure = (nonce: string | null, error: string): SlackConnectResult => ({
  ok: false,
  error,
  url: null,
  channel: null,
  nonce,
});

/**
 * Legacy Slack connect (`stores/views.py:315-347`, `helpers/slack_helpers.py`): a popup obtains an
 * incoming webhook and hands it to the store form, which the operator must then save. Nothing is
 * written to `stores` here. The signed legacy state is replaced by a single-use Redis state
 * (`pos:slack_oauth:{sha256(state)}`, EX 600) bound to the operator and the session cookie.
 */
export function slackConnectionService(
  _config: Config,
  db: Databases,
  options: SlackConnectionOptions,
  ephemeral: EphemeralStore,
) {
  const provider = options.slackOAuth;
  async function administrator(user: Principal) {
    await db.get('writer').transaction((tx) => assertCurrentOperatorRole(tx, user.id, [1, 3]));
  }
  return {
    /** `SlackConnectView.get`: returns the Slack authorize URL, or the legacy configuration error. */
    async start(
      user: Principal,
      input: z.infer<typeof slackConnectInput>,
      sessionBinding: string,
    ): Promise<{ redirect: string } | { result: SlackConnectResult }> {
      await administrator(user);
      if (!provider)
        return {
          result: failure(
            input.nonce,
            'Slack app is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
          ),
        };
      const state = randomBytes(32).toString('base64url');
      const stored = await ephemeral.set(
        slackStateKey(state),
        JSON.stringify({ userId: user.id, nonce: input.nonce, sessionBinding }),
        { NX: true, EX: slackStateSeconds },
      );
      if (!stored)
        throw new AppError(
          503,
          'SLACK_CONNECTION_UNAVAILABLE',
          'Start the Slack connection again.',
        );
      return { redirect: provider.authorize(state) };
    },
    /** `SlackCallbackView.get`: legacy checks and messages, in legacy order. */
    async complete(
      user: Principal,
      input: z.infer<typeof slackCallbackInput>,
      sessionBinding: string,
      signal?: AbortSignal,
    ): Promise<SlackConnectResult> {
      await administrator(user);
      const key = slackStateKey(input.state),
        raw = input.state ? await ephemeral.get(key) : null;
      // Single use: only the caller that removes the state may continue.
      const claimed = raw !== null && (await ephemeral.delIfEquals(key, raw));
      let pending: z.infer<typeof pendingState> | null = null;
      if (claimed) {
        try {
          pending = pendingState.parse(JSON.parse(raw) as unknown);
        } catch {
          pending = null;
        }
      }
      if (!pending)
        return failure(null, 'Slack connect link expired or is invalid. Please try again.');
      const nonce = pending.nonce;
      if (pending.userId !== user.id || pending.sessionBinding !== sessionBinding)
        return failure(nonce, 'Slack connect was started by a different user. Please try again.');
      if (input.error) return failure(nonce, `Slack connect cancelled: ${input.error}`);
      if (!provider)
        return failure(
          nonce,
          'Slack app is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
        );
      const grant = await provider.exchange(input.code, signal);
      if (!grant.ok) return failure(nonce, grant.error);
      return { ok: true, error: null, url: grant.webhook, channel: grant.channel, nonce };
    },
  };
}

/**
 * @deprecated The `pos_rewrite_slack_connections` table is gone; Redis states expire by TTL.
 * Kept as a no-op only because `src/auth/security-worker.ts` (W3) still calls it.
 */
export async function pruneSlackConnections(_db: Databases, _now = Date.now()): Promise<void> {}
