import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { goldenStdout } from '../golden/load.js';

const outcome = z.object({
  kind: z.string(),
  error: z.string().nullable().optional(),
  parentExists: z.boolean().optional(),
  previewModels: z.array(z.string()).optional(),
  protected: z.number().optional(),
  child: z.object({ exists: z.boolean(), reference: z.number().nullable() }).nullable().optional(),
  committedDeletionLogDelta: z.number().optional(),
  authoredLogsRemaining: z.number().optional(),
  memberExists: z.boolean().optional(),
  membershipsRemaining: z.number().optional(),
  authorized: z.boolean().optional(),
  superusersBefore: z.number().optional(),
  operatorExists: z.boolean().optional(),
  remainingAuthoredLogs: z.number().optional(),
});
const evidence = z.object({
  sourceCommit: z.literal('78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'),
  djangoVersion: z.literal('4.2.5'),
  database: z.literal('SQLite :memory: only'),
  frameworkHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  inheritedDeleteMethods: z.object({ UserAdmin: z.literal(true), GroupAdmin: z.literal(true) }),
  collectorCases: z.array(outcome),
  deletePermissionCases: z
    .array(
      z.object({
        account: z.object({
          active: z.boolean(),
          staff: z.boolean(),
          superuser: z.boolean(),
          directDelete: z.boolean(),
          groupDelete: z.boolean(),
        }),
        siteAllowed: z.boolean(),
        modelDeleteAllowed: z.boolean(),
        combinedAllowed: z.boolean(),
      }),
    )
    .length(32),
  registeredTargetRelations: z.array(z.object({ target: z.string(), onDelete: z.string() })),
  scalarOperatorCandidates: z.array(z.object({ field: z.string() })),
  destructiveEndpointsImplemented: z.literal(false),
});
describe('pinned Django delete collector and administration contracts', () => {
  const source = () =>
    evidence.parse(JSON.parse(goldenStdout('administration-history', 'collector')) as unknown);
  it('executes the source-pinned single/bulk paths and exposes committed false audit after a failed bulk delete', () => {
    const value = source(),
      cases = new Map(value.collectorCases.map((item) => [item.kind, item]));
    expect(value.frameworkHashes).toHaveProperty('auth-admin');
    expect(value.frameworkHashes).toHaveProperty('admin-site');
    expect(cases.get('SingleDelete')).toMatchObject({
      error: 'IntegrityError',
      parentExists: true,
      committedDeletionLogDelta: 0,
    });
    expect(cases.get('BulkDelete')).toMatchObject({
      error: 'IntegrityError',
      parentExists: true,
      committedDeletionLogDelta: 1,
    });
  });
  it('proves DO_NOTHING/scalar orphan behavior, source cascade/protection/nulling, actor-log erasure and last-superuser self deletion', () => {
    const cases = new Map(source().collectorCases.map((item) => [item.kind, item]));
    expect(cases.get('Restricted')).toMatchObject({
      previewModels: ['parent'],
      protected: 0,
      error: 'IntegrityError',
      parentExists: true,
      child: { exists: true },
    });
    for (const name of ['Unconstrained', 'ScalarReference'])
      expect(cases.get(name)).toMatchObject({
        previewModels: ['parent'],
        protected: 0,
        error: null,
        parentExists: false,
        child: { exists: true },
      });
    expect(cases.get('Cascading')).toMatchObject({
      previewModels: ['cascading', 'parent'],
      error: null,
      parentExists: false,
      child: { exists: false },
    });
    expect(cases.get('Protected')).toMatchObject({
      protected: 1,
      error: 'ProtectedError',
      parentExists: true,
    });
    expect(cases.get('Nullable')).toMatchObject({
      error: null,
      parentExists: false,
      child: { exists: true, reference: null },
    });
    expect(cases.get('AuthoredLogCascade')).toMatchObject({ authoredLogsRemaining: 0 });
    expect(cases.get('GroupMembershipCascade')).toMatchObject({
      memberExists: true,
      membershipsRemaining: 0,
    });
    expect(cases.get('SelfLastSuperuserDelete')).toMatchObject({
      authorized: true,
      superusersBefore: 1,
      error: null,
      operatorExists: false,
      remainingAuthoredLogs: 0,
    });
  });
  it('derives actual current-source staff/model-delete permissions and inventories every named source Store relation', () => {
    const value = source();
    for (const row of value.deletePermissionCases) {
      const account = row.account;
      expect(row.siteAllowed).toBe(account.active && account.staff);
      expect(row.modelDeleteAllowed).toBe(
        account.active && (account.superuser || account.directDelete || account.groupDelete),
      );
      expect(row.combinedAllowed).toBe(
        account.active &&
          account.staff &&
          (account.superuser || account.directDelete || account.groupDelete),
      );
    }
    expect(value.registeredTargetRelations).toHaveLength(8);
    expect(
      value.registeredTargetRelations.every(
        (row) => row.target === 'Store' && row.onDelete === 'models.DO_NOTHING',
      ),
    ).toBe(true);
    expect(value.scalarOperatorCandidates.map((row) => row.field)).toEqual(
      expect.arrayContaining(['closed_by_id', 'updated_by_id', 'export_requested_by']),
    );
  });
});
