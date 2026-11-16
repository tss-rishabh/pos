import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import {
  googleIssuer,
  googleSsoConfigured,
  googleSsoProvider,
  newSsoState,
  type SsoState,
} from '../src/auth/google-sso.js';

const clientId = '1234567890-fixture.apps.googleusercontent.com';
const config = readConfig({
  NODE_ENV: 'test',
  DEMO_MODE: 'true',
  SESSION_SECRET: 'google-sso-fixture-session-'.repeat(3),
  OIDC_ISSUER: googleIssuer,
  OIDC_CLIENT_ID: clientId,
  OIDC_CLIENT_SECRET: 'fixture-google-client-secret',
  OIDC_REDIRECT_URI: 'http://localhost:5173/api/v1/auth/sso/callback',
});
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: 'jwk' }),
  kid: 'fixture-rsa-key',
  alg: 'RS256',
  use: 'sig',
};
const metadata = {
  issuer: googleIssuer,
  authorization_endpoint: googleIssuer + '/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  token_endpoint_auth_methods_supported: ['client_secret_post'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
};
function callback(state: SsoState) {
  const url = new URL(config.OIDC_REDIRECT_URI!);
  url.search = new URLSearchParams({
    code: 'fixture-authorization-code',
    state: state.state,
    iss: googleIssuer,
  }).toString();
  return url;
}
function claims(state: SsoState): Record<string, unknown> {
  return {
    iss: googleIssuer,
    aud: clientId,
    sub: '1000000000001',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: state.nonce,
    email: 'operator@thesouledstore.com',
    email_verified: true,
    hd: 'thesouledstore.com',
  };
}
function signedToken(payload: Record<string, unknown>, tamper = false) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })).toString(
    'base64url',
  );
  const data = `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = sign('RSA-SHA256', Buffer.from(data), keys.privateKey);
  if (tamper) signature[0] = signature[0]! ^ 1;
  return `${data}.${signature.toString('base64url')}`;
}
function fixture(state: SsoState, payload = claims(state), tamper = false) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === googleIssuer + '/.well-known/openid-configuration') return Response.json(metadata);
    if (url === metadata.jwks_uri) return Response.json({ keys: [jwk] });
    if (url === metadata.token_endpoint)
      return Response.json({
        token_type: 'Bearer',
        access_token: 'fixture-google-access-token',
        expires_in: 600,
        id_token: signedToken(payload, tamper),
      });
    throw new Error('Only the fixture Google endpoints may be requested.');
  };
  return { calls, provider: googleSsoProvider(config, fetcher) };
}
describe('Google OIDC with actual openid-client and local RS256/JWKS responses', () => {
  it('builds the reference code/PKCE/select-account flow without a secret in the browser URL', async () => {
    const state = newSsoState(),
      local = fixture(state);
    const url = await local.provider.authorization(state);
    expect(url.origin + url.pathname).toBe(metadata.authorization_endpoint);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: clientId,
      redirect_uri: config.OIDC_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state: state.state,
      nonce: state.nonce,
      prompt: 'select_account',
      hd: 'thesouledstore.com',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(state.verifier).digest('base64url'),
    });
    expect(url.searchParams.has('client_secret')).toBe(false);
    expect(url.searchParams.has('code_verifier')).toBe(false);
    await local.provider.authorization(newSsoState());
    expect(local.calls.filter((call) => call.url.includes('openid-configuration'))).toHaveLength(1);
  });
  it('verifies signature/issuer/audience/state/nonce/PKCE and returns only verified work identity', async () => {
    const state = newSsoState(),
      local = fixture(state);
    expect(await local.provider.verify(callback(state), state)).toEqual({
      email: 'operator@thesouledstore.com',
      subject: '1000000000001',
      hostedDomain: 'thesouledstore.com',
    });
    const exchange = local.calls.find((call) => call.url === metadata.token_endpoint)!;
    const body = new URLSearchParams(String(exchange.init?.body));
    expect(Object.fromEntries(body)).toMatchObject({
      client_id: clientId,
      client_secret: config.OIDC_CLIENT_SECRET,
      code: 'fixture-authorization-code',
      code_verifier: state.verifier,
      redirect_uri: config.OIDC_REDIRECT_URI,
    });
    expect(local.calls.some((call) => call.url === metadata.jwks_uri)).toBe(true);
    expect(local.calls.some((call) => call.url.includes('userinfo'))).toBe(false);
    expect(
      local.calls.every(
        (call) => call.init?.redirect === 'error' && call.init.signal instanceof AbortSignal,
      ),
    ).toBe(true);
  });
  it.each([
    ['wrong issuer', { iss: 'https://attacker.example.test' }],
    ['wrong audience', { aud: 'different-client' }],
    ['wrong nonce', { nonce: 'wrong-nonce' }],
    ['expired token', { exp: 1 }],
    ['unverified email', { email_verified: false }],
    ['missing subject', { sub: '' }],
    ['unapproved domain', { email: 'operator@gmail.com', hd: 'gmail.com' }],
    ['lookalike email domain', { email: 'operator@thesouledstore.com.attacker.test' }],
    ['unapproved hosted domain', { hd: 'attacker.test' }],
    ['missing hosted domain', { hd: undefined }],
  ])('rejects %s without returning tokens or raw provider details', async (_name, change) => {
    const state = newSsoState(),
      local = fixture(state, { ...claims(state), ...change });
    await expect(local.provider.verify(callback(state), state)).rejects.toMatchObject({
      status: expect.any(Number),
    });
  });
  it('rejects a cryptographically invalid token, altered callback state and expired handshake', async () => {
    const state = newSsoState();
    await expect(
      fixture(state, claims(state), true).provider.verify(callback(state), state),
    ).rejects.toMatchObject({ code: 'SSO_AUTHENTICATION_FAILED' });
    const altered = callback(state);
    altered.searchParams.set('state', 'wrong-state');
    await expect(fixture(state).provider.verify(altered, state)).rejects.toMatchObject({
      code: 'SSO_AUTHENTICATION_FAILED',
    });
    await expect(
      fixture(state).provider.verify(callback(state), { ...state, expires: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_SSO_STATE' });
  });
  it('fails closed for arbitrary providers, missing credentials and unsafe redirect URLs', async () => {
    for (const candidate of [
      { ...config, OIDC_ISSUER: 'https://attacker.example.test' },
      { ...config, OIDC_CLIENT_SECRET: undefined },
      { ...config, OIDC_EMAIL_DOMAINS: [] },
      {
        ...config,
        OIDC_REDIRECT_URI: 'https://user:password@example.test/api/v1/auth/sso/callback',
      },
      { ...config, OIDC_REDIRECT_URI: 'https://example.test/unknown' },
      {
        ...config,
        NODE_ENV: 'production' as const,
        OIDC_REDIRECT_URI: 'https://other.example.test/api/v1/auth/sso/callback',
      },
    ]) {
      expect(googleSsoConfigured(candidate)).toBe(false);
      await expect(
        googleSsoProvider(candidate, async () => {
          throw new Error('Must not dispatch');
        }).authorization(newSsoState()),
      ).rejects.toMatchObject({ code: 'SSO_UNAVAILABLE' });
    }
  });
});
