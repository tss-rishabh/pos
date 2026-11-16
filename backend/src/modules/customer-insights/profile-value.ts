import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { MUser } from '../../db/legacy-schema.js';
import type { CustomerProfile } from './contracts.js';

export const customerProfileSelection = {
  firstName: MUser.firstname,
  lastName: MUser.lastname,
  email: MUser.email,
  telephone: MUser.telephone,
  gender: MUser.gender,
  birthday: MUser.birthdate,
  anniversary: MUser.anniversary,
  customerType: MUser.customer_type,
  gstin: MUser.gstin,
};
type ProfileRow = { [Field in keyof CustomerProfile['profile']]: string | null };

/** Legacy MySQL zero/partial dates decode to None in Django's date converter. */
export function customerProfileDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return null;
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString();
  } catch {
    return null;
  }
}
export function customerProfileValue(profile: ProfileRow): CustomerProfile['profile'] {
  return {
    firstName: profile.firstName ?? '',
    lastName: profile.lastName ?? '',
    email: profile.email ?? '',
    telephone: profile.telephone ?? '',
    gender:
      profile.gender === 'M' || profile.gender === 'F' || profile.gender === 'O'
        ? profile.gender
        : null,
    birthday: customerProfileDate(profile.birthday),
    anniversary: customerProfileDate(profile.anniversary),
    customerType:
      profile.customerType === 'B2B' || profile.customerType === 'B2C'
        ? profile.customerType
        : null,
    gstin: profile.gstin || null,
  };
}
export function customerProfileEtag(value: CustomerProfile['profile']): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
