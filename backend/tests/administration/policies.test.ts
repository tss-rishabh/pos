import { describe, expect, it } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import {
  counterName,
  legacyIntegerReference,
  manageableOperator,
  scopedAssignmentDiff,
  storageName,
  stockChangeComment,
  visibilityValue,
} from '../../src/modules/administration/policies.js';
import { checkInExpiry } from '../../src/modules/administration/checkins.js';
import {
  operatorCreateInput,
  stockInput,
  storeInput,
} from '../../src/modules/administration/contracts.js';
import {
  djangoPasswordHash,
  operatorMirrorValues,
} from '../../src/modules/administration/operator-create.js';
import { verifyDjangoPassword } from '../../src/auth/crypto.js';
import type { Principal } from '../../src/domain/access.js';
import {
  nextTerminalName,
  isTerminalNameTaken,
} from '../../src/modules/administration/terminals.js';
import { goldenStdout } from '../golden/load.js';

const oracle = (operation: string, cases: unknown[]): unknown =>
  JSON.parse(
    goldenStdout('administration', 'policies', JSON.stringify({ operation, cases })),
  ) as unknown;
describe('administration semantic parity', () => {
  it('matches source EDC naming including archived ordinals, whitespace and large numbers', () => {
    const cases = [
      { names: [], name: 'Machine 1', activeNames: [] },
      {
        names: ['machine  009', 'Unknown', 'Machine 2'],
        name: ' MACHINE 9 ',
        activeNames: ['machine9'],
      },
      {
        names: ['Machine 9007199254740993', 'machine -1'],
        name: 'other',
        activeNames: ['Machine 1'],
      },
      { names: ['Machine 0', ' machine 2\t'], name: 'Machine 2', activeNames: ['MACHINE\t2'] },
    ];
    expect(
      cases.map((value) => ({
        name: nextTerminalName(value.names),
        taken: isTerminalNameTaken(value.name, value.activeNames),
      })),
    ).toEqual(oracle('terminal', cases));
  });
  it('rejects overflowing legacy INT references before converting to a number', () => {
    expect(legacyIntegerReference('2147483647')).toBe(2147483647);
    for (const id of ['0', '2147483648', '9007199254740993', '18446744073709551615'])
      expect(() => legacyIntegerReference(id)).toThrow('supported legacy reference range');
  });
  it('preserves out-of-scope store assignments and exact legacy messages', () => {
    const cases = Array.from({ length: 40 }, (_, i) => ({
      existing: ['1', '2', ...(i % 2 ? ['3'] : [])],
      submitted:
        i % 4 === 0 ? [] : i % 4 === 1 ? ['1'] : i % 4 === 2 ? ['1', '4'] : ['2', '4', '99'],
      assignable: i % 3 === 0 ? ['1'] : ['1', '4'],
    }));
    expect(
      cases.map((c) => {
        const result = scopedAssignmentDiff(c.existing, c.submitted, c.assignable);
        return { ...result, add: result.add.sort(), remove: result.remove.sort() };
      }),
    ).toEqual(oracle('assignment', cases));
  });
  it('uses source storage prefixes and counts archived counters in their sequence', () => {
    const storages = [
      { storeName: 'Bandra Flagship', name: 'Main' },
      { storeName: 'INDIRANAGAR', name: 'Back room' },
      { storeName: 'Two  Spaces', name: 'A-2' },
    ];
    expect(storages.map((c) => storageName(c.storeName, c.name))).toEqual(
      oracle('storage', storages),
    );
    const counters = [0, 1, 2, 17, 99].map((existing) => ({ existing }));
    expect(counters.map((c) => counterName(c.existing))).toEqual(oracle('counter', counters));
  });
  it('preserves the original end-of-day TTL calculation, including fractional seconds', () => {
    const cases = [
      '2026-11-16T00:00:00.000',
      '2026-11-16T12:35:14.123',
      '2026-11-16T23:59:58.999',
    ].map((local) => ({ local }));
    const actual = cases.map((c) =>
      checkInExpiry(
        Temporal.PlainDateTime.from(c.local).toZonedDateTime('Asia/Kolkata').toInstant(),
      )
        .toZonedDateTimeISO('Asia/Kolkata')
        .toPlainDateTime()
        .toString({ smallestUnit: 'millisecond' }),
    );
    expect(actual).toEqual(oracle('expiry', cases));
  });
  it('preserves availability/listing inversion and stock audit comments', () => {
    expect([
      visibilityValue('available', true),
      visibilityValue('available', false),
      visibilityValue('listed', true),
      visibilityValue('listed', false),
    ]).toEqual([true, false, false, true]);
    expect(stockChangeComment(4, 0)).toBe('Product inventory reduced to zero from admin panel.');
    expect(stockChangeComment(4, 5)).toBe('Product inventory added from admin panel.');
    expect(stockChangeComment(4, 3)).toBe('Product inventory reduced from admin panel.');
  });
});
describe('administration security boundaries', () => {
  const actor: Principal = {
    id: '3',
    name: 'Fixture',
    email: 'fixture@example.test',
    role: 3,
    userType: 1,
    storeIds: ['1'],
  };
  it('blocks self-administration and OPM privilege escalation', () => {
    expect(() => manageableOperator(actor, '3', 3)).toThrow();
    expect(() => manageableOperator(actor, '9', 2)).toThrow();
    expect(() => manageableOperator(actor, '9', 4, 1)).toThrow();
    expect(() => manageableOperator(actor, '9', 4, 5)).not.toThrow();
  });
  it('rejects malformed stock, unknown fields and password mismatches', () => {
    expect(stockInput.safeParse({ stock: -1, expectedStock: 0 }).success).toBe(false);
    expect(stockInput.safeParse({ stock: 1.5, expectedStock: 0 }).success).toBe(false);
    expect(stockInput.safeParse({ stock: 1, expectedStock: 0, storeId: '999' }).success).toBe(
      false,
    );
    expect(
      operatorCreateInput.safeParse({
        firstName: 'Fixture',
        lastName: 'Person',
        email: 'fixture@example.test',
        phone: '9876543210',
        role: 5,
        contactEmail: 'contact@example.test',
        otpMethod: 2,
        userType: 1,
        password: 'long password here',
        confirmPassword: 'different password',
      }).success,
    ).toBe(false);
    expect(storeInput.safeParse({}).success).toBe(false);
  });
  it('stores Django-compatible hashes and leaves the commerce mirror password empty', async () => {
    const value = 'fixture passphrase 42',
      hash = await djangoPasswordHash(value);
    expect(hash).not.toContain(value);
    expect(await verifyDjangoPassword(value, hash)).toBe(true);
    const mirror = operatorMirrorValues(
      10n,
      {
        firstName: 'Fixture',
        lastName: 'Person',
        email: 'fixture@example.test',
        phone: '9876543210',
        role: 5,
        contactEmail: 'contact@example.test',
        otpMethod: 2,
        userType: 1,
      },
      '2026-11-16 10:00:00',
    );
    expect(mirror.password).toBe('');
    expect(mirror.plain_password).toBe('');
    expect(mirror.user_type).toBe('8');
    expect(mirror.pos_admin_id).toBe(10n);
  });
});
