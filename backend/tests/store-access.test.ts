import { describe, expect, it } from 'vitest';
import { requireStore, scopedStores, type Principal, type Role } from '../src/domain/access.js';

const operator: Principal = {
  id: '7',
  name: 'Fixture operator',
  email: '',
  role: 1,
  userType: 2,
  storeIds: ['10'],
};
describe('organization and store boundary', () => {
  it('denies unassigned cross-store reads/actions for every franchise role, including role1', () => {
    for (const role of [1, 2, 3, 4, 5] as const) {
      const user = { ...operator, role };
      expect(() => requireStore(user, '20')).toThrowError(
        expect.objectContaining({ code: 'STORE_ACCESS_DENIED', status: 403 }),
      );
      expect(() => scopedStores(user, ['10', '20'])).toThrowError(
        expect.objectContaining({ code: 'STORE_ACCESS_DENIED', status: 403 }),
      );
      expect(() => requireStore(user, '10')).not.toThrow();
    }
  });
  it('keeps internal super-admin scope and assigned-only access for other internal roles', () => {
    expect(() => requireStore({ ...operator, userType: 1 }, '20')).not.toThrow();
    for (const role of [2, 3, 4, 5] satisfies Role[])
      expect(() => requireStore({ ...operator, userType: 1, role }, '20')).toThrowError(
        expect.objectContaining({ code: 'STORE_ACCESS_DENIED' }),
      );
  });
  it('uses explicit assigned scope for omitted filters and rejects the entire mixed scope', () => {
    expect(scopedStores(operator)).toEqual(['10']);
    expect(scopedStores(operator, [])).toEqual(['10']);
    expect(scopedStores(operator, ['10', '10'])).toEqual(['10']);
    expect(() => scopedStores({ ...operator, storeIds: [] }, ['10'])).toThrowError(
      expect.objectContaining({ code: 'STORE_ACCESS_DENIED' }),
    );
    expect(scopedStores({ ...operator, storeIds: [] })).toEqual([]);
  });
});
