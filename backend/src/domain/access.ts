import { AppError } from './errors.js';

export const roles = { 1: 'Super admin', 2: 'Admin', 3: 'OPM', 4: 'SM', 5: 'Staff' } as const;
export type Role = keyof typeof roles;
export interface Principal {
  id: string;
  name: string;
  email: string;
  role: Role;
  userType: 1 | 2;
  storeIds: string[];
}
export function requireStore(user: Principal, storeId: string): void {
  if (!(user.role === 1 && user.userType === 1) && !user.storeIds.includes(storeId))
    throw new AppError(403, 'STORE_ACCESS_DENIED', 'You do not have access to this store.');
}
export function scopedStores(user: Principal, requested?: string[]): string[] {
  const selection = requested?.length ? [...new Set(requested)] : user.storeIds;
  selection.forEach((id) => requireStore(user, id));
  return selection;
}
export function requireRole(user: Principal, allowed: Role[]): void {
  if (!allowed.includes(user.role))
    throw new AppError(403, 'ROLE_ACCESS_DENIED', 'Your role cannot perform this action.');
}
