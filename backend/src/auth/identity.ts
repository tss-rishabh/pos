import { and, asc, eq, inArray, like, or } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../config.js';
import { PosUser, Store, UserStore } from '../db/legacy-schema.js';
import type { Databases } from '../db/pools.js';
import type { Principal, Role } from '../domain/access.js';
import { roles } from '../domain/access.js';
import { checkDjangoPassword, djangoPasswordHash } from './crypto.js';
import type { AuthEventLogger } from './events.js';
import type { SessionAccount, SessionTransaction } from './sessions.js';

/** Django 4.2 make_password at the default 600k iterations: equalises unknown-user timing. */
const ABSENT_USER_HASH =
  'pbkdf2_sha256$600000$PosAbsentUserTimingSalt$dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHQ=';
/** MySQL LIKE escaping as Django's `iexact` lookup applies it on the MySQL backend. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (character) => `\\${character}`);
export interface LoginStore {
  id: string;
  name: string;
}
export interface IdentityService {
  /** Principal for an active user, with assignments re-read (Django re-reads per request). */
  get(id: string): Promise<Principal | null>;
  principal(row: SessionAccount, transaction?: SessionTransaction): Promise<Principal | null>;
  /**
   * Legacy `authenticate()` with EmailBackend then ModelBackend (users/auth_backends.py),
   * verifying each candidate's password once (S7). The multi-match branch verifies the
   * password and `is_active` (S1). A correct password with outdated hasher parameters is
   * re-hashed and saved, as Django's `check_password` setter does (S6).
   */
  authenticate(username: string, password: string): Promise<SessionAccount | null>;
  /** legacy pending_login_user: `User.objects.filter(pk=id, is_active=True)` on the writer. */
  activeAccount(id: string): Promise<SessionAccount | null>;
  /** Stores offered at the OTP step (users/views.py:135-141). */
  loginStores(row: SessionAccount): Promise<LoginStore[]>;
  /** Django user_logged_in → update_last_login: naive business-local time (USE_TZ=False). */
  recordLogin(userId: string): Promise<void>;
  close(): Promise<void>;
}
export function identityService(
  config: Config,
  databases: Databases,
  log: AuthEventLogger = () => {},
): IdentityService {
  // Authentication, authorization confirmation and revocation read the writer.
  const database = () => databases.get('writer');
  async function principal(
    row: SessionAccount,
    transaction?: SessionTransaction,
  ): Promise<Principal | null> {
    // The shared Principal type models roles 1-5 and user types 1-2, the only values the
    // legacy models define (users/models.py:79-113). Other values cannot be represented.
    if (!row.is_active || !(row.role in roles) || !(row.user_type === 1 || row.user_type === 2))
      return null;
    const assignments = await (transaction ?? database())
      .select({ id: UserStore.store_id })
      .from(UserStore)
      .where(eq(UserStore.django_user_id, row.id));
    const firstName = row.first_name ?? '',
      lastName = row.last_name ?? '';
    return {
      id: String(row.id),
      name: `${firstName} ${lastName}`.trim() || row.username,
      email: row.email || '',
      role: row.role as Role,
      userType: row.user_type,
      storeIds: assignments.map((assignment) => String(assignment.id)),
    };
  }
  async function verify(row: SessionAccount, password: string): Promise<boolean> {
    const result = await checkDjangoPassword(password, row.password);
    if (!result.valid) {
      if (row.password && !/^(?:pbkdf2_sha256|pbkdf2_sha1|scrypt|!)/.test(row.password))
        log({
          eventId: 'identity.login.unverifiable-password-hash',
          userId: String(row.id),
          level: 'warn',
        });
      return false;
    }
    if (result.mustUpdate) {
      // Django saves the new hash unconditionally; the compare-and-set keeps a concurrent
      // password change from being overwritten.
      const updated = await djangoPasswordHash(password);
      await database()
        .update(PosUser)
        .set({ password: updated })
        .where(and(eq(PosUser.id, row.id), eq(PosUser.password, row.password)));
      row.password = updated;
      log({ eventId: 'identity.login.password-rehashed', userId: String(row.id) });
    }
    return true;
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
    principal,
    async authenticate(rawUsername, password) {
      // Django's UsernameField: NFKC-normalised and stripped (AuthenticationForm).
      const username = rawUsername.trim().normalize('NFKC');
      const pattern = escapeLike(username);
      // EmailBackend: username__iexact OR email__iexact.
      const matches = await database()
        .select()
        .from(PosUser)
        // drizzle binds the value; MySQL's default LIKE escape character is backslash.
        .where(or(like(PosUser.username, pattern), like(PosUser.email, pattern)))
        .orderBy(asc(PosUser.id))
        .limit(2);
      const candidates: SessionAccount[] = [];
      if (matches.length === 1) candidates.push(matches[0]!);
      else if (matches.length > 1) {
        // MultipleObjectsReturned: legacy returns `filter(email=username).order_by('id')
        // .first()` without checking anything. S1: it must pass the password and is_active.
        const [byEmail] = await database()
          .select()
          .from(PosUser)
          .where(eq(PosUser.email, username))
          .orderBy(asc(PosUser.id))
          .limit(1);
        if (byEmail) candidates.push(byEmail);
      }
      // ModelBackend, tried by Django whenever EmailBackend returns None: exact username.
      const [byUsername] = await database()
        .select()
        .from(PosUser)
        .where(eq(PosUser.username, username))
        .limit(1);
      if (byUsername && !candidates.some((row) => row.id === byUsername.id))
        candidates.push(byUsername);
      if (!candidates.length) {
        await checkDjangoPassword(password, ABSENT_USER_HASH);
        return null;
      }
      for (const row of candidates) if ((await verify(row, password)) && row.is_active) return row;
      return null;
    },
    async activeAccount(id) {
      const [row] = await database()
        .select()
        .from(PosUser)
        .where(and(eq(PosUser.id, BigInt(id)), eq(PosUser.is_active, true)))
        .limit(1);
      return row ?? null;
    },
    async loginStores(row) {
      let storeIds: bigint[] | undefined;
      if (row.role !== 1) {
        const assignments = await database()
          .select({ id: UserStore.store_id })
          .from(UserStore)
          .where(eq(UserStore.django_user_id, row.id));
        storeIds = assignments.map((assignment) => assignment.id);
        if (!storeIds.length) return [];
      }
      const stores = await database()
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(
          and(
            eq(Store.is_active, true),
            inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
            storeIds ? inArray(Store.id, storeIds) : undefined,
          ),
        )
        .orderBy(asc(Store.id));
      return stores.map((store) => ({ id: String(store.id), name: store.name ?? '' }));
    },
    async recordLogin(userId) {
      const local = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
      await database()
        .update(PosUser)
        .set({ last_login: local })
        .where(eq(PosUser.id, BigInt(userId)));
    },
    async close() {},
  };
}
