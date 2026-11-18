import type { Principal } from '../domain/access.js';
import type { ActiveAccountReader, SessionAccount } from './sessions.js';

/**
 * Isolated demo workspace only (DEMO_MODE, refused in production). Lets the synthetic
 * operator hold a Redis session without a database. Delete together with DEMO_MODE.
 */
export function demoAccountReader(user: Principal): ActiveAccountReader {
  const row: SessionAccount = {
    id: BigInt(user.id),
    username: 'demo',
    password: '!demo-session-without-password',
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
  return async (userId) => (userId === user.id ? { ...row } : undefined);
}
