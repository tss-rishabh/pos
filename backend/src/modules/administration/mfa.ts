import { createHmac, timingSafeEqual } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { credentialVersion } from '../../auth/crypto.js';
import { verifyTotp } from '../../auth/totp.js';
import { invalidateOperatorAuthentication } from '../../auth/revocation.js';
import { qrDataUrl } from '../../domain/qr.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { assertCurrentOperatorRole } from './authorization.js';
import type { AdministrationTransaction } from './checkins.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import { withAdministrationLock } from './locks.js';
import { manageableOperator } from './policies.js';

const version = z.string().regex(/^[a-f0-9]{64}$/);
const code = z.string().regex(/^\d{6}$/);
export const mfaEnrollmentInput = z
  .object({ operationId: z.uuid(), expectedVersion: version })
  .strict();
export const mfaVerificationInput = z.object({ code }).strict();
export const mfaControlInput = z.discriminatedUnion('mode', [
  z
    .object({ operationId: z.uuid(), expectedVersion: version, mode: z.literal('disable') })
    .strict(),
  z
    .object({
      operationId: z.uuid(),
      expectedVersion: version,
      mode: z.literal('replace'),
      secret: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z2-7]{32,128}$/),
      code,
    })
    .strict(),
]);
/**
 * Pending enrollment (ledger administration/mfa): the legacy GET writes the new base32 secret to
 * `pos_user.mfa_hash` while `is_mfa` stays 0 (`users/views.py:1017-1022`); the POST verifies it and
 * sets `is_mfa=1` (`:1038-1042`). The rewrite-only attempt budget and replay binding live in
 * `pos:mfa_enroll:{operatorId}` for ten minutes; it never holds the secret.
 */
export const mfaEnrollmentKey = (operatorId: string) => `pos:mfa_enroll:${operatorId}`;
/** Super-administrator replace/disable receipts: `pos:idem:mfa:{operationId}`, 24 h. */
export const mfaMutationKey = (operationId: string) => `pos:idem:mfa:${operationId}`;
const enrollmentSeconds = 600;
const enrollmentState = z
  .object({
    id: z.uuid(),
    actorId: z.string(),
    secretDigest: z.string(),
    attempts: z.number().int().min(0),
    lastAttemptAt: z.number().nullable(),
    verified: z.boolean(),
    expiresAt: z.number(),
  })
  .strict();
type EnrollmentState = z.infer<typeof enrollmentState>;
const mutationReceipt = z
  .object({
    actorId: z.string(),
    operatorId: z.string(),
    hash: z.string(),
    result: z.object({ status: z.literal('success'), message: z.string() }).strict(),
  })
  .strict();
type Account = typeof PosUser.$inferSelect;
const expired = () =>
  new AppError(409, 'MFA_ENROLLMENT_EXPIRED', 'This enrollment expired. Start again.');
const stale = () =>
  new AppError(
    409,
    'MFA_SETTINGS_CHANGED',
    'Authenticator settings changed. Refresh before continuing.',
  );
const same = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
export function operatorMfaService(
  config: Config,
  db: Databases,
  clock = () => Date.now(),
  encodeQr = qrDataUrl,
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
) {
  const encryptionKey = config.SESSION_SECRET + ':administration-mfa';
  const fingerprint = (account: Account) =>
    createHmac('sha256', encryptionKey).update(credentialVersion(account)).digest('hex');
  const secretDigest = (operatorId: string, secret: string | null) =>
    createHmac('sha256', encryptionKey)
      .update(operatorId + ':' + (secret || ''))
      .digest('hex');
  const locked = <T>(run: () => Promise<T>) =>
    withAdministrationLock(ephemeral, 'operators', () => retryTransaction(run));
  async function enrollment(operatorId: string): Promise<EnrollmentState | null> {
    const raw = await ephemeral.get(mfaEnrollmentKey(operatorId));
    if (raw === null) return null;
    try {
      const value = enrollmentState.parse(JSON.parse(raw) as unknown);
      return value.expiresAt > clock() ? value : null;
    } catch {
      return null;
    }
  }
  const saveEnrollment = (operatorId: string, value: EnrollmentState) =>
    ephemeral.set(mfaEnrollmentKey(operatorId), JSON.stringify(value), {
      PX: Math.max(1, value.expiresAt - clock()),
    });
  async function management(
    transaction: AdministrationTransaction,
    user: Principal,
    operatorId: string,
    write: boolean,
  ) {
    requireRole(user, [1, 2, 3]);
    const actorRole = await assertCurrentOperatorRole(transaction, user.id, [1, 2, 3]);
    const rows = await transaction
      .select()
      .from(PosUser)
      .where(inArray(PosUser.id, [...new Set([user.id, operatorId])].map(BigInt)))
      .orderBy(asc(PosUser.id))
      .limit(2)
      .for(write ? 'update' : 'share');
    const actor = rows.find((row) => String(row.id) === user.id),
      target = rows.find((row) => String(row.id) === operatorId);
    if (!actor || !target) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'Operator was not found.');
    if (!target.is_active)
      throw new AppError(
        409,
        'OPERATOR_INACTIVE',
        'Activate this operator before changing authenticator settings.',
      );
    const targetRole = ([1, 2, 3, 4, 5] as const).find((role) => role === target.role),
      actorType = ([1, 2] as const).find((type) => type === actor.user_type);
    if (!targetRole || !actorType)
      throw new AppError(
        403,
        'OPERATOR_ROLE_DENIED',
        'This account has unsupported access settings.',
      );
    const currentActor: Principal = { ...user, role: actorRole, userType: actorType };
    if (user.id !== operatorId) manageableOperator(currentActor, operatorId, targetRole);
    if (actorType === 2 && target.user_type !== 2)
      throw new AppError(
        403,
        'OPERATOR_SCOPE_DENIED',
        'This user type is outside your organization.',
      );
    if (user.id !== operatorId && (actorRole !== 1 || actorType === 2)) {
      const assignments = await transaction
        .select({ userId: UserStore.django_user_id, storeId: Store.id })
        .from(UserStore)
        .innerJoin(Store, eq(Store.id, sql`${UserStore.store_id}`))
        .where(
          and(inArray(UserStore.django_user_id, [actor.id, target.id]), eq(Store.is_active, true)),
        )
        .for('share');
      const allowed = new Set(
          assignments.filter((row) => row.userId === actor.id).map((row) => String(row.storeId)),
        ),
        targetStores = assignments
          .filter((row) => row.userId === target.id)
          .map((row) => String(row.storeId));
      if (!targetStores.length || targetStores.some((storeId) => !allowed.has(storeId)))
        throw new AppError(
          403,
          'OPERATOR_SCOPE_DENIED',
          'Authenticator changes require access to every active store assigned to this operator.',
        );
    }
    return { actor, target, actorRole };
  }
  return {
    async read(user: Principal, operatorId: string) {
      return db.get('writer').transaction(async (transaction) => {
        const { target, actorRole } = await management(transaction, user, operatorId, false);
        return {
          enabled: Boolean(target.is_mfa),
          configured: Boolean(target.mfa_hash),
          version: fingerprint(target),
          canReplace: actorRole === 1,
        };
      });
    },
    /** `AjaxActivateMfaView.get`; QR generated locally instead of the Google Charts URL. */
    async start(user: Principal, operatorId: string, input: z.infer<typeof mfaEnrollmentInput>) {
      const previous = await enrollment(operatorId);
      const result = await locked(() =>
        db.get('writer').transaction(async (transaction) => {
          const { target } = await management(transaction, user, operatorId, true);
          if (target.is_mfa) throw new AppError(409, 'MFA_ALREADY_ACTIVATED', 'Already Activated');
          const label = target.email || target.username || operatorId;
          if (previous?.id === input.operationId) {
            // Replay of the same enrollment: only while its secret is still the pending one.
            if (
              previous.actorId !== user.id ||
              previous.verified ||
              !target.mfa_hash ||
              !same(previous.secretDigest, secretDigest(operatorId, target.mfa_hash))
            )
              throw expired();
            return { state: previous, secret: target.mfa_hash, label };
          }
          if (fingerprint(target) !== input.expectedVersion) throw stale();
          const secret = new Secret({ size: 20 }).base32;
          await transaction
            .update(PosUser)
            .set({ mfa_hash: secret })
            .where(eq(PosUser.id, target.id));
          const state: EnrollmentState = {
            id: input.operationId,
            actorId: user.id,
            secretDigest: secretDigest(operatorId, secret),
            attempts: 0,
            lastAttemptAt: null,
            verified: false,
            expiresAt: clock() + enrollmentSeconds * 1000,
          };
          return { state, secret, label };
        }),
      );
      // Written after commit; replaces (cancels) any other pending enrollment for this operator.
      await saveEnrollment(operatorId, result.state);
      const uri = new TOTP({
        issuer: 'TssPosApp',
        label: result.label,
        secret: Secret.fromBase32(result.secret),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }).toString();
      return {
        id: result.state.id,
        expiresAt: new Date(result.state.expiresAt).toISOString(),
        qrDataUrl: await encodeQr(uri),
      };
    },
    /** `AjaxActivateMfaView.post`. */
    async confirm(
      user: Principal,
      operatorId: string,
      enrollmentId: string,
      input: z.infer<typeof mfaVerificationInput>,
    ) {
      const current = await enrollment(operatorId);
      if (
        !current ||
        current.id !== enrollmentId ||
        current.actorId !== user.id ||
        current.attempts >= 5
      )
        throw expired();
      const result = await locked(() =>
        db.get('writer').transaction(async (transaction) => {
          const { target } = await management(transaction, user, operatorId, true);
          if (
            !target.mfa_hash ||
            !same(current.secretDigest, secretDigest(operatorId, target.mfa_hash))
          )
            throw stale();
          if (current.verified) {
            if (!target.is_mfa) throw stale();
            return { verified: true as const };
          }
          if (target.is_mfa) throw new AppError(409, 'MFA_ALREADY_ACTIVATED', 'Already Activated');
          if (current.lastAttemptAt !== null && current.lastAttemptAt + 1000 > clock())
            throw new AppError(
              429,
              'MFA_VERIFICATION_WAIT',
              'Wait briefly before trying another code.',
            );
          if (!verifyTotp(target.mfa_hash, input.code, clock()))
            return { verified: false as const };
          await transaction.update(PosUser).set({ is_mfa: true }).where(eq(PosUser.id, target.id));
          await invalidateOperatorAuthentication(transaction, operatorId);
          return { verified: true as const };
        }),
      );
      if (!result.verified) {
        const attempts = current.attempts + 1;
        if (attempts >= 5) await ephemeral.del(mfaEnrollmentKey(operatorId));
        else await saveEnrollment(operatorId, { ...current, attempts, lastAttemptAt: clock() });
        throw new AppError(422, 'MFA_CODE_INVALID', 'Wrong OTP, Enter correct OTP');
      }
      if (!current.verified) await saveEnrollment(operatorId, { ...current, verified: true });
      return {
        status: 'success' as const,
        message: 'Hash has been verified, MFA activated on your account',
      };
    },
    async cancel(user: Principal, operatorId: string, enrollmentId: string) {
      const { actorRole } = await db
        .get('writer')
        .transaction((transaction) => management(transaction, user, operatorId, false));
      const current = await enrollment(operatorId);
      if (
        !current ||
        current.id !== enrollmentId ||
        (current.actorId !== user.id && actorRole !== 1)
      )
        throw new AppError(404, 'MFA_ENROLLMENT_NOT_FOUND', 'Enrollment was not found.');
      if (current.verified) throw new AppError(409, 'MFA_ALREADY_ACTIVATED', 'Already Activated');
      await ephemeral.del(mfaEnrollmentKey(operatorId));
      return { status: 'success' as const, message: 'Authenticator enrollment cancelled.' };
    },
    /** Super-administrator replace/disable (legacy Django `UserAdmin` `is_mfa`/`mfa_hash`). */
    async update(user: Principal, operatorId: string, input: z.infer<typeof mfaControlInput>) {
      const hash = createHmac('sha256', encryptionKey)
        .update(JSON.stringify({ operatorId, input }))
        .digest('hex');
      const replay = async () => {
        const raw = await ephemeral.get(mfaMutationKey(input.operationId));
        if (raw === null) return null;
        const previous = mutationReceipt.parse(JSON.parse(raw) as unknown);
        if (
          previous.actorId !== user.id ||
          previous.operatorId !== operatorId ||
          previous.hash !== hash
        )
          throw new AppError(409, 'MFA_OPERATION_REUSED', 'Choose a new authenticator operation.');
        return previous.result;
      };
      const replayed = await replay();
      if (replayed) return replayed;
      const result = await locked(() =>
        db.get('writer').transaction(async (transaction) => {
          const { target, actorRole } = await management(transaction, user, operatorId, true);
          if (actorRole !== 1)
            throw new AppError(
              403,
              'MFA_RESET_DENIED',
              'Authenticator reset requires a super administrator.',
            );
          if (fingerprint(target) !== input.expectedVersion) throw stale();
          if (input.mode === 'replace' && !verifyTotp(input.secret, input.code, clock()))
            throw new AppError(422, 'MFA_CODE_INVALID', 'Wrong OTP, Enter correct OTP');
          await transaction
            .update(PosUser)
            .set({
              is_mfa: input.mode === 'replace',
              mfa_hash: input.mode === 'replace' ? input.secret : null,
            })
            .where(eq(PosUser.id, target.id));
          await invalidateOperatorAuthentication(transaction, operatorId);
          return {
            status: 'success' as const,
            message:
              input.mode === 'replace'
                ? 'Authenticator replaced.'
                : 'Authenticator disabled. Login will use the configured OTP channel.',
          };
        }),
      );
      await ephemeral.del(mfaEnrollmentKey(operatorId));
      await ephemeral.set(
        mfaMutationKey(input.operationId),
        JSON.stringify({ actorId: user.id, operatorId, hash, result }),
        { NX: true, EX: 86400 },
      );
      return result;
    },
  };
}
/**
 * @deprecated Pending enrollments live in Redis with a TTL. No-op kept only because
 * `src/auth/security-worker.ts` (W3) still calls it.
 */
export async function pruneOperatorMfaEnrollments(
  _db: Databases,
  _before: Date,
  _limit = 500,
): Promise<void> {}
