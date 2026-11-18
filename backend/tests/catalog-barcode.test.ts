import { describe, expect, it } from 'vitest';
import { catalogBarcode, uniqueBarcodeProduct } from '../src/modules/catalog-barcode.js';
import { demoServices, demoUser } from '../src/modules/demo.js';
import { readCatalogBarcode } from '../src/modules/catalog-barcode.js';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

describe('exact barcode selection', () => {
  it('protects the actual app barcode route and keeps demo resolution database-free', async () => {
    const origin = 'http://localhost:5173';
    const app = await buildApp(
      readConfig({
        NODE_ENV: 'test',
        DEMO_MODE: 'true',
        WEB_ORIGIN: origin,
        SESSION_SECRET: 'synthetic-barcode-route-'.repeat(3),
      }),
      { logger: false },
    );
    try {
      const path = '/api/v1/stores/1/catalog/products/by-barcode/0008900000001001';
      expect((await app.inject({ url: path })).statusCode).toBe(401);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/demo-sessions',
        headers: { origin },
      });
      expect(login.statusCode).toBe(200);
      const credential = login.cookies[0];
      if (!credential) throw new Error('SYNTHETIC_COOKIE_REQUIRED');
      const headers = {
        cookie: `${credential.name}=${credential.value}`,
        'x-operator-id': demoUser.id,
      };
      const response = await app.inject({ url: path, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json<unknown>()).toMatchObject({
        matchedBarcode: '8900000001001',
        product: { id: '1001' },
      });
      expect(
        (await app.inject({ url: path, headers: { ...headers, 'x-operator-id': '1' } })).statusCode,
      ).toBe(409);
      expect((await app.inject({ url: path + '?search=other', headers })).statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it.each(['0009007199254740993', ' 9007199254740993 '])('preserves precision for %s', (input) => {
    expect(catalogBarcode.parse(input)).toBe('9007199254740993');
  });
  it('preserves the source numeric zero and signed maximum', () => {
    expect(catalogBarcode.parse('000')).toBe('0');
    expect(catalogBarcode.parse('9223372036854775807')).toBe('9223372036854775807');
  });
  it.each(['1e3', '1.0', '-1', '', '9'.repeat(10000), '9223372036854775808'])(
    'refuses invalid scan without throwing: %s',
    (input) => {
      expect(catalogBarcode.safeParse(input).success).toBe(false);
    },
  );
  it('uses exact matches in the authenticated synthetic catalog', async () => {
    const catalog = demoServices().catalog;
    const result = await readCatalogBarcode(catalog, null, demoUser, '1', '0008900000001001');
    expect(result).toMatchObject({ matchedBarcode: '8900000001001', product: { id: '1001' } });
    await expect(
      readCatalogBarcode(catalog, null, demoUser, '1', '890000000100'),
    ).rejects.toMatchObject({ code: 'BARCODE_NOT_FOUND' });
    await expect(readCatalogBarcode(catalog, null, demoUser, '1', '000')).rejects.toMatchObject({
      code: 'BARCODE_NOT_FOUND',
    });
    expect(() =>
      uniqueBarcodeProduct(
        [result.product, { ...result.product, id: '1002' }],
        result.matchedBarcode,
      ),
    ).toThrow('multiple products');
    expect(
      uniqueBarcodeProduct([result.product, result.product], result.matchedBarcode).product.id,
    ).toBe(result.product.id);
  });
});
