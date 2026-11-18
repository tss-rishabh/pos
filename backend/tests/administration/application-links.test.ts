import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  readApplicationLinkOptions,
  safeApplicationDestination,
} from '../../src/modules/application-links/contracts.js';
import {
  applicationDigest,
  applicationToken,
  packageQrExpiry,
  scanWallTime,
} from '../../src/modules/application-links/domain.js';
import {
  createCustomerApplicationProvider,
  createStaffApplicationPackage,
} from '../../src/modules/application-links/provider.js';
import { goldenStdout } from '../golden/load.js';

const oracle = (cases: readonly unknown[]) =>
  JSON.parse(
    goldenStdout('administration', 'application-links', JSON.stringify({ cases })),
  ) as unknown;
describe('application QR and download boundaries', () => {
  it('matches the source aligned QR expiration across periods, boundaries and source display zones', () => {
    const cases = [30, 31, 60, 90, 120, 300].flatMap((period) =>
      [0, 1, 999, period * 1000 - 1, period * 1000, 1794820800123].flatMap((timestamp) =>
        ['UTC', 'Asia/Kolkata'].map((zone) => ({
          operation: 'staff-context',
          period,
          timestamp,
          zone,
        })),
      ),
    );
    const result = z
      .object({ cases: z.array(z.object({ expiresAt: z.number() })) })
      .parse(oracle(cases));
    for (const [index, value] of cases.entries())
      expect(packageQrExpiry(value.timestamp, value.period)).toBe(result.cases[index]!.expiresAt);
    expect(cases).toHaveLength(72);
  });
  it('keeps capabilities purpose-separated and opaque without account contacts or decoded JSON', () => {
    const secret = 'fixture-signing-secret'.repeat(3),
      values = ['1', 'fixture-nonce', 'epoch'];
    const first = applicationToken(secret, 'staff-qr', values);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(applicationToken(secret, 'customer-qr', values)).not.toBe(first);
    expect(applicationToken(secret, 'staff-qr', [...values, 'different'])).not.toBe(first);
    expect(applicationDigest(secret, 'qr', first)).not.toContain(first);
  });
  it('requires explicit package/provider configuration and exact trusted HTTPS destinations', () => {
    expect(
      createStaffApplicationPackage({ DEMO_MODE: false }, readApplicationLinkOptions({})),
    ).toBe(undefined);
    expect(
      createCustomerApplicationProvider({ DEMO_MODE: false }, readApplicationLinkOptions({})),
    ).toBe(undefined);
    expect(() =>
      readApplicationLinkOptions({ APP_APK_URL: 'http://cdn.example.test/m.apk' }),
    ).toThrow();
    expect(() =>
      readApplicationLinkOptions({ MAIN_SITE_API_V2: 'https://api.example.test/v2/?key=1' }),
    ).toThrow();
    const origins = ['https://www.thesouledstore.com'];
    for (const value of [
      'javascript:alert(1)',
      'http://www.thesouledstore.com',
      'https://attacker.example.test',
      'https://user:secret@www.thesouledstore.com',
      'https://www.thesouledstore.com/?token=secret',
      'https://www.thesouledstore.com/#secret',
      'https://www.thesouledstore.com/?store_id=2147483648',
    ])
      expect(safeApplicationDestination(value, origins)).toBe(false);
    expect(safeApplicationDestination('https://www.thesouledstore.com/?store_id=1', origins)).toBe(
      true,
    );
  });
  it('matches source customer-link body/fallback branches against MAIN_SITE_API_V2', async () => {
    const cases = [
      {
        operation: 'customer-link',
        storeId: '1',
        timestamp: 1794820800123,
        zone: 'Asia/Kolkata',
        shortLink: 'https://www.thesouledstore.com/app/fixture',
      },
      { operation: 'customer-link', storeId: '1', shortLink: null },
      { operation: 'customer-link', storeId: '1', objectPresent: false },
      {
        operation: 'customer-link',
        storeId: '1',
        cached: 'https://www.thesouledstore.com/app/cache',
      },
    ];
    const source = z
      .object({
        cases: z.array(
          z.object({
            destination: z.string(),
            scannedAt: z.string(),
            requests: z.array(z.object({ body: z.object({ link: z.string() }) })),
            cacheSets: z.array(z.object({ seconds: z.number() })),
          }),
        ),
      })
      .parse(oracle(cases));
    let index = 0;
    const requests: RequestInit[] = [],
      urls: string[] = [];
    const options = readApplicationLinkOptions({
      MAIN_SITE_API_V2: 'https://api.example.test/v2/',
    });
    const provider = createCustomerApplicationProvider(
      { DEMO_MODE: false },
      options,
      async (url, init) => {
        urls.push(String(url));
        requests.push(init!);
        const current = cases[index++]!;
        return Response.json(
          'objectPresent' in current
            ? {}
            : { object: { shortLink: 'shortLink' in current ? current.shortLink : undefined } },
        );
      },
    )!;
    for (let i = 0; i < 3; i++) {
      expect(await provider.destination('1')).toBe(source.cases[i]!.destination);
      expect(urls[i]).toBe('https://api.example.test/v2/firebase-dynamic-link');
      expect(JSON.parse(String(requests[i]?.body))).toEqual(source.cases[i]!.requests[0]!.body);
      expect(requests[i]?.redirect).toBe('error');
      expect(requests[i]?.credentials).toBe('omit');
      expect(new Headers(requests[i]?.headers).get('content-type')).toBe('application/json');
      expect(source.cases[i]!.cacheSets[0]?.seconds).toBe(3600);
    }
    expect(source.cases[3]?.requests).toHaveLength(0);
    expect(scanWallTime(1794820800123, 'Asia/Kolkata')).toBe(source.cases[0]?.scannedAt);
  });
  it('replaces untrusted redirect destinations by the fallback and rejects malformed/oversized responses and network errors', async () => {
    const options = readApplicationLinkOptions({
      MAIN_SITE_API_V2: 'https://api.example.test/v2/',
    });
    expect(
      await createCustomerApplicationProvider({ DEMO_MODE: false }, options, async () =>
        Response.json({ object: { shortLink: 'https://attacker.example.test' } }),
      )!.destination('1'),
    ).toBe('https://www.thesouledstore.com');
    for (const response of [
      new Response('not-json'),
      new Response('x'.repeat(40000)),
      new Response('private@example.test', { status: 500 }),
    ]) {
      const provider = createCustomerApplicationProvider(
        { DEMO_MODE: false },
        options,
        async () => response,
      )!;
      await expect(provider.destination('1')).rejects.toMatchObject({
        code: 'CUSTOMER_APPLICATION_UNAVAILABLE',
        message: 'The customer application link is temporarily unavailable.',
      });
    }
    const provider = createCustomerApplicationProvider({ DEMO_MODE: false }, options, async () => {
      throw new Error('private@example.test');
    })!;
    await expect(provider.destination('1')).rejects.toMatchObject({
      code: 'CUSTOMER_APPLICATION_UNAVAILABLE',
    });
  });
  it('streams APP_APK_URL as the legacy download link and refuses failed upstream responses', async () => {
    const options = readApplicationLinkOptions({
      APP_APK_URL: 'https://cdn.example.test/mpos.apk',
    });
    const requested: string[] = [];
    const source = createStaffApplicationPackage({ DEMO_MODE: false }, options, async (url) => {
      requested.push(String(url));
      return new Response('PK\x03\x04synthetic', {
        headers: {
          'content-type': 'application/vnd.android.package-archive',
          'content-length': '13',
        },
      });
    })!;
    const opened = await source.open(),
      chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('PK\x03\x04synthetic');
    expect(opened).toMatchObject({
      contentType: 'application/vnd.android.package-archive',
      contentLength: '13',
    });
    expect(requested).toEqual(['https://cdn.example.test/mpos.apk']);
    const failing = createStaffApplicationPackage(
      { DEMO_MODE: false },
      options,
      async () => new Response('missing', { status: 404 }),
    )!;
    await expect(failing.open()).rejects.toMatchObject({ code: 'STAFF_PACKAGE_UNAVAILABLE' });
  });
});
