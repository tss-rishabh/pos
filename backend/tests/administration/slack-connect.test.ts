import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import type { Databases } from '../../src/db/pools.js';
import type { Principal } from '../../src/domain/access.js';
import { memoryEphemeralStore } from '../../src/jobs/ephemeral.js';
import { slackConnectionService } from '../../src/modules/administration/slack-connections.js';
import type { SlackOAuthProvider } from '../../src/modules/administration/slack-provider.js';
import { slackCallbackPage } from '../../src/modules/administration/slack-routes.js';

// The current-role check runs inside the writer transaction; this fake skips it.
const db = { get: () => ({ transaction: async () => undefined }) } as unknown as Databases;
const user = (id: string): Principal => ({
  id,
  name: 'Fixture',
  email: 'fixture@example.test',
  role: 1,
  userType: 1,
  storeIds: [],
});
const provider: SlackOAuthProvider = {
  authorize: (state) => `https://slack.com/oauth/v2/authorize?state=${state}`,
  exchange: async (code) =>
    code === 'good'
      ? { ok: true, webhook: 'https://hooks.slack.com/services/T1/B1/x', channel: '#ops' }
      : { ok: false, error: 'Slack connect failed: invalid_code' },
};
const stateOf = (
  outcome: Awaited<ReturnType<ReturnType<typeof slackConnectionService>['start']>>,
) => ('redirect' in outcome ? new URL(outcome.redirect).searchParams.get('state')! : '');

describe('legacy Slack connect popup (stores/views.py:315-347)', () => {
  it('reports the legacy configuration error without a client id and secret', async () => {
    const service = slackConnectionService({} as Config, db, {}, memoryEphemeralStore());
    expect(await service.start(user('1'), { nonce: 'n1' }, 'b')).toEqual({
      result: {
        ok: false,
        error: 'Slack app is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
        url: null,
        channel: null,
        nonce: 'n1',
      },
    });
  });
  it('binds a single-use state to the operator and session, returning legacy messages', async () => {
    const store = memoryEphemeralStore(),
      service = slackConnectionService({} as Config, db, { slackOAuth: provider }, store);
    const state = stateOf(await service.start(user('1'), { nonce: 'n1' }, 'session-a'));
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await service.complete(user('2'), { state, code: 'good' }, 'session-a')).toMatchObject({
      ok: false,
      error: 'Slack connect was started by a different user. Please try again.',
      nonce: 'n1',
    });
    // The state was consumed by the first callback.
    expect(await service.complete(user('1'), { state, code: 'good' }, 'session-a')).toMatchObject({
      ok: false,
      error: 'Slack connect link expired or is invalid. Please try again.',
      nonce: null,
    });
    const next = stateOf(await service.start(user('1'), { nonce: 'n2' }, 'session-a'));
    expect(
      await service.complete(
        user('1'),
        { state: next, code: '', error: 'access_denied' },
        'session-a',
      ),
    ).toMatchObject({ error: 'Slack connect cancelled: access_denied', nonce: 'n2' });
    const last = stateOf(await service.start(user('1'), { nonce: 'n3' }, 'session-a'));
    expect(await service.complete(user('1'), { state: last, code: 'good' }, 'session-a')).toEqual({
      ok: true,
      error: null,
      url: 'https://hooks.slack.com/services/T1/B1/x',
      channel: '#ops',
      nonce: 'n3',
    });
  });
  it('renders the popup result without markup injection', () => {
    const page = slackCallbackPage({
      ok: false,
      error: 'Slack connect cancelled: </script><img src=x>',
      url: null,
      channel: null,
      nonce: null,
    });
    expect(page).not.toContain('</script><img');
    expect(page).toContain('Slack connect cancelled: &lt;/script&gt;&lt;img src=x&gt;');
    expect(page).toContain('new BroadcastChannel("tss-slack-connect")');
  });
});
