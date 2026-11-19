import type { Principal } from '../../src/domain/access.js';
import type { ActiveAccountReader, SessionAccount } from '../../src/auth/sessions.js';

/** Synthetic store operator for unit tests that inject services instead of reading MySQL. */
export const syntheticOperator: Principal = {
  userType: 1,
  id: '900001',
  name: 'Synthetic operator',
  email: 'operator@example.test',
  role: 4,
  storeIds: ['1', '2'],
};

/** The `pos_user` row shape `activeAccountReader` returns, for the synthetic operator. */
export function syntheticSessionAccount(user: Principal = syntheticOperator): SessionAccount {
  return {
    id: BigInt(user.id),
    username: 'synthetic-operator',
    password: 'pbkdf2_sha256$600000$fixture$fixture',
    first_name: user.name,
    last_name: '',
    is_active: true,
    is_staff: false,
    is_superuser: false,
    last_login: null,
    date_joined: '2026-01-01 00:00:00',
    role: user.role,
    gender: null,
    age: null,
    phone: null,
    email: user.email,
    is_mfa: false,
    mfa_hash: null,
    profile_image: '',
    cover_image: '',
    contact_email: null,
    otp_method: 2,
    user_type: user.userType,
  };
}

/** Injected fake of `activeAccountReader(db)` that knows only one account. */
export function singleAccountReader(user: Principal = syntheticOperator): ActiveAccountReader {
  const row = syntheticSessionAccount(user);
  return async (userId) => (userId === user.id ? { ...row } : undefined);
}
