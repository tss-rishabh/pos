import { describe, expect, it } from 'vitest';
import { publicOrderHistory } from '../../src/modules/order-history/reader.js';
import { orderRange, orderHistoryContract } from '../../src/modules/order-history/contracts.js';
import { orderCursors } from '../../src/modules/order-history/cursor.js';
import { historyRowsHash } from '../../src/modules/order-history/hashes.js';
import { readOrderHistoryOptions } from '../../src/modules/order-history/options.js';
import {
  config,
  options,
  now,
  range,
  header,
  listEnvelope,
  orderEnvelope,
  copyEnvelope,
  generation,
} from './fixtures.js';
function reader(value: unknown) {
  return publicOrderHistory(config, options, {
    clock: () => now,
    estimate: async () => 1n,
    query: async (sql) => [
      sql.includes('/* order-history-publication */')
        ? { publications: (value as { publications: unknown[] }).publications }
        : (value as Record<string, unknown>),
    ],
  });
}
describe('public order history conservation and routing', () => {
  it('routes default/today interactive primary, today report data, and older/mixed ranges BigQuery', () => {
    expect(orderRange({}, 'Asia/Kolkata', now).reader).toBe('primary');
    expect(orderRange({ intent: 'report' }, 'Asia/Kolkata', now).reader).toBe('data');
    expect(orderRange({ from: '2026-11-16', to: '2026-11-17' }, 'Asia/Kolkata', now).reader).toBe(
      'bigquery',
    );
    expect(() =>
      orderRange({ from: '2026-11-18', to: '2026-11-18' }, 'Asia/Kolkata', now),
    ).toThrow();
    expect(() =>
      orderRange({ from: '2026-01-01', to: '2026-11-17' }, 'Asia/Kolkata', now),
    ).toThrow();
    expect(() => orderRange({ from: '2026-11-16' }, 'Asia/Kolkata', now)).toThrow();
  });
  it('preserves duplicate store associations and verifies empty days instead of inventing zero', async () => {
    const result = await reader(listEnvelope()).list({ storeId: '1', range, limit: 30 });
    expect(result.rows.map((row) => row.store.id)).toEqual(['11', '10']);
    expect(result.rows.map((row) => row.header.id)).toEqual([header.id, header.id]);
    expect(result.evidence.generationId).toBe(generation);
  });
  it.each([
    'missing-day',
    'partial',
    'source-count',
    'warehouse-count',
    'hash',
    'stale',
    'future',
    'duplicate-generation',
    'duplicate-row',
    'scope',
    'unretained-generation',
  ])('rejects an invalid %s publication', async (kind) => {
    const envelope = listEnvelope();
    if (kind === 'missing-day') envelope.publications.shift();
    if (kind === 'partial') envelope.publications[0]!.source_complete = false;
    if (kind === 'source-count') envelope.publications[1]!.source_rows = '3';
    if (kind === 'warehouse-count') envelope.publications[1]!.warehouse_stores = '1';
    if (kind === 'hash') envelope.actual[0]!.actual_hash = '0'.repeat(64);
    if (kind === 'stale')
      for (const p of envelope.publications)
        p.source_snapshot_at = new Date(now - 3600000).toISOString();
    if (kind === 'future')
      for (const p of envelope.publications) p.published_at = new Date(now + 10000).toISOString();
    if (kind === 'duplicate-generation')
      envelope.publications[1]!.generation_id = '4918d168-c62e-4ed7-b8ae-89b0a5e70012';
    if (kind === 'duplicate-row') envelope.actual[0]!.unique_stores = '1';
    if (kind === 'scope') envelope.page[0]!.store.storeId = '2';
    await expect(
      reader(envelope).list({
        storeId: '1',
        range,
        limit: 30,
        ...(kind === 'unretained-generation'
          ? { generationId: '4918d168-c62e-4ed7-b8ae-89b0a5e70012' }
          : {}),
      }),
    ).rejects.toMatchObject({ code: 'ORDER_HISTORY_PUBLICATION_INVALID' });
  });
  it('requires a publication even for empty/missing results and rejects an over-budget query before execution', async () => {
    await expect(
      reader({ publications: [], actual: [], page: [] }).list({ storeId: '1', range, limit: 30 }),
    ).rejects.toMatchObject({ code: 'ORDER_HISTORY_PUBLICATION_REQUIRED' });
    let called = false;
    const service = publicOrderHistory(config, options, {
      clock: () => now,
      estimate: async () => BigInt(config.BIGQUERY_MAX_BYTES_BILLED) + 1n,
      query: async () => {
        called = true;
        return [];
      },
    });
    await expect(service.list({ storeId: '1', range, limit: 30 })).rejects.toMatchObject({
      code: 'ORDER_HISTORY_PROJECTION_REQUIRED',
    });
    expect(called).toBe(false);
    await expect(
      publicOrderHistory(config, readOrderHistoryOptions({}), { estimate: async () => 0n }).list({
        storeId: '1',
        range,
        limit: 30,
      }),
    ).rejects.toBeDefined();
  });
  it('preserves every HP once for store/customer copy, including duplicate SKU and absent catalog product', async () => {
    const service = reader(copyEnvelope()),
      cutoff = '2026-11-17 00:00:00';
    const result = await service.copyFacts({
      source: { kind: 'store', storeId: '1' },
      orderId: header.id,
      cutoff,
    });
    expect(result.lines).toEqual([
      { lineId: '9007199254741001', productId: '101' },
      { lineId: '9007199254741002', productId: '101' },
      { lineId: '9007199254741003', productId: '999' },
    ]);
    expect(result.complete).toBe(true);
    expect(result.reader).toBe('bigquery');
    expect(
      (
        await service.copyFacts({
          source: { kind: 'customer', customerId: '7' },
          orderId: header.id,
          cutoff,
        })
      ).sourceCustomerId,
    ).toBe('7');
    await expect(
      service.copyFacts({
        source: { kind: 'customer', customerId: '8' },
        orderId: header.id,
        cutoff,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.copyFacts({ source: { kind: 'store', storeId: '2' }, orderId: header.id, cutoff }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.copyFacts({
        source: { kind: 'store', storeId: '1' },
        orderId: header.id,
        cutoff: '2026-11-18 00:00:00',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    'missing-line',
    'changed-product',
    'duplicate-line',
    'partial',
    'row-count',
    'scope',
    'wrong-date',
  ])('rejects incomplete/changed order %s facts', async (kind) => {
    const envelope = orderEnvelope();
    if (kind === 'missing-line') envelope.lines.pop();
    if (kind === 'changed-product') envelope.lines[0]!.productId = '9999';
    if (kind === 'duplicate-line') envelope.actual.unique_lines = '2';
    if (kind === 'partial') envelope.publications[0]!.source_complete = false;
    if (kind === 'row-count')
      envelope.publications[0]!.source_rows = envelope.publications[0]!.warehouse_rows = '5';
    if (kind === 'scope') envelope.stores[0]!.orderId = '999';
    if (kind === 'wrong-date') envelope.publications[0]!.business_date = '2026-11-15';
    await expect(
      reader(envelope).order({
        source: { kind: 'store', storeId: '1' },
        orderId: header.id,
        cutoff: '2026-11-17 00:00:00',
      }),
    ).rejects.toMatchObject({ code: 'ORDER_HISTORY_PUBLICATION_INVALID' });
  });
  it('only returns not-found after a complete independently empty order proof', async () => {
    const envelope = orderEnvelope();
    envelope.headers = [];
    envelope.stores = [];
    envelope.lines = [];
    envelope.actual = {
      headers: '0',
      stores: '0',
      lines: '0',
      unique_stores: '0',
      unique_lines: '0',
    };
    const p = envelope.publications[0]!;
    p.source_rows =
      p.warehouse_rows =
      p.source_orders =
      p.warehouse_orders =
      p.source_stores =
      p.warehouse_stores =
      p.source_lines =
      p.warehouse_lines =
        '0';
    p.source_hash = p.warehouse_hash = historyRowsHash([]);
    p.source_copy_hash = p.warehouse_copy_hash = historyRowsHash([]);
    await expect(
      reader(envelope).order({ source: { kind: 'store', storeId: '1' }, orderId: header.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('selects only minimal copy facts and freezes the manifest before a date-pruned fact read', async () => {
    const value = copyEnvelope(),
      statements: string[] = [];
    const service = publicOrderHistory(config, options, {
      clock: () => now,
      estimate: async () => 1n,
      query: async (sql, params) => {
        statements.push(sql);
        if (sql.includes('/* order-history-publication */'))
          return [{ publications: value.publications }];
        expect(params.businessDate).toBe('2026-11-16');
        expect(params.pointGeneration).toBe(generation);
        return [value];
      },
    });
    await service.copyFacts({
      source: { kind: 'store', storeId: '1' },
      orderId: header.id,
      cutoff: '2026-11-17 00:00:00',
    });
    expect(statements).toHaveLength(2);
    expect(statements[1]).not.toMatch(/\b(first_name|last_name|name|amount|quantity|gst)\b/);
    expect(statements[1]).toContain('business_date=@businessDate');
  });
  it('conserves one cumulative budget across manifest and facts, stopping before the second query', async () => {
    const value = copyEnvelope();
    let queries = 0;
    const service = publicOrderHistory(config, options, {
      clock: () => now,
      estimate: async () => (BigInt(config.BIGQUERY_MAX_BYTES_BILLED) * 6n) / 10n,
      query: async () => {
        queries++;
        return [{ publications: value.publications }];
      },
    });
    await expect(
      service.copyFacts({
        source: { kind: 'store', storeId: '1' },
        orderId: header.id,
        cutoff: '2026-11-17 00:00:00',
      }),
    ).rejects.toMatchObject({ code: 'ORDER_HISTORY_PROJECTION_REQUIRED' });
    expect(queries).toBe(1);
  });
  it('rejects a changing publication between metadata and fact queries instead of mixing generations', async () => {
    const value = copyEnvelope();
    let queries = 0;
    const service = publicOrderHistory(config, options, {
      clock: () => now,
      estimate: async () => 1n,
      query: async () => {
        queries++;
        if (queries === 1) return [{ publications: structuredClone(value.publications) }];
        value.publications[0]!.generation_id = '4918d168-c62e-4ed7-b8ae-89b0a5e70012';
        return [value];
      },
    });
    await expect(
      service.copyFacts({
        source: { kind: 'store', storeId: '1' },
        orderId: header.id,
        cutoff: '2026-11-17 00:00:00',
      }),
    ).rejects.toMatchObject({ code: 'ORDER_HISTORY_PUBLICATION_INVALID' });
  });
  it('binds opaque pagination to full actor/store/date/source/generation and exact duplicate row anchor', () => {
    const scope = { actor: '1', store: '1', range },
      cursors = orderCursors(config.SESSION_SECRET, () => now);
    const value = cursors.encode(scope, { orderId: header.id, rowId: '11' }, generation);
    expect(cursors.decode(value, scope)).toEqual({
      orderId: header.id,
      rowId: '11',
      generationId: generation,
    });
    expect(() => cursors.decode(value, { ...scope, actor: '2' })).toThrow();
    expect(() => cursors.decode(value, { ...scope, store: '2' })).toThrow();
    expect(() =>
      cursors.decode(value, { ...scope, range: { ...range, to: '2026-11-17' } }),
    ).toThrow();
    expect(() => cursors.decode(value + 'x', scope)).toThrow();
    expect(() =>
      orderCursors(config.SESSION_SECRET, () => now + 900000).decode(value, scope),
    ).toThrow();
    expect(orderHistoryContract).toBe('pos-public-order-history-v1');
  });
});
