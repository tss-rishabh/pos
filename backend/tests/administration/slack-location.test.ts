import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createSlackOAuthProvider,
  readSlackOAuthOptions,
} from '../../src/modules/administration/slack-provider.js';
import { sourceCityTitle } from '../../src/modules/administration/location-title.js';
import { postalLookupInput } from '../../src/modules/administration/locations.js';
import { goldenStdout } from '../golden/load.js';

const config = {
  NODE_ENV: 'test' as const,
  DEMO_MODE: false,
  WEB_ORIGIN: 'https://pos.example.test',
  SESSION_SECRET: 'isolated-slack-fixture-'.repeat(3),
};
const options = (extra: Record<string, string> = {}) =>
  readSlackOAuthOptions({
    SLACK_OAUTH_ENABLED: 'true',
    SLACK_CLIENT_ID: '1234.5678',
    SLACK_CLIENT_SECRET: 'synthetic_private_secret_1234',
    SLACK_OAUTH_REDIRECT_URI: 'https://pos.example.test/api/v1/admin/slack/oauth/callback',
    SLACK_OAUTH_TEAM_IDS: 'T0123456789',
    ...extra,
  });
const grant = {
  ok: true,
  scope: 'incoming-webhook',
  team: { id: 'T0123456789' },
  incoming_webhook: {
    url: 'https://hooks.slack.com/services/T0123456789/B0123456789/privateFixtureWebhook',
    channel: '#fixture-sales',
    channel_id: 'C0123456789',
  },
  access_token: 'private-token-canary',
};
describe('Slack OAuth and source location boundaries', () => {
  it('defaults disabled and rejects unconfigured origins or unapproved workspace scope', () => {
    expect(createSlackOAuthProvider(config, readSlackOAuthOptions({}))).toBeUndefined();
    expect(createSlackOAuthProvider({ ...config, DEMO_MODE: true }, options())).toBeUndefined();
    for (const uri of [
      'http://pos.example.test/api/v1/admin/slack/oauth/callback',
      'https://evil.example.test/api/v1/admin/slack/oauth/callback',
      'https://pos.example.test/api/v1/admin/slack/oauth/callback?secret=query',
      'https://pos.example.test/other',
    ])
      expect(() =>
        createSlackOAuthProvider(config, options({ SLACK_OAUTH_REDIRECT_URI: uri })),
      ).toThrow('approved Slack app');
    expect(() => createSlackOAuthProvider(config, options({ SLACK_OAUTH_TEAM_IDS: '' }))).toThrow(
      'approved Slack app',
    );
  });
  it('preserves source authorize scope/client/callback while using opaque state without actor/contact claims', () => {
    const state = 's'.repeat(43),
      provider = createSlackOAuthProvider(config, options())!;
    const reference = z
      .array(
        z.object({ url: z.string(), state: z.object({ user_id: z.number(), nonce: z.string() }) }),
      )
      .parse(
        JSON.parse(
          goldenStdout(
            'administration',
            'slack-location',
            JSON.stringify({
              operation: 'slack-authorize',
              cases: [
                {
                  clientId: '1234.5678',
                  redirectUri: options().SLACK_OAUTH_REDIRECT_URI,
                  actorId: 123,
                  nonce: 'fixture-nonce',
                  state,
                },
              ],
            }),
          ),
        ) as unknown,
      )[0]!;
    expect(new URL(provider.authorize(state)).searchParams).toEqual(
      new URL(reference.url).searchParams,
    );
    expect(provider.authorize(state)).not.toMatch(
      /fixture-nonce|user_id|private_secret|example\.test.*email/,
    );
    expect(reference.state).toEqual({ user_id: 123, nonce: 'fixture-nonce' });
  });
  it('exchanges by bounded confidential POST, validates granted workspace and returns only the webhook contract', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [],
      provider = createSlackOAuthProvider(config, options(), async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(grant);
      })!;
    expect(await provider.exchange('synthetic.code')).toEqual({
      webhook: grant.incoming_webhook.url,
      channel: '#fixture-sales',
      channelId: 'C0123456789',
      teamId: 'T0123456789',
    });
    expect(calls[0]?.url).toBe('https://slack.com/api/oauth.v2.access');
    expect(calls[0]?.init?.redirect).toBe('error');
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get('code')).toBe('synthetic.code');
    expect(body.get('redirect_uri')).toBe(options().SLACK_OAUTH_REDIRECT_URI);
    expect(body.has('client_secret')).toBe(false);
    expect(body.has('code_verifier')).toBe(false);
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(
      'Basic ' + Buffer.from('1234.5678:synthetic_private_secret_1234').toString('base64'),
    );
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('never leaks provider error payloads, oversized responses, foreign webhooks or unexpected workspaces', async () => {
    const cases = [
      Response.json({ ok: false, error: 'private@example.test' }),
      Response.json({ ...grant, team: { id: 'T9999999999' } }),
      Response.json({
        ...grant,
        incoming_webhook: { ...grant.incoming_webhook, url: 'https://127.0.0.1/private' },
      }),
      Response.json({ ...grant, scope: 'chat:write' }),
      new Response('x'.repeat(32769)),
      new Response('private-token-canary', {
        status: 302,
        headers: { Location: 'https://evil.example.test' },
      }),
    ];
    for (const response of cases) {
      const provider = createSlackOAuthProvider(config, options(), async () => response)!;
      await expect(provider.exchange('synthetic-code')).rejects.toMatchObject({
        code: 'SLACK_OAUTH_EXCHANGE_FAILED',
        message: 'Slack authorization could not be completed. Start a new connection.',
      });
    }
  });
  it('matches the exact source Python city title behavior across Latin1, Unicode exceptions and cased boundaries', () => {
    const names = [
      'mUMBAI',
      'navi-mumbai',
      "o'brien",
      'straße',
      'ǆAKOVO',
      'ΟΣ',
      'ΟΣΑ',
      'aΣ.',
      'e\u0301clair',
      'ßBURG',
      'ﬃCITY',
      'mumbai123west',
      '',
      '汉字',
    ];
    for (let value = 0; value < 256; value++)
      names.push(String.fromCodePoint(value) + 'a B' + String.fromCodePoint(value));
    const cases = names.map((city) => ({
      pincode: '400001',
      row: ['1', '400001', city, 'Fixture state', 'Fixture country', 1, '19.000', '72.000', 2],
    }));
    const reference = z
      .array(
        z.object({
          response: z.object({ data: z.object({ city: z.string() }) }),
          parameters: z.array(z.string()),
        }),
      )
      .parse(
        JSON.parse(
          goldenStdout(
            'administration',
            'slack-location',
            JSON.stringify({ operation: 'postal-lookup', cases }),
          ),
        ) as unknown,
      );
    expect(names.map(sourceCityTitle)).toEqual(reference.map((row) => row.response.data.city));
    expect(reference.every((row) => row.parameters[0] === '400001')).toBe(true);
    for (const postalCode of [
      '',
      'x'.repeat(33),
      '-400001',
      '400001-',
      "400001' OR 1=1",
      '１２３４５６',
    ])
      expect(postalLookupInput.safeParse({ postalCode }).success).toBe(false);
    for (const postalCode of ['400001', 'SW1A 1AA', '90210', '40000', '000000'])
      expect(postalLookupInput.safeParse({ postalCode }).success).toBe(true);
  });
});
