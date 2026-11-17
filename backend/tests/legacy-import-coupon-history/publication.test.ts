import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  verifyCouponSourceCapture,
  sealCouponHistoryPublication,
  qualifyCouponPublishedFacts,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import {
  couponHistoryWritersDefinitionHash,
  couponHistoryWriterDefinitions,
  assertCouponHistoryWriterDefinitions,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import { preloadCouponHistory } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';

import { publicationFixture } from './fixtures.js';

describe('independent complete coupon history publication', () => {
  it.each([false, true])(
    'qualifies actual fact results only after a signed source and independent warehouse agreement (empty=%s)',
    async (empty) => {
      const f = publicationFixture(empty),
        before = structuredClone(f.capture);
      const publication = sealCouponHistoryPublication(f.capture, f.warehouse, f.authority, f.now),
        document = qualifyCouponPublishedFacts(
          publication,
          f.scope,
          f.warehouse.facts,
          f.authority,
          f.now,
        );
      expect(document).toMatchObject({
        reader: 'bigquery',
        complete: true,
        ...f.capture.facts,
        publication: {
          controlHeadHash: f.capture.controlHeadHash,
          sourceCaptureHash: f.capture.signature,
        },
      });
      expect(
        await preloadCouponHistory(
          { read: async () => document },
          f.scope,
          f.authority.historyKey,
          () => f.now,
        ),
      ).toEqual(document);
      expect(f.capture).toEqual(before);
    },
  );
  it.each([
    'globalUsage',
    'birthdayTodayUsage',
    'customerOrderCount',
    'monthlyJoinedUsage',
  ] as const)(
    'refuses a different warehouse %s result instead of copying a source count',
    (name) => {
      const f = publicationFixture();
      f.warehouse.facts[name] = '0';
      expect(() =>
        sealCouponHistoryPublication(f.capture, f.warehouse, f.authority, f.now),
      ).toThrow();
    },
  );
  it.each(['missing', 'duplicate', 'same-code', 'multiplication', 'allowance'])(
    'refuses %s lot differences',
    (change) => {
      const f = publicationFixture();
      if (change === 'missing') f.warehouse.facts.lotCounts.pop();
      if (change === 'duplicate') f.warehouse.facts.lotCounts.push(f.warehouse.facts.lotCounts[0]!);
      if (change === 'same-code') f.warehouse.facts.lotCounts[0]!.sameCode = false;
      if (change === 'multiplication') f.warehouse.facts.lotCounts[0]!.usedCount = '3';
      if (change === 'allowance') f.warehouse.facts.lotCounts[0]!.uniqueNoTimesAllowed = '11';
      expect(() =>
        sealCouponHistoryPublication(f.capture, f.warehouse, f.authority, f.now),
      ).toThrow();
    },
  );
  it.each(['generationId', 'snapshotId', 'sourceCaptureHash', 'controlHeadHash'] as const)(
    'does not combine another %s with genuine current facts',
    (name) => {
      const f = publicationFixture();
      f.warehouse[name] = name === 'snapshotId' ? randomUUID() : 'f'.repeat(64);
      expect(() =>
        sealCouponHistoryPublication(f.capture, f.warehouse, f.authority, f.now),
      ).toThrow();
    },
  );
  it('requires complete/fresh CDC and independent keys, including for empty native counts', () => {
    const f = publicationFixture(true);
    expect(() =>
      sealCouponHistoryPublication(
        f.capture,
        { ...f.warehouse, sourceCdcThrough: f.capture.finishedAt - 1 },
        f.authority,
        f.now,
      ),
    ).toThrow();
    expect(() =>
      sealCouponHistoryPublication(
        f.capture,
        { ...f.warehouse, sourceCdcThrough: f.now + 1 },
        f.authority,
        f.now,
      ),
    ).toThrow();
    expect(() =>
      sealCouponHistoryPublication(f.capture, f.warehouse, f.authority, f.now + 60001),
    ).toThrow();
    expect(() =>
      sealCouponHistoryPublication(
        f.capture,
        f.warehouse,
        { ...f.authority, sourceKey: f.authority.publicationKey },
        f.now,
      ),
    ).toThrow();
  });
  it('rejects repackaged warehouse facts, scopes and seals at the actual reader boundary', () => {
    const f = publicationFixture(),
      p = sealCouponHistoryPublication(f.capture, f.warehouse, f.authority, f.now);
    expect(() =>
      qualifyCouponPublishedFacts(
        p,
        { ...f.scope, operationId: randomUUID() },
        f.warehouse.facts,
        f.authority,
        f.now,
      ),
    ).toThrow();
    expect(() =>
      qualifyCouponPublishedFacts(
        p,
        f.scope,
        { ...f.warehouse.facts, monthlyJoinedUsage: '3' },
        f.authority,
        f.now,
      ),
    ).toThrow();
    expect(() =>
      qualifyCouponPublishedFacts(
        { ...p, seal: '0'.repeat(64) },
        f.scope,
        f.warehouse.facts,
        f.authority,
        f.now,
      ),
    ).toThrow();
    expect(() =>
      qualifyCouponPublishedFacts(p, f.scope, f.warehouse.facts, f.authority, f.now + 60001),
    ).toThrow();
  });
  it('retains exact native head revisions above Number.MAX_SAFE_INTEGER and rejects mutation', () => {
    const f = publicationFixture();
    expect(
      verifyCouponSourceCapture(f.capture, f.authority.sourceKey, f.now).heads[1]?.revision,
    ).toBe('9007199254740993');
    f.capture.heads[1]!.revision = '9007199254740992';
    expect(() => verifyCouponSourceCapture(f.capture, f.authority.sourceKey, f.now)).toThrow();
  });
  it('qualifies installed mutation bodies rather than accepting a writer-contract flag', () => {
    const rows = couponHistoryWriterDefinitions.map((value) => ({ ...value }));
    expect(assertCouponHistoryWriterDefinitions(rows)).toBe(couponHistoryWritersDefinitionHash);
    expect(() => assertCouponHistoryWriterDefinitions(rows.slice(1))).toThrow();
    rows[0]!.statement = rows[0]!.statement.replace('revision=revision+1', 'revision=revision');
    expect(() => assertCouponHistoryWriterDefinitions(rows)).toThrow();
  });
});
