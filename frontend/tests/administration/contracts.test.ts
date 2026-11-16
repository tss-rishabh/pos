import { afterEach, describe, expect, it, vi } from 'vitest';
import { guideAttachmentSchema } from '../../src/pages/administration/documentation-api';
import {
  operatorSchema,
  salespersonSchema,
  terminalSchema,
} from '../../src/pages/administration/api';
import { terminalDetailSchema } from '../../src/pages/administration/terminals';
import { downloadImportCsv, importJobSchema } from '../../src/pages/administration/import-api';
import {
  bufferDuration,
  ecommerceSettingSchema,
} from '../../src/pages/administration/settings-api';
import {
  activityColumns,
  activityPageCsv,
  activityResultSchema,
} from '../../src/pages/administration/permission-history-api';
import {
  applicationDownloadSession,
  applicationFragment,
} from '../../src/pages/administration/application-links/api';

describe('administration wire and attachment boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('accepts only opaque application fragments and rejects source-style contact JWT query payloads', () => {
    expect(applicationFragment('#' + 'A'.repeat(43))).toBe('A'.repeat(43));
    for (const value of [
      'fixture@example.test',
      '#header.payload.signature',
      '#token=secret',
      '#',
      '#' + 'A'.repeat(44),
    ])
      expect(applicationFragment(value)).toBeNull();
  });
  it('retries a package download with stable proof operations, omits cookies and keeps tokens out of URLs', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let failed = false;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/staff-download-activations'))
        return Response.json({
          activationToken: 'B'.repeat(43),
          filename: 'mpos.apk',
          checksum: 'a'.repeat(64),
          bytes: 4,
          serverNow: 1,
          expiresAt: 60001,
        });
      if (!failed) {
        failed = true;
        throw new Error('private-provider-secret');
      }
      return new Response(Uint8Array.from([80, 75, 3, 4]), {
        headers: {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': '4',
        },
      });
    });
    const session = applicationDownloadSession('A'.repeat(43)),
      signal = new AbortController().signal;
    await expect(session(signal)).rejects.toThrow(
      'Could not open the application link. Try again.',
    );
    expect(Array.from(new Uint8Array(await (await session(signal)).arrayBuffer()))).toEqual([
      80, 75, 3, 4,
    ]);
    expect(calls.filter((call) => call.url.endsWith('/staff-download-activations'))).toHaveLength(
      1,
    );
    expect(calls[1]?.init.body).toBe(calls[2]?.init.body);
    for (const call of calls) {
      expect(call.init.credentials).toBe('omit');
      expect(call.init.method).toBe('POST');
      expect(call.init.redirect).toBe('error');
      expect(call.url).not.toMatch(/[?#]|AAAA|BBBB/);
    }
  });
  it('rejects a package with wrong media type or byte count before creating a download', async () => {
    for (const headers of [
      { 'Content-Type': 'text/html', 'Content-Length': '4' },
      { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': '5' },
    ]) {
      vi.stubGlobal('fetch', async (url: string) =>
        url.endsWith('/staff-download-activations')
          ? Response.json({
              activationToken: 'B'.repeat(43),
              filename: 'mpos.apk',
              checksum: 'a'.repeat(64),
              bytes: 4,
              serverNow: 1,
              expiresAt: 60001,
            })
          : new Response('html', { headers }),
      );
      await expect(
        applicationDownloadSession('A'.repeat(43))(new AbortController().signal),
      ).rejects.toThrow('Could not open the application link. Try again.');
    }
  });
  it('exports only the visible loaded activity page, keeps bigint IDs exact and neutralizes spreadsheet formulas', () => {
    const row = {
      id: '9007199254740993',
      addedBy: ' ',
      platform: 'barcode',
      recipient: 'NA',
      comment: '=SUM(1,2)',
      createdAt: '2026-11-16T23:59:59',
    };
    const parsed = activityResultSchema.parse({
      reader: 'bigquery',
      today: '2026-11-16',
      draw: 1,
      recordsTotal: '9007199254740993',
      recordsFiltered: '9007199254740993',
      start: 0,
      length: 500,
      data: [row],
    });
    expect(parsed.recordsTotal).toBe('9007199254740993');
    expect(parsed.data[0]?.id).toBe('9007199254740993');
    const csv = activityPageCsv(parsed.data, ['comment', 'addedBy']);
    expect(csv).toBe('\uFEFF"Added by","Comment"\r\n" ","\'=SUM(1,2)"');
    expect(csv).not.toContain('barcode');
    expect(csv).not.toContain('9007199254740993');
    expect(
      activityPageCsv(
        [{ ...row, comment: null, recipient: '  ' }],
        activityColumns.map(([key]) => key),
      ),
    ).toContain('"  "," ",""');
    expect(
      activityResultSchema.safeParse({ ...parsed, data: [{ ...row, id: 9007199254740992 }] })
        .success,
    ).toBe(false);
  });
  it('keeps inventory import identities exact, excludes private metadata and rejects external CSV downloads', async () => {
    const job = importJobSchema.parse({
      id: '6f1d1352-b22a-4b74-af09-a936b52cef73',
      actorId: '9007199254740993',
      name: 'Fixture.csv',
      state: 'COMPLETED',
      totalRows: 1,
      processedRows: 1,
      successfulRows: 1,
      failedRows: 0,
      errorCode: null,
      createdAt: '2026-11-16 00:00:00.000',
      updatedAt: '2026-11-16 00:00:01.000',
      checksum: 'private-canary',
      requestId: 'private-request',
    });
    expect(job.actorId).toBe('9007199254740993');
    expect(job).not.toHaveProperty('checksum');
    expect(job).not.toHaveProperty('requestId');
    await expect(
      downloadImportCsv('https://example.invalid/export.csv', 'Fixture.csv', '1'),
    ).rejects.toThrow('Choose an import download.');
  });
  it('preserves duration hours beyond one day and validates ecommerce state before caching', () => {
    expect(bufferDuration('260100')).toBe('72:15');
    expect(bufferDuration('0')).toBe('00:00');
    const current = {
      id: '9007199254740993',
      name: 'Fixture store',
      threshold: 2,
      active: true,
      version: 'a'.repeat(64),
      lockedUntil: '2026-11-16T01:00:00.000Z',
      editable: false,
    };
    expect(ecommerceSettingSchema.parse(current).id).toBe('9007199254740993');
    expect(ecommerceSettingSchema.safeParse({ ...current, lockedUntil: 'invalid' }).success).toBe(
      false,
    );
  });
  it('accepts protected opaque attachment URLs and rejects external or executable navigation', () => {
    const id = 'legacy-' + 'a'.repeat(32);
    const asset = {
      id,
      kind: 'document',
      name: 'Fixture.pdf',
      contentType: 'application/pdf',
      url: `/api/v1/documentation/1/assets/${id}/content`,
    };
    expect(guideAttachmentSchema.safeParse(asset).success).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,unsafe',
      'https://cdn.example.test/private.pdf',
      'https://user:secret@example.test/file',
      '//example.test/file',
      '/api/v1/documentation/1/assets/../../private/content',
    ])
      expect(guideAttachmentSchema.safeParse({ ...asset, url }).success).toBe(false);
  });
  it('keeps operator bigint references exact and strips credential fields before caching', () => {
    const result = operatorSchema.parse({
      id: '9007199254740993',
      firstName: 'Fixture',
      lastName: 'Person',
      email: 'fixture@example.test',
      phone: '9876543210',
      contactEmail: null,
      role: 5,
      userType: 1,
      otpMethod: 1,
      mfa: false,
      active: true,
      storeIds: ['18446744073709551615'],
      password: 'secret-canary',
      mfa_hash: 'otp-canary',
    });
    expect(result.id).toBe('9007199254740993');
    expect(result.storeIds).toEqual(['18446744073709551615']);
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('mfa_hash');
    expect(operatorSchema.safeParse({ ...result, id: '18446744073709551616' }).success).toBe(false);
    expect(operatorSchema.safeParse({ ...result, id: 9007199254740992 }).success).toBe(false);
  });
  it('preserves salesperson assignment state without coercing bigint references', () => {
    const result = salespersonSchema.parse({
      id: '9007199254740993',
      employee_id: 'FIX-1',
      first_name: 'Fixture',
      last_name: 'Salesperson',
      email: 'fixture@example.test',
      phone: '9876543210',
      is_active: 1,
      user_type: 2,
      storeIds: ['3', '9007199254740995'],
      activeStoreId: '9007199254740995',
    });
    expect(result).toMatchObject({
      id: '9007199254740993',
      active: true,
      userType: 2,
      storeIds: ['3', '9007199254740995'],
      activeStoreId: '9007199254740995',
    });
  });
  it('does not retain provider secrets in terminal list or edit state', () => {
    const common = {
      id: '9007199254740993',
      name: 'Machine 1',
      terminalId: 'terminal-fixture',
      merchantName: 'Fixture business',
      storeName: 'Fixture store',
      counterId: 1,
      active: 1,
      provider: 'paytm',
      merchant_key: 'secret-canary',
      security_token: 'private-canary',
    };
    const list = terminalSchema.parse(common);
    expect(JSON.stringify(list)).not.toContain('canary');
    const detail = terminalDetailSchema.parse({
      ...common,
      active: true,
      merchantId: 'fixture-merchant',
      deviceSerialNumber: '9223372036854775807',
    });
    expect(detail.provider === 'paytm' && detail.deviceSerialNumber).toBe('9223372036854775807');
    expect(JSON.stringify(detail)).not.toContain('canary');
    expect(
      terminalDetailSchema.safeParse({ ...detail, deviceSerialNumber: 9223372036854776000 })
        .success,
    ).toBe(false);
  });
});
