import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  couponGenerationHistory,
  couponHistoryRuntime,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-runtime.js';
import {
  couponGenerationCandidate,
  qualifyGenerationPublication,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-candidate.js';
import { generationSql } from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-query.js';
import {
  generationScopeSchema,
  bindGenerationHistory,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-generation-contracts.js';
import { assertQualifiedCouponHistory } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
import { generationFixture } from './generation-fixtures.js';
const signal = () => new AbortController().signal;
describe('prepublished operation-agnostic coupon generation', () => {
  it('reuses one genuine generation for two NEW operation bindings without native history calls or invented native seals', async () => {
    const f = generationFixture(),
      execute = vi.fn(async () => f.rows()),
      reader = couponGenerationHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => 0n, execute },
      });
    const second = {
      ...f.operation,
      operationId: randomUUID(),
      requestHash: '1'.repeat(64),
      planHash: '2'.repeat(64),
    };
    const a = await reader.read(f.operation, { witness: f.witness, signal: signal() }),
      b = await reader.read(second, { witness: f.witness, signal: signal() });
    expect(a.signature).not.toBe(b.signature);
    expect(a.publication.controlHeadHash).not.toBe(b.publication.controlHeadHash);
    expect(a.publication.sourceCaptureHash).toBe(f.capture.signature);
    expect(b.publication.sourceCaptureHash).toBe(f.capture.signature);
    expect(a.publication.seal).toBe(f.publication.seal);
    expect(b.publication.seal).toBe(f.publication.seal);
    expect(a.generationId).toBe(b.generationId);
    expect(a.fetchedAt).toBe(f.capture.capturedAt);
    expect(() =>
      assertQualifiedCouponHistory(a, f.operation, f.authority.historyKey, f.now),
    ).not.toThrow();
    const sql = execute.mock.calls[0];
    expect(execute).toHaveBeenCalledTimes(2);
    expect(sql).toBeDefined();
    const statement = generationSql(f.options, f.scope, f.capture.headHash);
    expect(statement.params).not.toHaveProperty('operation');
    expect(statement.params).not.toHaveProperty('asOf');
    expect(statement.statement).not.toMatch(/operation_id|request_hash|plan_hash/);
    expect(() => generationScopeSchema.parse({ ...f.scope, operationId: randomUUID() })).toThrow();
  });
  it('independently queries a candidate and preserves the actual generic source signature before publication', async () => {
    const f = generationFixture(),
      execute = vi.fn(async () => f.rows('candidate')),
      port = couponGenerationCandidate(
        f.options,
        { sourceKey: f.authority.sourceKey },
        { clock: () => f.now, query: { estimate: async () => 0n, execute } },
      );
    const publication = await qualifyGenerationPublication(
      f.capture,
      port,
      f.authority,
      f.options.comparisonFingerprint!,
      { clock: () => f.now, signal: signal() },
    );
    expect(publication).toEqual(f.publication);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.capture)).not.toMatch(/operationId|requestHash|planHash/);
  });
  it.each(['head', 'customer', 'coupon', 'day', 'config', 'zone'] as const)(
    'refuses new %s scope against prepublished facts',
    async (kind) => {
      const f = generationFixture(),
        operation = { ...f.operation },
        w = structuredClone(f.witness);
      if (kind === 'head') w.heads[1].revision = String(BigInt(w.heads[1].revision) + 1n);
      if (kind === 'customer') operation.customerId = '99';
      if (kind === 'coupon') operation.couponId = '99';
      if (kind === 'day') operation.asOf = '2026-06-16 00:00:00';
      if (kind === 'config') operation.configurationHash = '0'.repeat(64);
      if (kind === 'zone') operation.sourceTimeZone = 'UTC';
      const reader = couponGenerationHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => 0n, execute: async () => f.rows() },
      });
      await expect(reader.read(operation, { witness: w, signal: signal() })).rejects.toBeDefined();
    },
  );
  it.each([
    'empty-manifest',
    'orphan',
    'rows',
    'hash',
    'facts',
    'seal',
    'duplicate',
    'mixed',
    'future',
  ] as const)('refuses %s evidence with no zero/native fallback', async (kind) => {
    const f = generationFixture(),
      d = f.document();
    if (kind === 'empty-manifest') d.manifests = [];
    if (kind === 'orphan') d.controls.pop();
    if (kind === 'rows') d.projections.orders.rows = '9';
    if (kind === 'hash') d.projections.orders.hash = '0'.repeat(64);
    if (kind === 'facts') d.facts.monthlyJoinedUsage = '11';
    if (kind === 'seal') {
      const row = d.manifests[0]!;
      if (!('publicationDocument' in row)) throw Error('fixture');
      row.publicationDocument = JSON.stringify({ ...f.publication, seal: '0'.repeat(64) });
    }
    if (kind === 'duplicate') d.actual.uniqueOrders = '9';
    if (kind === 'mixed') d.manifests[0]!.snapshotId = randomUUID();
    if (kind === 'future') d.manifests[0]!.materializedAt = f.now + 1;
    const r = couponGenerationHistory(f.options, f.authority, {
      clock: () => f.now,
      query: { estimate: async () => 0n, execute: async () => [{ document: JSON.stringify(d) }] },
    });
    await expect(
      r.read(f.operation, { witness: f.witness, signal: signal() }),
    ).rejects.toBeDefined();
  });
  it('accepts only an authenticated complete empty generation and preserves literal future/join facts otherwise', async () => {
    const f = generationFixture(true),
      reader = couponGenerationHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => 0n, execute: async () => f.rows() },
      });
    expect(
      (await reader.read(f.operation, { witness: f.witness, signal: signal() })).customerOrderCount,
    ).toBe('0');
    const nonempty = generationFixture();
    expect(nonempty.facts.facts.monthlyJoinedUsage).toBe('12');
    expect(nonempty.facts.facts.lotCounts[0]!.usedCount).toBe('16');
  });
  it('does no constructor I/O, defaults off, enforces budget and clamps freshness to the source generation', async () => {
    const f = generationFixture(),
      factory = vi.fn(() => {
        throw Error('I/O');
      });
    expect(couponHistoryRuntime({}, undefined, { clientFactory: factory })).toBeUndefined();
    couponGenerationHistory(f.options, f.authority, { clientFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    const execute = vi.fn(async () => f.rows()),
      reader = couponGenerationHistory(f.options, f.authority, {
        clock: () => f.now,
        query: { estimate: async () => BigInt(f.options.maxBytes) + 1n, execute },
      });
    await expect(
      reader.read(f.operation, { witness: f.witness, signal: signal() }),
    ).rejects.toMatchObject({ code: 'ORDER_IMPORT_COUPON_PUBLICATION_GENERATION_BUDGET' });
    expect(execute).not.toHaveBeenCalled();
    expect(() =>
      bindGenerationHistory(
        { ...f.facts, publication: f.publication },
        f.operation,
        f.witness,
        f.authority,
        f.options.comparisonFingerprint!,
        f.now + 60000,
      ),
    ).toThrow();
  });
});
