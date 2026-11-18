import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  nativeHeadCallerGrants,
  nativeHeadLimits,
  nativeHeadMetadataDocument,
} from '../../src/modules/screening-origins/native-head-capacity.js';
import { nativeHeadDescriptor } from '../../src/modules/screening-origins/native-head-metadata.generated.js';

const grant = 'GRANT SELECT ON `fixture`.`table` TO `fixture`@`localhost`';
const rows = (count: number, value = grant) =>
  Array.from({ length: count }, () => ({ grant: value }));
const vectors: unknown[] = [
  rows(64),
  rows(65),
  rows(229),
  rows(512),
  rows(513),
  [],
  [{}],
  [{ grant: null }],
  [{ grant, extra: grant }],
  [{ grant: '' }],
  [null],
  rows(1, 'é'.repeat(4096)),
  rows(1, 'é'.repeat(4096) + 'a'),
  rows(512, 'a'.repeat(1024)),
  [...rows(511, 'a'.repeat(1024)), { grant: 'a'.repeat(1025) }],
  rows(1, '\ud800'),
];
describe('shared native-head capacity, never a privilege-policy override', () => {
  it('preserves complete grant boundaries and agrees with the actual Python helper in UTF-8 bytes', () => {
    const python = JSON.parse(
      execFileSync(
        'compatibility/upstream/offline-cash-pricing/.venv/bin/python',
        ['tools/native-head-metadata/capacity-vectors.py'],
        {
          input: JSON.stringify({ grants: vectors }),
          encoding: 'utf8',
          maxBuffer: 64 * 1024,
        },
      ),
    ) as { limits: unknown; grants: boolean[]; metadata: boolean[] };
    expect(python.limits).toEqual(nativeHeadLimits);
    expect(vectors.map((value) => nativeHeadCallerGrants(value) !== undefined)).toEqual(
      python.grants,
    );
    expect(python.grants).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      true,
      false,
      false,
    ]);
    const max = nativeHeadLimits.metadataBytes;
    const documents = [
      '"' + 'a'.repeat(max - 2) + '"',
      '"' + 'a'.repeat(max - 1) + '"',
      '"' + 'é'.repeat((max - 2) / 2) + '"',
      '"' + 'é'.repeat(max / 2) + '"',
      '{',
      'NaN',
      Buffer.from([34, 255, 34]),
    ];
    expect(documents.map((value) => nativeHeadMetadataDocument(value) !== undefined)).toEqual(
      python.metadata,
    );
    expect(python.metadata).toEqual([true, false, true, false, false, false, false]);
  });
  it('generates every capacity from the reviewed numeric source and pins its SQL sentinel without changing other sections', () => {
    const source = JSON.parse(
      readFileSync('compatibility/upstream/screening-origins/native-head-limits.json', 'utf8'),
    ) as unknown;
    expect(nativeHeadLimits).toEqual(source);
    const sql = readFileSync(
      'compatibility/upstream/screening-origins/history-security.review.sql',
      'utf8',
    );
    expect(sql).toContain('FROM INFORMATION_SCHEMA.COLUMN_PRIVILEGES\n  LIMIT 4097');
    expect(sql.match(/LIMIT 4097\b/g)).toHaveLength(1);
    expect(sql.match(/LIMIT 1001\b/g)?.length).toBeGreaterThan(10);
    expect(sql).toMatch(/RETURN \/\* native-head-capacity:[a-f0-9]{64} \*\/ JSON_OBJECT/);
    expect(nativeHeadDescriptor.limits).toEqual(nativeHeadLimits);
  });
  it('keeps measured native rights separate from the whole-install participant budget', () => {
    const catalog = JSON.parse(
      readFileSync('tools/native-head-metadata/node-writer-minimum.review.json', 'utf8'),
    ) as {
      measured: {
        requiredDmlTables: number;
        requiredReadOrWriteTables: number;
        explicitPrivilegeCells: number;
      };
      tables: { table: string; actions: string[] }[];
      declaredParticipantBudget: { accounts: number; privilegeCellsEach: number }[];
    };
    expect(new Set(catalog.tables.map((row) => row.table)).size).toBe(281);
    expect(
      catalog.tables.filter((row) => row.actions.some((right) => right !== 'SELECT')),
    ).toHaveLength(229);
    expect(catalog.tables.reduce((total, row) => total + row.actions.length, 0)).toBe(651);
    const planned = catalog.declaredParticipantBudget.reduce(
      (total, row) => total + row.accounts * row.privilegeCellsEach,
      0,
    );
    expect(planned).toBe(3888);
    expect(planned).toBeLessThan(nativeHeadLimits.privilegeRows);
  });
});
