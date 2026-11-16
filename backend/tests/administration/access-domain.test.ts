import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  accessVersion,
  hasModelPermission,
  mayEnterModelAdministration,
  validateAccessSnapshot,
} from '../../src/modules/administration/access-domain.js';

describe('source-pinned Django model administration semantics', () => {
  it('matches all32 native Django4.2.5 active/staff/superuser/direct/group combinations', () => {
    const oracle = z
      .object({
        djangoVersion: z.literal('4.2.5'),
        cases: z
          .array(
            z.object({
              account: z.object({
                isActive: z.boolean(),
                isStaff: z.boolean(),
                isSuperuser: z.boolean(),
              }),
              grants: z.array(z.string()),
              site: z.boolean(),
              permissions: z.record(z.string(), z.boolean()),
            }),
          )
          .length(32),
      })
      .parse(
        JSON.parse(
          readFileSync(
            new URL('../../parity/administration-access-oracle.json', import.meta.url),
            'utf8',
          ),
        ) as unknown,
      );
    for (const example of oracle.cases) {
      expect(mayEnterModelAdministration(example.account)).toBe(example.site);
      for (const [key, allowed] of Object.entries(example.permissions))
        expect(hasModelPermission(example.account, new Set(example.grants), key)).toBe(allowed);
    }
  });
  const valid = () => ({
    version: 1,
    sourceVerified: true,
    sourceFingerprint: 'a'.repeat(64),
    exportedAt: '2026-11-16T00:00:00Z',
    permissions: [
      {
        key: 'stores.change_store',
        appLabel: 'stores',
        model: 'store',
        codename: 'change_store',
        name: 'Can change store',
      },
    ],
    groups: [{ legacyId: '10', name: 'Fixture group', permissionKeys: ['stores.change_store'] }],
    operators: [
      { id: '1', isStaff: true, isSuperuser: true, legacyGroupIds: ['10'], permissionKeys: [] },
    ],
  });
  it('rejects ambiguous stable keys, duplicate users and unresolved grant joins without dropping them', () => {
    const input = valid();
    expect(() =>
      validateAccessSnapshot({
        ...input,
        permissions: [...input.permissions, { ...input.permissions[0]!, model: 'other_store' }],
      }),
    ).toThrow('duplicate or ambiguous');
    expect(() =>
      validateAccessSnapshot({ ...input, operators: [...input.operators, input.operators[0]!] }),
    ).toThrow('duplicate or ambiguous');
    expect(() =>
      validateAccessSnapshot({
        ...input,
        groups: [{ ...input.groups[0]!, permissionKeys: ['stores.delete_store'] }],
      }),
    ).toThrow('unresolved grants');
    expect(() =>
      validateAccessSnapshot({
        ...input,
        operators: [{ ...input.operators[0]!, legacyGroupIds: ['999'] }],
      }),
    ).toThrow('unresolved grants');
    expect(() => validateAccessSnapshot({ ...input, sourceVerified: false })).toThrow();
  });
  it('produces stable snapshot receipts independent of source row/join order', () => {
    const input = valid(),
      extended = {
        ...input,
        permissions: [
          ...input.permissions,
          {
            key: 'stores.view_store',
            appLabel: 'stores',
            model: 'store',
            codename: 'view_store',
            name: 'Can view store',
          },
        ],
        groups: [
          { ...input.groups[0]!, permissionKeys: ['stores.change_store', 'stores.view_store'] },
        ],
      };
    const reversed = {
      ...extended,
      permissions: [...extended.permissions].reverse(),
      groups: extended.groups.map((group) => ({
        ...group,
        permissionKeys: [...group.permissionKeys].reverse(),
      })),
    };
    expect(validateAccessSnapshot(extended).hash).toBe(validateAccessSnapshot(reversed).hash);
    expect(accessVersion([1n, 'x'])).toBe(accessVersion(['1', 'x']));
  });
  it('previews imports without a database configuration and emits static errors without source data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pos-access-snapshot-')),
      path = join(directory, 'snapshot.json');
    try {
      writeFileSync(path, JSON.stringify(valid()));
      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'tools/administration/reconcile-access.ts', path],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            MYSQL_WRITER_URL: '',
            MYSQL_PRIMARY_READER_URL: '',
            ADMIN_ACCESS_SOURCE_VERIFIED: '',
          },
        },
      );
      const event = z
        .object({
          eventId: z.literal('administration.model-administration-access-import.preview'),
          requestId: z.uuid(),
          userId: z.null(),
          snapshotHash: z.string(),
          counts: z.object({
            operators: z.literal(1),
            groups: z.literal(1),
            memberships: z.literal(1),
          }),
        })
        .parse(JSON.parse(output) as unknown);
      expect(event.snapshotHash).toHaveLength(64);
      expect(output).not.toContain('Fixture group');
      writeFileSync(path, '{private-canary@example.test');
      const invalid = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'tools/administration/reconcile-access.ts', path],
        { encoding: 'utf8' },
      );
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toContain('ADMIN_ACCESS_IMPORT_JSON');
      expect(invalid.stdout + invalid.stderr).not.toContain('private-canary@example.test');
      expect(invalid.stdout).not.toContain(path);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);
});
