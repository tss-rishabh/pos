import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHmac } from 'node:crypto';
import { goldenStdout } from '../golden/load.js';
import {
  legacyCustomerToken,
  legacyWebsiteUrl,
} from '../../src/modules/customer-website-handoff/service.js';
import { readCustomerWebsiteHandoffOptions } from '../../src/modules/customer-website-handoff/options.js';
describe('executed pinned website-handoff source oracle', () => {
  it('preserves original customer/store/operator identity facts while exposing the source URL credential flaw', () => {
    const result = z
      .object({
        pin: z.string(),
        sourceHashes: z.record(z.string(), z.string()),
        vectors: z.array(
          z.object({
            twoFactor: z.boolean(),
            algorithm: z.string(),
            prefix: z.boolean(),
            customerId: z.string(),
            expirySeconds: z.number(),
            path: z.string(),
            queryKeys: z.array(z.string()),
            storeId: z.string(),
            operatorCustomerId: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(goldenStdout('customer-website-handoff', 'source')) as unknown);
    expect(result.pin).toBe('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a');
    expect(result.vectors.map((v) => [v.algorithm, v.prefix, v.operatorCustomerId])).toEqual([
      ['HS256', false, '88'],
      ['HS512', true, '88'],
      ['HS256', false, '0'],
    ]);
    for (const vector of result.vectors) {
      expect(vector).toMatchObject({
        customerId: '7',
        storeId: '1',
        expirySeconds: 300,
        path: '/pos/login/',
      });
      expect(vector.queryKeys).toEqual(['api_key', 'pos_store_id', 'pos_user_id', 'token']);
    }
    expect(Object.keys(result.sourceHashes)).toHaveLength(2);
    const options = readCustomerWebsiteHandoffOptions({
      TSS_JWT_HS256_KEY: 'synthetic-hs256-key-'.repeat(3),
      TSS_JWT_HS512_KEY: 'synthetic-hs512-key-'.repeat(3),
      JWT_CUSTOM_EXPIRY_MIN: '5',
      WEB_URL: 'https://web.synthetic.invalid',
      WEB_LOGIN_API_KEY: 'synthetic-web-key',
    });
    const now = 1_763_520_000_250;
    for (const vector of result.vectors) {
      const url = new URL(
        legacyWebsiteUrl(
          options.WEB_URL,
          legacyCustomerToken(vector.customerId, vector.twoFactor, options, now),
          options.WEB_LOGIN_API_KEY,
          vector.storeId,
          vector.operatorCustomerId,
        ),
      );
      expect(url.pathname).toBe(vector.path);
      expect([...url.searchParams.keys()].sort()).toEqual(vector.queryKeys);
      expect(url.searchParams.get('pos_store_id')).toBe(vector.storeId);
      expect(url.searchParams.get('pos_user_id')).toBe(vector.operatorCustomerId);
      expect(url.searchParams.get('api_key')).toBe('synthetic-web-key');
      const token = url.searchParams.get('token')!;
      expect(token.startsWith('2f.')).toBe(vector.prefix);
      const [header, payload, signature] = token.replace(/^2f\./, '').split('.');
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
        alg: vector.algorithm,
        typ: 'JWT',
      });
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
        sub: string;
        iat: number;
        exp: number;
      };
      expect(Object.keys(claims)).toEqual(['sub', 'iat', 'exp']);
      expect(claims.sub).toBe(vector.customerId);
      expect(claims.exp - claims.iat).toBe(vector.expirySeconds);
      const key = vector.twoFactor ? options.TSS_JWT_HS512_KEY! : options.TSS_JWT_HS256_KEY!;
      expect(signature).toBe(
        createHmac(vector.twoFactor ? 'sha512' : 'sha256', key)
          .update(`${header}.${payload}`)
          .digest('base64url'),
      );
    }
  }, 20000);
});
