import { randomUUID } from 'node:crypto';
import {
  couponSourceCaptureHash,
  couponControlHeadHash,
  couponFactsHash,
  couponSourceCaptureContract,
  couponSourceQueryContract,
  couponHistoryWritersContract,
  type CouponSourceCapture,
} from '../../src/modules/legacy-order-imports/benefit-profile/history-publication.js';
import { couponHistoryWritersDefinitionHash } from '../../src/modules/legacy-order-imports/benefit-profile/history-writers.js';
import type { CouponHistoryScope } from '../../src/modules/legacy-order-imports/benefit-profile/history.js';
const authority = {
  sourceKey: 'isolated-coupon-source-capture-key-'.repeat(3),
  publicationKey: 'isolated-coupon-publication-key-'.repeat(3),
  historyKey: 'isolated-coupon-history-key-'.repeat(3),
};
const now = Date.parse('2026-06-15T06:30:01Z');
export function publicationFixture(empty = false) {
  const scope: CouponHistoryScope = {
    contract: 'pos-csv-coupon-history-v1',
    operationId: randomUUID(),
    requestHash: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    customerId: '9007199254740993',
    couponId: '222',
    configurationHash: 'c'.repeat(64),
    asOf: '2026-06-15 12:00:00',
    sourceTimeZone: 'Asia/Kolkata',
  };
  const heads: CouponSourceCapture['heads'] = [
    { kind: 'controls', scopeId: '0', revision: '1' },
    { kind: 'coupon', scopeId: scope.couponId, revision: '9007199254740993' },
    { kind: 'customer', scopeId: scope.customerId, revision: '9007199254740994' },
  ];
  const facts: CouponSourceCapture['facts'] = {
    globalUsage: empty ? '0' : '3',
    birthdayTodayUsage: empty ? '0' : '1',
    customerOrderCount: empty ? '0' : '4',
    monthlyJoinedUsage: empty ? '0' : '9',
    lotCounts: empty
      ? []
      : [
          {
            couponId: '222',
            sameCode: true,
            noTimesAllowed: '1000',
            uniqueNoTimesAllowed: '10',
            usedCount: '9',
          },
          {
            couponId: '223',
            sameCode: false,
            noTimesAllowed: '1000',
            uniqueNoTimesAllowed: '10',
            usedCount: '2',
          },
        ],
  };
  const body: Omit<CouponSourceCapture, 'signature'> = {
    contract: couponSourceCaptureContract,
    sourceCommit: '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
    queryContract: couponSourceQueryContract,
    writersContract: couponHistoryWritersContract,
    writersDefinitionHash: couponHistoryWritersDefinitionHash,
    scope,
    generationId: 'd'.repeat(64),
    snapshotId: randomUUID(),
    serverUuid: randomUUID(),
    sourceSchema: 'isolated_coupon_history',
    capturedAt: now - 500,
    finishedAt: now - 400,
    heads,
    controlHeadHash: '0'.repeat(64),
    couponInputHash: 'e'.repeat(64),
    facts,
    factsHash: couponFactsHash(scope, facts, authority.sourceKey),
  };
  body.controlHeadHash = couponControlHeadHash(body, authority.sourceKey);
  const capture = { ...body, signature: couponSourceCaptureHash(body, authority.sourceKey) };
  const warehouse = {
    generationId: capture.generationId,
    snapshotId: capture.snapshotId,
    sourceCaptureHash: capture.signature,
    controlHeadHash: capture.controlHeadHash,
    sourceCdcThrough: now - 100,
    facts: structuredClone(facts),
  };
  return { scope, capture, warehouse, authority, now };
}
