import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApplicationPackage } from '../../src/modules/application-links/artifact.js';
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
import { createCustomerApplicationProvider } from '../../src/modules/application-links/provider.js';
import { goldenStdout } from '../golden/load.js';

const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const oracle = (cases: readonly unknown[]) =>
  JSON.parse(
    goldenStdout('administration', 'application-links', JSON.stringify({ cases })),
  ) as unknown;
describe('application QR and download boundaries', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });
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
    expect(readApplicationLinkOptions({}).POS_STAFF_APK_ENABLED).toBe(false);
    expect(readApplicationLinkOptions({}).POS_CUSTOMER_APP_MODE).toBe('disabled');
    expect(() => readApplicationLinkOptions({ POS_STAFF_APK_ENABLED: 'true' })).toThrow();
    expect(() =>
      readApplicationLinkOptions({
        POS_CUSTOMER_APP_MODE: 'provider',
        POS_CUSTOMER_APP_LINK_ENDPOINT: 'https://api.example.test/link',
      }),
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
  it('matches source customer-link body/fallback/cache branches while adding provider idempotency and response bounds', async () => {
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
    const requests: RequestInit[] = [];
    const options = readApplicationLinkOptions({
      POS_CUSTOMER_APP_MODE: 'provider',
      POS_CUSTOMER_APP_LINK_ENDPOINT: 'https://api.example.test/v2/firebase-dynamic-link',
      POS_CUSTOMER_APP_LINK_CONTRACT: 'verified-pos-app-link-v1',
    });
    const provider = createCustomerApplicationProvider(
      { DEMO_MODE: false },
      options,
      async (_url, init) => {
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
      expect(await provider.destination('1', randomUUID())).toBe(source.cases[i]!.destination);
      expect(JSON.parse(String(requests[i]?.body))).toEqual(source.cases[i]!.requests[0]!.body);
      expect(requests[i]?.redirect).toBe('error');
      expect(requests[i]?.credentials).toBe('omit');
      expect(new Headers(requests[i]?.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
      expect(source.cases[i]!.cacheSets[0]?.seconds).toBe(3600);
    }
    expect(source.cases[3]?.requests).toHaveLength(0);
    expect(scanWallTime(1794820800123, 'Asia/Kolkata')).toBe(source.cases[0]?.scannedAt);
  });
  it('rejects untrusted redirect destinations, malformed/oversized provider responses and network errors without raw details', async () => {
    const options = readApplicationLinkOptions({
      POS_CUSTOMER_APP_MODE: 'provider',
      POS_CUSTOMER_APP_LINK_ENDPOINT: 'https://api.example.test/link',
      POS_CUSTOMER_APP_LINK_CONTRACT: 'verified-pos-app-link-v1',
    });
    for (const response of [
      Response.json({ object: { shortLink: 'https://attacker.example.test' } }),
      new Response('not-json'),
      new Response('x'.repeat(40000)),
      new Response('private@example.test', { status: 500 }),
    ]) {
      const provider = createCustomerApplicationProvider(
        { DEMO_MODE: false },
        options,
        async () => response,
      )!;
      await expect(provider.destination('1', randomUUID())).rejects.toMatchObject({
        code: 'CUSTOMER_APPLICATION_UNAVAILABLE',
        message: 'The customer application link is temporarily unavailable.',
      });
    }
    const provider = createCustomerApplicationProvider({ DEMO_MODE: false }, options, async () => {
      throw new Error('private@example.test');
    })!;
    await expect(provider.destination('1', randomUUID())).rejects.toMatchObject({
      code: 'CUSTOMER_APPLICATION_UNAVAILABLE',
    });
  });
  it('serves only a pinned verified private package snapshot and retains the approved source file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pos-application-artifact-test-'));
    directories.push(directory);
    const path = join(directory, 'approved.apk'),
      bytes = Buffer.from('PK\x03\x04synthetic-package-fixture');
    await writeFile(path, bytes);
    const options = readApplicationLinkOptions({
      POS_STAFF_APK_ENABLED: 'true',
      POS_STAFF_APK_PATH: path,
      POS_STAFF_APK_BYTES: String(bytes.length),
      POS_STAFF_APK_SHA256: digest(bytes),
    });
    const artifact = createApplicationPackage({ DEMO_MODE: false }, options)!;
    expect(await artifact.describe()).toEqual({
      filename: 'mpos.apk',
      bytes: bytes.length,
      checksum: digest(bytes),
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(artifact.open(cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await writeFile(path, 'changed-source-file');
    const opened = await artifact.open(),
      chunks: Buffer[] = [];
    for await (const chunk of opened.stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Package stream must be bytes.');
      chunks.push(chunk);
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await artifact.close();
    expect(await readFile(path, 'utf8')).toBe('changed-source-file');
    await expect(artifact.describe()).rejects.toMatchObject({ code: 'STAFF_PACKAGE_UNAVAILABLE' });
  });
  it('fails closed on symlinks, wrong size, wrong checksum and non-package content without exposing paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pos-application-artifact-test-'));
    directories.push(directory);
    const path = join(directory, 'approved.apk'),
      link = join(directory, 'symlink.apk'),
      bytes = Buffer.from('PK\x03\x04synthetic-package-fixture');
    await writeFile(path, bytes);
    await symlink(path, link);
    for (const changes of [
      { POS_STAFF_APK_PATH: link },
      { POS_STAFF_APK_BYTES: '4' },
      { POS_STAFF_APK_SHA256: '0'.repeat(64) },
    ]) {
      const artifact = createApplicationPackage(
        { DEMO_MODE: false },
        readApplicationLinkOptions({
          POS_STAFF_APK_ENABLED: 'true',
          POS_STAFF_APK_PATH: path,
          POS_STAFF_APK_BYTES: String(bytes.length),
          POS_STAFF_APK_SHA256: digest(bytes),
          ...changes,
        }),
      )!;
      await expect(artifact.describe()).rejects.toMatchObject({
        code: 'STAFF_PACKAGE_UNAVAILABLE',
        message: 'The staff application download is temporarily unavailable.',
      });
      await artifact.close();
    }
    await writeFile(path, 'not-an-application');
    const artifact = createApplicationPackage(
      { DEMO_MODE: false },
      readApplicationLinkOptions({
        POS_STAFF_APK_ENABLED: 'true',
        POS_STAFF_APK_PATH: path,
        POS_STAFF_APK_BYTES: '18',
        POS_STAFF_APK_SHA256: digest(Buffer.from('not-an-application')),
      }),
    )!;
    await expect(artifact.describe()).rejects.toMatchObject({ code: 'STAFF_PACKAGE_UNAVAILABLE' });
    await artifact.close();
  });
});
