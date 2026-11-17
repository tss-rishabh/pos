import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readConfig } from '../../src/config.js';
import {
  assertCsvMembershipPrefetch,
  inMemoryCsvMembershipHistory,
  prefetchCsvMembershipHistory,
  requestForCsvMembershipDispatch,
} from '../../src/modules/legacy-order-imports/membership-profile/bridge.js';
import { csvMembershipPrefetchSchema } from '../../src/modules/legacy-order-imports/membership-profile/bridge.js';
import { csvMembershipBigQueryHistory } from '../../src/modules/legacy-order-imports/membership-profile/bigquery.js';
import { legacyImportFinancialTransport } from '../../src/modules/legacy-order-imports/financial-adapter-transport.js';
import { financialSourceHash } from '../../src/modules/legacy-order-imports/financial-adapter-crypto.js';
import { memberEvidence } from '../legacy-import-membership/adapter-fixtures.js';
import type { LegacyImportFinancialOptions } from '../../src/modules/legacy-order-imports/financial-adapter-options.js';
import {
  membershipBigQueryFixture,
  membershipHistoryAuthority,
  membershipHistoryKey,
  membershipHistoryNow,
  membershipHistoryOptions,
  membershipHistoryScope,
} from './membership-bigquery-fixtures.js';

const options = {
  historyKey: membershipHistoryKey,
  memberProductIds: ['10', '12'],
  sourceTimeZone: 'Asia/Kolkata',
  clock: () => membershipHistoryNow,
};
async function prepared(
  scope = membershipHistoryScope,
  rows?: Parameters<typeof membershipBigQueryFixture>[0],
) {
  const execute = vi.fn(async () => [
    { document: JSON.stringify(membershipBigQueryFixture(rows, scope).envelope) },
  ]);
  const reader = csvMembershipBigQueryHistory(
    membershipHistoryOptions,
    membershipHistoryAuthority,
    { query: { estimate: async () => 1n, execute }, clock: options.clock },
  );
  const handoff = await prefetchCsvMembershipHistory(reader, scope, options);
  return { handoff, execute };
}
describe('pre-dispatch history sealing and transaction-local replay', () => {
  it('captures the literal execution wall second and45calendar-day cutoff, independently from old CSV dates', () => {
    expect(
      requestForCsvMembershipDispatch(membershipHistoryScope, {
        sourceTimeZone: 'Asia/Kolkata',
        clock: () => Date.parse('2026-11-17T06:30:00.999Z'),
      }),
    ).toEqual(membershipHistoryScope);
    const leap = requestForCsvMembershipDispatch(membershipHistoryScope, {
      sourceTimeZone: 'Asia/Kolkata',
      clock: () => Date.parse('2024-03-01T06:30:00Z'),
    });
    expect(leap.asOf).toBe('2024-03-01 12:00:00');
    expect(leap.cutoff).toBe('2024-01-16 12:00:00');
    // DST is a wall-calendar subtraction, not45*24elapsed hours.
    const dst = requestForCsvMembershipDispatch(membershipHistoryScope, {
      sourceTimeZone: 'America/New_York',
      clock: () => Date.parse('2026-03-20T16:00:00Z'),
    });
    expect(dst.asOf).toBe('2026-03-20 12:00:00');
    expect(dst.cutoff).toBe('2026-02-03 12:00:00');
  });
  it('prefetches before dispatch, freezes the document/capability and replays memory only under a no-I/O transaction boundary', async () => {
    const f = await prepared(),
      memory = inMemoryCsvMembershipHistory(f.handoff, options);
    expect(Object.isFrozen(f.handoff)).toBe(true);
    expect(Object.isFrozen(f.handoff.document.recentDeliveredOrders[0]!.lines)).toBe(true);
    f.execute.mockRejectedValue(new Error('SQL_TX_NETWORK_FORBIDDEN'));
    const first = await memory.read(membershipHistoryScope),
      second = await memory.read(membershipHistoryScope);
    expect(first).toEqual(f.handoff.document);
    expect(second).toEqual(first);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.handoff.capability.expiresAt).toBe(Date.parse('2026-11-17T06:31:00Z'));
  });
  it.each(['operationId', 'requestHash', 'planHash', 'customerId', 'asOf', 'cutoff'])(
    'refuses replay into a different %s even with a valid original document signature',
    async (field) => {
      const f = await prepared(),
        memory = inMemoryCsvMembershipHistory(f.handoff, options);
      const input = {
        ...membershipHistoryScope,
        [field]:
          field === 'operationId'
            ? 'bb127f8c-6fbb-41eb-a608-9115b3e31561'
            : field.endsWith('Hash')
              ? 'f'.repeat(64)
              : field === 'customerId'
                ? '99'
                : '2026-11-17 12:00:01',
      };
      await expect(memory.read(input)).rejects.toMatchObject({
        code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID',
      });
    },
  );
  it('rejects tampered generation, document digest, expiry, time zone and capability proof', async () => {
    const f = await prepared();
    for (const change of [
      { generationId: 'd'.repeat(64) },
      { documentHash: 'd'.repeat(64) },
      { expiresAt: membershipHistoryNow + 60000 },
      { sourceTimeZone: 'UTC' },
      { signature: 'd'.repeat(64) },
    ]) {
      const value = structuredClone(f.handoff);
      Object.assign(value.capability, change);
      expect(() => assertCsvMembershipPrefetch(value, membershipHistoryScope, options)).toThrow(
        expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID' }),
      );
    }
    const changed = structuredClone(f.handoff);
    changed.document.lastDeliveredOrder!.lines[0]!.isExclusiveOrder = 0;
    expect(() => inMemoryCsvMembershipHistory(changed, options)).toThrow(
      expect.objectContaining({ code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID' }),
    );
  });
  it('never extends the original expiry during replay or source retry', async () => {
    const f = await prepared();
    let now = membershipHistoryNow;
    const memory = inMemoryCsvMembershipHistory(f.handoff, { ...options, clock: () => now });
    now = f.handoff.capability.expiresAt - 1;
    expect((await memory.read(membershipHistoryScope)).fetchedAt).toBe(membershipHistoryNow);
    now++;
    await expect(memory.read(membershipHistoryScope)).rejects.toMatchObject({
      code: 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID',
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('copies mutable supplied data and refuses missing/invalid handoff instead of querying or returning empty history', async () => {
    const f = await prepared(),
      wire = structuredClone(f.handoff),
      memory = inMemoryCsvMembershipHistory(wire, options);
    wire.document.generationId = 'd'.repeat(64);
    expect((await memory.read(membershipHistoryScope)).generationId).toBe('c'.repeat(64));
    for (const value of [null, {}, [], { document: f.handoff.document }])
      expect(() => inMemoryCsvMembershipHistory(value, options)).toThrow();
  });
  it('rejects invalid clocks and DST-ambiguous source seconds', () => {
    for (const clock of [() => NaN, () => -1, () => Infinity])
      expect(() =>
        requestForCsvMembershipDispatch(membershipHistoryScope, {
          sourceTimeZone: 'Asia/Kolkata',
          clock,
        }),
      ).toThrow();
    expect(() =>
      requestForCsvMembershipDispatch(membershipHistoryScope, {
        sourceTimeZone: 'America/New_York',
        clock: () => Date.parse('2026-11-01T05:30:00Z'),
      }),
    ).toThrow();
  });
});

const wireSchema = z
  .object({
    capability: z.record(z.string(), z.unknown()),
    plan: z.unknown(),
    membershipHistory: csvMembershipPrefetchSchema.optional(),
  })
  .strict();
type OrderWire = z.infer<typeof wireSchema>;
const authKey = 'synthetic-source-history-transport-authority-'.repeat(2),
  proofKey = 'synthetic-source-history-transport-proof-'.repeat(2);
const config = readConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'synthetic-history-transport-session-'.repeat(2),
  MYSQL_ALLOW_LOCAL_PLAINTEXT: 'true',
  MYSQL_PRIMARY_READER_URL: 'mysql://root@127.0.0.1/pos_rewrite_history_handoff_test',
});
async function orderWire(handoff?: Awaited<ReturnType<typeof prepared>>['handoff']) {
  const f = memberEvidence(),
    scope = handoff?.document.scope ?? membershipHistoryScope,
    wires: OrderWire[] = [];
  f.state.scope.operationId = scope.operationId;
  f.state.namespace = 'pos-import-v1:' + scope.operationId;
  f.state.authority.customerId = scope.customerId;
  f.state.planHash = scope.planHash;
  f.state.requestHash = scope.requestHash;
  const transportOptions: LegacyImportFinancialOptions = {
    secret: 'synthetic-history-financial-retained-key-'.repeat(2),
    contract: 'pos-legacy-order-import-financial-v1',
    sourceContract: 'pos-legacy-order-import-source-v1',
    publicationContract: 'pos-legacy-order-import-publication-v1',
    confirmationContract: 'pos-legacy-order-import-confirmation-v1',
    sourceUrl: 'https://source.example.test/internal/pos/legacy-order-imports',
    sourceAuthKey: authKey,
    sourceProofKey: proofKey,
    checkout: {
      hs256: 'synthetic-customer-hs256-'.repeat(3),
      hs512: 'synthetic-customer-hs512-'.repeat(3),
      paymentOrderUrl: 'https://payments.example.test/confirm',
      checkoutProjectionContract: 'pos-checkout-projection-v1',
      checkoutProjectionKey: 'synthetic-checkout-projection-key-'.repeat(2),
      refundAllocationContract: 'pos-refund-per-hp-v1',
      refundSourcePatchHash: 'e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11',
    },
    stockContract: 'pos-stock-projection-70b801-v1',
    stockProcedure: async () => undefined,
    orderSchemaContract: 'pos-offline-cash-order-schema-v1',
    fetcher: async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a synthetic JSON body.');
      wires.push(wireSchema.parse(JSON.parse(init.body) as unknown));
      return new Response('{"recorded":true}', { status: 200 });
    },
  };
  const transport = legacyImportFinancialTransport(config, transportOptions);
  await transport.order({
    state: f.state,
    plan: f.plan,
    nonce: crypto.randomUUID(),
    issuedAt: membershipHistoryNow,
    expiresAt: membershipHistoryNow + 60000,
    ...(handoff ? { membershipHistory: handoff } : {}),
  });
  expect(wires).toHaveLength(1);
  return wires[0]!;
}
function sourceHandoff(body: OrderWire, extra: Record<string, unknown> = {}) {
  const python = fileURLToPath(
      new URL(
        '../../compatibility/upstream/offline-cash-pricing/.venv/bin/python',
        import.meta.url,
      ),
    ),
    script = fileURLToPath(
      new URL('../../tools/legacy-order-imports/membership-handoff-oracle.py', import.meta.url),
    ),
    source =
      process.env.POS_LEGACY_IMPORT_SOURCE_ROOT ??
      fileURLToPath(new URL('../../../../backend-tss-api_v2/', import.meta.url)),
    environment: NodeJS.ProcessEnv = { TZ: 'UTC' };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC'])
    if (process.env[name]) environment[name] = process.env[name];
  const result = spawnSync(python, ['-B', script, source], {
    input: JSON.stringify({
      body,
      authKey,
      proofKey,
      historyKey: membershipHistoryKey,
      memberProductIds: options.memberProductIds,
      now: membershipHistoryNow,
      liveSourceTime: '2026-11-17 12:00:27',
      ...extra,
    }),
    env: environment,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
  });
  expect(result.status, 'The private handoff oracle must execute with no SQL/network.').toBe(0);
  expect(result.stderr).toBe('');
  return z.record(z.string(), z.unknown()).parse(JSON.parse(result.stdout) as unknown);
}
function resignWire(body: OrderWire) {
  const { signature: _signature, ...capability } = body.capability;
  body.capability.signature = financialSourceHash(authKey, 'capability', capability);
}
describe('actual private order transport and prepared source membership history', () => {
  it('keeps the old ordinary capability/body field absence', async () => {
    const body = await orderWire();
    expect(Object.keys(body).sort()).toEqual(['capability', 'plan']);
    expect(body.capability).not.toHaveProperty('membershipHistoryHash');
    expect(body.capability).not.toHaveProperty('correctionHash');
  });
  it('binds the complete warehouse handoff and executes literal criteria at the retained wall second', async () => {
    const f = await prepared(),
      body = await orderWire(f.handoff);
    expect(body.capability.expiresAt).toBe(f.handoff.capability.expiresAt);
    expect(body.capability.membershipHistoryHash).toBe(
      financialSourceHash(authKey, 'membership-history', f.handoff),
    );
    expect(sourceHandoff(body)).toMatchObject({
      ok: true,
      eligible: true,
      eligibility: 'source-qualified-history',
      clockRetained: true,
      nativeSessionOpens: 0,
      historicalSqlCalls: 0,
      scopeRestored: true,
    });
  });
  it('composes independently signed correction and history hashes only for order creation', async () => {
    const f = await prepared(),
      body = await orderWire(f.handoff);
    body.capability.correctionHash = 'd'.repeat(64);
    resignWire(body);
    expect(sourceHandoff(body)).toMatchObject({ ok: true, clockRetained: true });
  });
  it.each([
    'missing-body',
    'missing-hash',
    'changed-document',
    'changed-capability',
    'changed-expiry',
    'changed-scope',
    'changed-zone',
    'expired-history',
    'missing-key',
    'reused-auth-key',
  ])('refuses %s before opening a native session', async (kind) => {
    const f = await prepared(),
      body = structuredClone(await orderWire(f.handoff)),
      extra: Record<string, unknown> = {};
    if (kind === 'missing-body') delete body.membershipHistory;
    if (kind === 'missing-hash') delete body.capability.membershipHistoryHash;
    if (kind === 'changed-document') body.membershipHistory!.document.generationId = 'f'.repeat(64);
    if (kind === 'changed-capability')
      body.membershipHistory!.capability.signature = 'f'.repeat(64);
    if (kind === 'changed-expiry') body.membershipHistory!.capability.expiresAt++;
    if (kind === 'changed-scope') body.capability.authority = { customerId: '2' };
    if (kind === 'changed-zone') extra.sourceTimeZone = 'UTC';
    if (kind === 'expired-history') extra.now = f.handoff.capability.expiresAt;
    if (kind === 'missing-key') extra.historyKey = '';
    if (kind === 'reused-auth-key') extra.historyKey = authKey;
    resignWire(body);
    expect(sourceHandoff(body, extra)).toMatchObject({
      ok: false,
      // The order capability is now clipped to its copied history lease, so
      // this boundary is refused before even entering the handoff reader.
      code:
        kind === 'expired-history'
          ? 'ORDER_IMPORT_CAPABILITY_INVALID'
          : 'ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID',
      nativeSessionOpens: 0,
      historicalSqlCalls: 0,
      scopeRestored: true,
    });
  });
  it('isolates concurrent source invocation clocks/readers', async () => {
    const f = await prepared(),
      other = await prepared({
        ...membershipHistoryScope,
        operationId: crypto.randomUUID(),
        customerId: '2',
      }),
      body = await orderWire(f.handoff),
      otherBody = await orderWire(other.handoff);
    const result = sourceHandoff(body, { concurrent: true, bodies: [body, otherBody] });
    expect(result).toMatchObject({
      results: [
        { ok: true, clockRetained: true, eligible: true },
        { ok: true, clockRetained: true, eligible: false },
      ],
      scopeRestored: true,
      nativeSessionOpens: 0,
      historicalSqlCalls: 0,
    });
  });
  it.each([
    { cartValue: 2000.01, numberOfItems: 1, eligible: true, eligibility: 'source-cart-over-2000' },
    { cartValue: 2000, numberOfItems: 0, eligible: false, eligibility: 'no-ordinary-items' },
  ])('retains the source $eligibility short circuit without a history handoff', async (vector) => {
    const body = await orderWire();
    expect(sourceHandoff(body, vector)).toMatchObject({
      ok: true,
      eligible: vector.eligible,
      eligibility: vector.eligibility,
      usedHistory: false,
      nativeSessionOpens: 0,
      historicalSqlCalls: 0,
    });
  });
  it('accepts a bounded legitimate history body above the former256KB limit without logging it', async () => {
    const rows = membershipBigQueryFixture().all;
    rows[0]!.lines = Array.from({ length: 2500 }, (_, index) => ({
      lineId: String(index + 1),
      productId: '11',
      isExclusiveOrder: 1,
    }));
    const f = await prepared(membershipHistoryScope, rows),
      body = await orderWire(f.handoff),
      result = sourceHandoff(body, { http: true });
    expect(result).toMatchObject({
      httpStatus: '200 OK',
      response: { eligible: true, clockRetained: true },
      historicalSqlCalls: 0,
      nativeSessionOpens: 0,
    });
    expect(result.bodyBytes).toBeGreaterThan(256000);
    expect(result.bodyBytes).toBeLessThan(1400000);
    expect(result.loggedFields).toEqual(['eventId', 'module', 'requestId', 'resource', 'userId']);
  });
  it('refuses an oversized private body before parsing or opening a session', async () => {
    const body = await orderWire();
    body.plan = { message: 'x'.repeat(1400000) };
    expect(sourceHandoff(body, { http: true })).toMatchObject({
      httpStatus: '409 Conflict',
      response: { code: 'ORDER_IMPORT_CAPABILITY_INVALID' },
      nativeSessionOpens: 0,
      historicalSqlCalls: 0,
    });
  });
});
