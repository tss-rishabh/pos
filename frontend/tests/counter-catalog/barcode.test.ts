import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { z } from 'zod';
import { QueryClient } from '@tanstack/react-query';
import { clearLocalIdentity } from '../../src/offline/clear-identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setRequestOperator } from '../../src/api/client';
import { db, PosDatabase, eraseOperator, type LocalDraft } from '../../src/offline/database';
import type { Product } from '../../src/api/types';
import {
  addProduct,
  canonicalBarcode,
  commitScannedProduct,
  resolveBarcode,
} from '../../src/pages/counter-catalog/barcode';
import { goldenStdout } from '../golden/load';
const product: Product = {
  id: '9007199254740993',
  parentId: '9',
  name: 'Scanned product',
  erpName: '',
  barcode: '111',
  type: '1',
  price: '25.49',
  specialPrice: '25.49',
  exclusivePrice: null,
  stock: 5,
  gst: 5,
  image: null,
};
const scope = { ownerId: '1', storeId: '2', counterId: '3', draftId: 'draft-a' };
const draft: LocalDraft = {
  id: scope.draftId,
  ...scope,
  customerId: null,
  lines: [],
  version: 0,
  createdAt: 1,
  updatedAt: 1,
};
const response = (matchedBarcode = '222') =>
  new Response(JSON.stringify({ matchedBarcode, product }), { status: 200 });
beforeEach(async () => {
  setRequestOperator('1');
  await db.drafts.clear();
  await db.catalog.clear();
  await db.catalogBarcodes.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setRequestOperator(null);
});
describe('exact scanner binding', () => {
  it('canonicalizes source input-mask placeholders/leading zeros without Number precision loss', () => {
    expect(canonicalBarcode('00_9007199254740993_')).toBe('9007199254740993');
    expect(canonicalBarcode('0')).toBe('0');
    expect(canonicalBarcode('9223372036854775807')).toBe('9223372036854775807');
    for (const input of ['', '_', '-1', '1e3', '1.0', '9223372036854775808', '0'.repeat(101)])
      expect(() => canonicalBarcode(input)).toThrow();
  });
  it('dispatches scanned input as the pinned AjaxCartView.post does, with documented validation divergences', () => {
    // Pinned order/views.py:1694-1724 (78d5b63) run up to its ProductBarcode lookup; replayed from
    // tests/golden/counter-catalog/source-barcode.json. Legacy strips "_" and calls int(); a
    // falsy result (0) falls back to product_id; empty input asks for a barcode.
    const scans = [
      '000222',
      '00_9007199254740993_',
      '12_34',
      ' 12 ',
      '9223372036854775807',
      '0',
      '0000',
      '_0_',
      '',
      '_',
      'abc',
      '1e3',
      '1.0',
      '-1',
      '１２',
    ];
    const legacy = z
      .array(
        z.discriminatedUnion('outcome', [
          z.object({
            outcome: z.literal('filter'),
            query: z.union([
              z.object({ gtin: z.string() }).strict(),
              z.object({ product: z.string() }).strict(),
            ]),
          }),
          z.object({
            outcome: z.literal('response'),
            body: z.object({ status: z.literal('fail'), message: z.string() }).passthrough(),
          }),
          z.object({ outcome: z.literal('error'), type: z.string() }),
        ]),
      )
      .parse(
        JSON.parse(
          goldenStdout(
            'counter-catalog',
            'source-barcode',
            JSON.stringify(scans.map((barcode) => ({ barcode, productId: '0' }))),
          ),
        ) as unknown,
      );
    expect(legacy).toHaveLength(scans.length);
    // Documented divergences (backend/parity/w15-report.md): the rewrite refuses negative GTINs and
    // non-ASCII digits with a clear validation message instead of looking them up as legacy does.
    const divergent = new Map([
      ['-1', { outcome: 'filter', query: { gtin: '-1' } }],
      ['１２', { outcome: 'filter', query: { gtin: '12' } }],
    ]);
    scans.forEach((scan, index) => {
      const source = legacy[index]!;
      const expected = divergent.get(scan);
      if (expected) {
        expect(source, scan).toEqual(expected);
        expect(() => canonicalBarcode(scan), scan).toThrow('Enter a valid numeric barcode.');
      } else if (source.outcome === 'filter' && 'gtin' in source.query) {
        expect(canonicalBarcode(scan), scan).toBe(source.query.gtin);
      } else if (source.outcome === 'filter') {
        // product_id=0 fallback: the rewrite sends GTIN 0, which the backend answers
        // BARCODE_NOT_FOUND (legacy "Product Barcode Missing.").
        expect(source.query, scan).toEqual({ product: '0' });
        expect(canonicalBarcode(scan), scan).toBe('0');
      } else {
        // "Please Provide Barcode" or a ValueError from int(): the rewrite refuses the scan.
        expect(() => canonicalBarcode(scan), scan).toThrow('Enter a valid numeric barcode.');
      }
    });
  });
  it('requests the entered exact GTIN and retains the primary barcode for an alternate match', async () => {
    const fetcher = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetcher);
    expect(await resolveBarcode('1', '2', '000222', new AbortController().signal)).toEqual(product);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/stores/2/catalog/products/by-barcode/222');
  });
  it('refuses a wrong echoed GTIN rather than adding a stale response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('111')));
    await expect(resolveBarcode('1', '2', '222', new AbortController().signal)).rejects.toThrow(
      'did not match',
    );
  });
  it('does not fall back to cached products on access denial or no exact match', async () => {
    await db.catalog.put({ ...product, ownerId: '1', storeId: '2', cachedAt: 1 });
    for (const status of [401, 403, 404, 409]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
      await expect(
        resolveBarcode('1', '2', '111', new AbortController().signal),
      ).rejects.toMatchObject({ status });
    }
  });
  it('uses only an exact unique in-stock primary cached barcode from the same operator/store offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await db.catalog.bulkPut([
      { ...product, ownerId: '1', storeId: '2', cachedAt: 1 },
      { ...product, id: '8', ownerId: 'other', storeId: '2', cachedAt: 1 },
    ]);
    expect((await resolveBarcode('1', '2', '000111', new AbortController().signal)).id).toBe(
      product.id,
    );
    await expect(resolveBarcode('1', '2', '222', new AbortController().signal)).rejects.toThrow(
      'offline',
    );
    await db.catalog.put({ ...product, id: '8', ownerId: '1', storeId: '2', cachedAt: 1 });
    await expect(resolveBarcode('1', '2', '111', new AbortController().signal)).rejects.toThrow(
      'uniquely',
    );
    await db.catalog.put({
      ...product,
      id: '9',
      barcode: '0',
      ownerId: '1',
      storeId: '2',
      cachedAt: 1,
    });
    await expect(resolveBarcode('1', '2', '0', new AbortController().signal)).rejects.toThrow(
      'not found',
    );
  });
  it('cancels a late network result after operator change', async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = resolveBarcode('1', '2', '222', new AbortController().signal);
    setRequestOperator('other');
    finish!(response());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('commits only to the captured draft and rolls back if active scope changes during the transaction', async () => {
    await db.drafts.put(draft);
    await commitScannedProduct(scope, product, new AbortController().signal, () => true);
    expect((await db.drafts.get(['1', draft.id]))?.lines).toEqual(addProduct(draft, product).lines);
    let checks = 0;
    await expect(
      commitScannedProduct(scope, product, new AbortController().signal, () => ++checks < 4),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await db.drafts.get(['1', draft.id]))?.lines[0]?.quantity).toBe(1);
  });
  it('refuses removed/wrong-store drafts and aborted scans', async () => {
    await db.drafts.put({ ...draft, storeId: 'different' });
    await expect(
      commitScannedProduct(scope, product, new AbortController().signal, () => true),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      commitScannedProduct(scope, product, AbortSignal.abort(), () => true),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await db.drafts.get(['1', draft.id]))?.lines).toEqual([]);
  });
  it('persists a verified alternate through database reopen without replacing its primary barcode', async () => {
    await db.drafts.put(draft);
    await commitScannedProduct(scope, product, new AbortController().signal, () => true, '000222');
    db.close();
    await db.open();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect((await resolveBarcode('1', '2', '222', new AbortController().signal)).barcode).toBe(
      '111',
    );
    await expect(
      resolveBarcode('1', 'different', '222', new AbortController().signal),
    ).rejects.toThrow('offline');
    await db.catalog.put({
      ...product,
      id: '8',
      barcode: '222',
      ownerId: '1',
      storeId: '2',
      cachedAt: 1,
    });
    await expect(resolveBarcode('1', '2', '222', new AbortController().signal)).rejects.toThrow(
      'uniquely',
    );
  });
  it('atomically replaces an alias only after a fresh unique resolution and rolls back late scope changes', async () => {
    await db.drafts.put(draft);
    await db.catalogBarcodes.put({
      ownerId: '1',
      storeId: '2',
      barcode: '222',
      productId: 'old',
      observedAt: 1,
    });
    let calls = 0;
    await expect(
      commitScannedProduct(scope, product, new AbortController().signal, () => ++calls < 5, '222'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await db.catalogBarcodes.toArray()).map((row) => row.productId)).toEqual(['old']);
    expect((await db.drafts.get(['1', draft.id]))?.lines).toEqual([]);
    expect(await db.catalog.count()).toBe(0);
    await commitScannedProduct(scope, product, new AbortController().signal, () => true, '222');
    expect((await db.catalogBarcodes.toArray()).map((row) => row.productId)).toEqual([product.id]);
  });
  it('logout clears only the actor aliases and late operator results cannot repopulate them', async () => {
    await db.drafts.put(draft);
    await commitScannedProduct(scope, product, new AbortController().signal, () => true, '222');
    await db.catalogBarcodes.put({
      ownerId: 'other',
      storeId: '2',
      barcode: '222',
      productId: '8',
      observedAt: 1,
    });
    const pendingSignal = (await import('../../src/api/client')).captureOperatorScope('1');
    await clearLocalIdentity(new QueryClient(), '1');
    await expect(
      commitScannedProduct(scope, product, pendingSignal, () => true, '222'),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect((await db.catalogBarcodes.toArray()).map((row) => row.ownerId)).toEqual(['other']);
    expect(await db.drafts.get(['1', draft.id])).toBeDefined();
    await eraseOperator('other');
    expect(await db.catalogBarcodes.count()).toBe(0);
  });
  it('adds the version10 alias table, drops retired offline-cash tables and keeps version9 drafts', async () => {
    const name = 'counter-barcode-upgrade-' + crypto.randomUUID();
    const legacy = new Dexie(name);
    const schema = Object.fromEntries(
      db.tables
        .filter((table) => table.name !== 'catalogBarcodes')
        .map((table) => [
          table.name,
          [table.schema.primKey.src, ...table.schema.indexes.map((index) => index.src)].join(','),
        ]),
    );
    legacy.version(9).stores({
      ...schema,
      offlineCashReceipts:
        '[ownerId+receiptId],&[ownerId+draftId],&[authorizationId+sequence],ownerId,storeId,[ownerId+storeId],[ownerId+storeId+completedAt],syncState,completedAt',
    });
    const financial = {
      ownerId: '1',
      receiptId: 'receipt',
      draftId: 'offline-draft',
      authorizationId: 'authorization',
      sequence: 1,
      storeId: '2',
      syncState: 'pending',
      completedAt: 1,
      envelope: { preserved: 'signed-envelope-fixture' },
    };
    await legacy.table('drafts').put(draft);
    await legacy.table('offlineCashReceipts').put(financial);
    legacy.close();
    const upgraded = new PosDatabase(name);
    try {
      await upgraded.open();
      expect(upgraded.verno).toBe(11);
      expect(await upgraded.catalogBarcodes.count()).toBe(0);
      expect(await upgraded.drafts.get(['1', draft.id])).toEqual(draft);
      expect(upgraded.tables.map((table) => table.name)).not.toContain('offlineCashReceipts');
    } finally {
      await upgraded.delete();
    }
  });
});
