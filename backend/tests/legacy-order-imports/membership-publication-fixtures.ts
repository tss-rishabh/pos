import {
  csvMembershipSourceCaptureContract,
  csvMembershipSourceCaptureHash,
  csvMembershipSourceCommit,
  type CsvMembershipSourceCapture,
  type CsvMembershipWarehouseFacts,
} from '../../src/modules/legacy-order-imports/membership-profile/publication.js';
import {
  membershipBigQueryFixture,
  membershipHistoryAuthority,
  membershipHistoryNow,
  membershipHistoryScope,
  type MembershipFixtureOrder,
} from './membership-bigquery-fixtures.js';

export const membershipSourceKey = 'synthetic-source-capture-private-key-'.repeat(2);
export const publicationAuthority = {
  sourceKey: membershipSourceKey,
  ...membershipHistoryAuthority,
};
export const membershipCandidateView =
  'tssgcp2025.tss_mysql_raw_layer.fixture_membership_candidates';
export function sourceCaptureFixture(rows?: MembershipFixtureOrder[]): CsvMembershipSourceCapture {
  const fixture = membershipBigQueryFixture(rows),
    pub = fixture.envelope.publications[0]!;
  const body: Omit<CsvMembershipSourceCapture, 'signature'> = {
    contract: csvMembershipSourceCaptureContract,
    sourceCommit: csvMembershipSourceCommit,
    scope: membershipHistoryScope,
    generationId: pub.generationId,
    sourceSnapshotId: '5f553b79-0885-4fd2-8819-8cffddba763a',
    sourceTimeZone: 'Asia/Kolkata',
    sourceSchema: 'fixture_source',
    sourceServerUuid: 'f53e539b-2e52-49d3-8d01-158ca5f5e10c',
    capturedAt: membershipHistoryNow - 2500,
    finishedAt: membershipHistoryNow - 500,
    orderCount: pub.sourceOrderCount,
    selectedOrderCount: pub.sourceSelectedOrderCount,
    lineCount: pub.sourceLineCount,
    historyHash: pub.sourceHistoryHash,
    selection: fixture.selection,
  };
  return { ...body, signature: csvMembershipSourceCaptureHash(body, membershipSourceKey) };
}
export function warehouseCaptureFixture(
  capture = sourceCaptureFixture(),
  rows?: MembershipFixtureOrder[],
): CsvMembershipWarehouseFacts {
  const fixture = membershipBigQueryFixture(rows);
  return {
    controls: [
      {
        generationId: capture.generationId,
        customerId: capture.scope.customerId,
        asOf: capture.scope.asOf,
        cutoff: capture.scope.cutoff,
        sourceTimeZone: capture.sourceTimeZone,
        sourceSnapshotId: capture.sourceSnapshotId,
        sourceCaptureHash: capture.signature,
        sourceCdcThrough: '2026-11-17T06:30:02.000000Z',
        candidateComplete: true,
      },
    ],
    actual: fixture.envelope.actual,
    orders: fixture.envelope.orders,
    lines: fixture.envelope.lines,
  };
}
