import { and, eq, or, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import { PosUser, UserStore } from '../db/legacy-schema.js';
import type { Databases } from '../db/pools.js';
import type { Principal, Role } from '../domain/access.js';
import { roles } from '../domain/access.js';
import { AppError } from '../domain/errors.js';
import { verifyDjangoPassword } from './crypto.js';
import { currentAuthenticationVersion } from './revocation.js';
import type { SessionTransaction } from './sessions.js';

export interface IdentityService {
  get(id: string): Promise<Principal | null>;
  login(username: string, password: string): Promise<PasswordIdentity>;
  challengeIdentity(
    id: string,
    transaction?: SessionTransaction,
    lock?: 'share' | 'update',
  ): Promise<PasswordIdentity | null>;
  byVerifiedEmail(email: string): Promise<Principal | null>;
  close(): Promise<void>;
}
export interface PasswordIdentity {
  user: Principal;
  authVersion: string;
  useTotp: boolean;
  totpSecret: string | null;
  phone: string | null;
  contactEmail: string | null;
  firstName: string;
  otpMethod: 'sms' | 'email';
}
export function identityService(config: Config, databases: Databases): IdentityService {
  // Executable legacy settings map default and mysql_db to MYSQL_DB_NAME.
  // README's PostgreSQL description is stale; verified MySQL pos_user contains
  // AbstractUser's inherited columns as well as the source-declared fields.
  // Authentication and revocation require writer-current access decisions.
  const database = () => databases.get('writer');
  async function principal(
    row: typeof PosUser.$inferSelect,
    transaction?: SessionTransaction,
  ): Promise<Principal | null> {
    if (!row.is_active || !(row.role in roles) || !(row.user_type === 1 || row.user_type === 2))
      return null;
    const assignments = await (transaction ?? database())
      .select({ id: UserStore.store_id })
      .from(UserStore)
      .where(eq(UserStore.django_user_id, row.id));
    return {
      id: String(row.id),
      name: `${row.first_name} ${row.last_name}`.trim() || row.username,
      email: row.email || '',
      role: row.role as Role,
      userType: row.user_type,
      storeIds: assignments.filter((r) => r.id !== null).map((r) => String(r.id)),
    };
  }
  async function passwordIdentity(
    row: typeof PosUser.$inferSelect,
    transaction?: SessionTransaction,
  ): Promise<PasswordIdentity | null> {
    const user = await principal(row, transaction);
    return user
      ? {
          user,
          authVersion: await currentAuthenticationVersion(transaction ?? database(), row),
          useTotp: Boolean(row.is_mfa),
          totpSecret: row.mfa_hash,
          phone: row.phone,
          contactEmail: row.contact_email,
          firstName: row.first_name,
          otpMethod: row.otp_method === 1 ? 'sms' : 'email',
        }
      : null;
  }
  return {
    async get(id) {
      const [row] = await database()
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(id)))
        .limit(1);
      return row ? principal(row) : null;
    },
    async login(username, password) {
      const rows = await database()
        .select()
        .from(PosUser)
        .where(
          or(
            eq(PosUser.username, username),
            sql`lower(${PosUser.email})=${username.toLowerCase()}`,
          ),
        )
        .limit(2);
      const row = rows.length === 1 ? rows[0] : undefined;
      // Perform a fixed-cost verification for absent usernames as well.
      const valid = await verifyDjangoPassword(
        password,
        row?.password ||
          'pbkdf2_sha256$600000$invalid-user$dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHQ=',
      );
      if (!row || !valid || !row.is_active)
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Check your email and password.');
      const proof = await passwordIdentity(row);
      if (!proof) throw new AppError(403, 'ACCOUNT_DISABLED', 'Your account is disabled.');
      return proof;
    },
    async challengeIdentity(id, transaction, lock = 'share') {
      const query = (transaction ?? database())
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(id)))
        .limit(1);
      const [row] = transaction ? await query.for(lock) : await query;
      return row ? passwordIdentity(row, transaction) : null;
    },
    async byVerifiedEmail(email) {
      const rows = await database()
        .select()
        .from(PosUser)
        .where(
          and(sql`lower(${PosUser.email})=${email.toLowerCase()}`, eq(PosUser.is_active, true)),
        )
        .limit(2);
      return rows.length === 1 ? principal(rows[0]!) : null;
    },
    async close() {},
  };
}
