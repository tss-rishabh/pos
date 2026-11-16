import { AsyncLocalStorage } from 'node:async_hooks';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';

export const googleIssuer = 'https://accounts.google.com';
export const ssoStateSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
    expires: z.number().int().positive(),
    desktopFlowId: z.uuid().optional(),
  })
  .strict();
export type SsoState = z.infer<typeof ssoStateSchema>;
export interface GoogleIdentity {
  email: string;
  subject: string;
  hostedDomain: string | null;
}
export interface GoogleSsoProvider {
  authorization(state: SsoState): Promise<URL>;
  verify(callback: URL, state: SsoState): Promise<GoogleIdentity>;
}
function unavailable() {
  return new AppError(503, 'SSO_UNAVAILABLE', 'Google sign-in is not configured.');
}
export function googleSsoConfigured(config: Config): boolean {
  if (
    !config.OIDC_ISSUER ||
    !config.OIDC_CLIENT_ID ||
    !config.OIDC_CLIENT_SECRET ||
    !config.OIDC_REDIRECT_URI ||
    !config.OIDC_EMAIL_DOMAINS.length
  )
    return false;
  const issuer = new URL(config.OIDC_ISSUER),
    callback = new URL(config.OIDC_REDIRECT_URI);
  return (
    issuer.origin === googleIssuer &&
    issuer.pathname === '/' &&
    !issuer.search &&
    !issuer.hash &&
    !issuer.username &&
    !issuer.password &&
    !callback.username &&
    !callback.password &&
    !callback.search &&
    !callback.hash &&
    callback.pathname === '/api/v1/auth/sso/callback' &&
    (config.NODE_ENV === 'production'
      ? callback.protocol === 'https:' && callback.origin === new URL(config.WEB_ORIGIN).origin
      : callback.protocol === 'https:' ||
        (callback.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)))
  );
}
export function newSsoState(now = Date.now()): SsoState {
  return {
    state: oidc.randomState(),
    nonce: oidc.randomNonce(),
    verifier: oidc.randomPKCECodeVerifier(),
    expires: now + 600000,
  };
}

export function googleSsoProvider(
  config: Config,
  fetcher: typeof fetch = fetch,
): GoogleSsoProvider {
  let configuration: Promise<oidc.Configuration> | undefined;
  const budget = new AsyncLocalStorage<AbortSignal>();
  const allowed = new Set([
    googleIssuer + '/.well-known/openid-configuration',
    'https://oauth2.googleapis.com/token',
    'https://www.googleapis.com/oauth2/v3/certs',
  ]);
  async function provider(): Promise<oidc.Configuration> {
    if (!googleSsoConfigured(config)) throw unavailable();
    configuration ??= oidc
      .discovery(
        new URL(googleIssuer),
        config.OIDC_CLIENT_ID!,
        { client_secret: config.OIDC_CLIENT_SECRET!, id_token_signed_response_alg: 'RS256' },
        oidc.ClientSecretPost(config.OIDC_CLIENT_SECRET!),
        {
          timeout: 5,
          execute: [oidc.enableNonRepudiationChecks],
          [oidc.customFetch]: async (input, init) => {
            if (!allowed.has(String(input))) throw unavailable();
            const signal = AbortSignal.any([
              AbortSignal.timeout(5000),
              budget.getStore() ?? AbortSignal.timeout(10000),
              ...(init?.signal ? [init.signal] : []),
            ]);
            const { body, ...transport } = init;
            return fetcher(input, {
              ...transport,
              body: body instanceof Uint8Array ? new Uint8Array(body).buffer : body,
              signal,
              redirect: 'error',
            });
          },
        },
      )
      .catch(() => {
        configuration = undefined;
        throw unavailable();
      });
    return configuration;
  }
  return {
    authorization(state) {
      return budget.run(AbortSignal.timeout(10000), async () => {
        const parsed = ssoStateSchema.parse(state),
          server = await provider();
        return oidc.buildAuthorizationUrl(server, {
          redirect_uri: config.OIDC_REDIRECT_URI!,
          scope: 'openid email profile',
          prompt: 'select_account',
          hd: config.OIDC_EMAIL_DOMAINS[0]!,
          state: parsed.state,
          nonce: parsed.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(parsed.verifier),
          code_challenge_method: 'S256',
        });
      });
    },
    verify(callback, state) {
      return budget.run(AbortSignal.timeout(10000), async () => {
        try {
          const saved = ssoStateSchema.parse(state);
          if (saved.expires <= Date.now())
            throw new AppError(400, 'INVALID_SSO_STATE', 'SSO session expired. Sign in again.');
          const tokens = await oidc.authorizationCodeGrant(await provider(), callback, {
            pkceCodeVerifier: saved.verifier,
            expectedState: saved.state,
            expectedNonce: saved.nonce,
          });
          const claims = z
            .object({
              sub: z.string().min(1).max(255),
              email: z.email().max(254),
              email_verified: z.literal(true),
              hd: z.string().min(1).max(253).optional(),
            })
            .parse(tokens.claims());
          const email = claims.email.toLowerCase(),
            domain = email.split('@')[1];
          if (
            !domain ||
            !config.OIDC_EMAIL_DOMAINS.includes(domain) ||
            (config.OIDC_REQUIRE_HOSTED_DOMAIN &&
              (!claims.hd || !config.OIDC_EMAIL_DOMAINS.includes(claims.hd.toLowerCase())))
          )
            throw new AppError(
              403,
              'SSO_DOMAIN_DENIED',
              'Use your approved work account to sign in.',
            );
          return { email, subject: claims.sub, hostedDomain: claims.hd?.toLowerCase() ?? null };
        } catch (error) {
          if (error instanceof AppError) throw error;
          throw new AppError(
            400,
            'SSO_AUTHENTICATION_FAILED',
            'Google sign-in could not be verified. Start sign-in again.',
          );
        }
      });
    },
  };
}
