import { createHmac } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { Secret, TOTP } from 'otpauth';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { credentialVersion, seal, unseal } from '../../auth/crypto.js';
import { verifyTotp } from '../../auth/totp.js';
import { invalidateOperatorAuthentication } from '../../auth/revocation.js';
import { qrDataUrl } from '../../domain/qr.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { currentRequestTrace } from '../../observability/context.js';
import { assertCurrentOperatorRole } from './authorization.js';
import type { AdministrationTransaction } from './checkins.js';
import { lockAdministrationRegistry } from './locks.js';
import { manageableOperator } from './policies.js';
import { utcMediaTimestamp } from './media-domain.js';
import { operatorMfaEnrollments, operatorMfaMutations } from './mfa-schema.js';

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
const secretPayload = z
  .object({
    purpose: z.literal('operator-mfa'),
    id: z.uuid(),
    actorId: identifier,
    operatorId: identifier,
    secret: z.string().regex(/^[A-Z2-7]{32}$/),
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
export function operatorMfaService(
  config: Config,
  db: Databases,
  clock = () => Date.now(),
  encodeQr = qrDataUrl,
) {
  const encryptionKey = config.SESSION_SECRET + ':administration-mfa';
  const fingerprint = (account: Account) =>
    createHmac('sha256', encryptionKey).update(credentialVersion(account)).digest('hex');
  const now = () => utcMediaTimestamp(Temporal.Instant.fromEpochMilliseconds(clock()));
  async function management(
    transaction: AdministrationTransaction,
    user: Principal,
    operatorId: string,
    write: boolean,
  ) {
    requireRole(user, [1, 2, 3]);
    if (write) await lockAdministrationRegistry(transaction, 'operators');
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
  function reveal(row: typeof operatorMfaEnrollments.$inferSelect): string {
    try {
      const payload = secretPayload.parse(unseal(row.sealedSecret, encryptionKey));
      if (
        payload.id !== row.id ||
        payload.actorId !== row.actorId ||
        payload.operatorId !== row.operatorId
      )
        throw expired();
      return payload.secret;
    } catch {
      throw expired();
    }
  }
  async function cleanup(transaction: AdministrationTransaction) {
    await transaction
      .delete(operatorMfaEnrollments)
      .where(lt(operatorMfaEnrollments.expiresAt, now()))
      .limit(100);
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
    async start(user: Principal, operatorId: string, input: z.infer<typeof mfaEnrollmentInput>) {
      const result = await retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const { actor, target } = await management(transaction, user, operatorId, true);
          await cleanup(transaction);
          if (target.is_mfa) throw new AppError(409, 'MFA_ALREADY_ACTIVATED', 'Already Activated');
          if (fingerprint(target) !== input.expectedVersion) throw stale();
          const [previous] = await transaction
            .select()
            .from(operatorMfaEnrollments)
            .where(eq(operatorMfaEnrollments.id, input.operationId))
            .limit(1)
            .for('update');
          if (previous) {
            if (
              previous.actorId !== user.id ||
              previous.operatorId !== operatorId ||
              previous.state !== 'PENDING' ||
              previous.expiresAt <= now() ||
              previous.actorVersion !== fingerprint(actor) ||
              previous.operatorVersion !== fingerprint(target)
            )
              throw expired();
            return {
              id: previous.id,
              expiresAt: previous.expiresAt,
              secret: reveal(previous),
              label: target.email || target.username || operatorId,
            };
          }
          await transaction
            .update(operatorMfaEnrollments)
            .set({ state: 'CANCELLED' })
            .where(
              and(
                eq(operatorMfaEnrollments.operatorId, operatorId),
                eq(operatorMfaEnrollments.state, 'PENDING'),
              ),
            );
          const secret = new Secret({ size: 20 }).base32,
            expiresAt = utcMediaTimestamp(Temporal.Instant.fromEpochMilliseconds(clock() + 600000));
          await transaction.insert(operatorMfaEnrollments).values({
            id: input.operationId,
            actorId: user.id,
            operatorId,
            actorVersion: fingerprint(actor),
            operatorVersion: fingerprint(target),
            sealedSecret: seal(
              {
                purpose: 'operator-mfa',
                id: input.operationId,
                actorId: user.id,
                operatorId,
                secret,
              },
              encryptionKey,
            ),
            state: 'PENDING',
            attempts: 0,
            lastAttemptAt: null,
            expiresAt,
            requestId: currentRequestTrace()?.requestId || null,
            createdAt: now(),
          });
          return {
            id: input.operationId,
            expiresAt,
            secret,
            label: target.email || target.username || operatorId,
          };
        }),
      );
      const uri = new TOTP({
        issuer: 'TssPosApp',
        label: result.label,
        secret: Secret.fromBase32(result.secret),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      }).toString();
      return {
        id: result.id,
        expiresAt: result.expiresAt.replace(' ', 'T') + 'Z',
        qrDataUrl: await encodeQr(uri),
      };
    },
    async confirm(
      user: Principal,
      operatorId: string,
      enrollmentId: string,
      input: z.infer<typeof mfaVerificationInput>,
    ) {
      const result = await retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const { actor, target } = await management(transaction, user, operatorId, true);
          const [row] = await transaction
            .select()
            .from(operatorMfaEnrollments)
            .where(
              and(
                eq(operatorMfaEnrollments.id, enrollmentId),
                eq(operatorMfaEnrollments.actorId, user.id),
                eq(operatorMfaEnrollments.operatorId, operatorId),
              ),
            )
            .limit(1)
            .for('update');
          if (!row || row.expiresAt <= now() || row.state === 'CANCELLED' || row.attempts >= 5)
            throw expired();
          if (row.state === 'VERIFIED') {
            if (!target.is_mfa || target.mfa_hash !== reveal(row)) throw stale();
            return { verified: true as const };
          }
          if (
            row.actorVersion !== fingerprint(actor) ||
            row.operatorVersion !== fingerprint(target)
          )
            throw stale();
          if (
            row.lastAttemptAt &&
            Date.parse(row.lastAttemptAt.replace(' ', 'T') + 'Z') + 1000 > clock()
          )
            throw new AppError(
              429,
              'MFA_VERIFICATION_WAIT',
              'Wait briefly before trying another code.',
            );
          const secret = reveal(row),
            valid = verifyTotp(secret, input.code, clock());
          if (!valid) {
            await transaction
              .update(operatorMfaEnrollments)
              .set({
                attempts: row.attempts + 1,
                lastAttemptAt: now(),
                state: row.attempts + 1 >= 5 ? 'CANCELLED' : 'PENDING',
              })
              .where(eq(operatorMfaEnrollments.id, row.id));
            return { verified: false as const };
          }
          await transaction
            .update(PosUser)
            .set({ is_mfa: true, mfa_hash: secret })
            .where(eq(PosUser.id, target.id));
          await invalidateOperatorAuthentication(transaction, operatorId);
          await transaction
            .update(operatorMfaEnrollments)
            .set({ state: 'VERIFIED', lastAttemptAt: now() })
            .where(eq(operatorMfaEnrollments.id, row.id));
          return { verified: true as const };
        }),
      );
      if (!result.verified)
        throw new AppError(422, 'MFA_CODE_INVALID', 'Wrong OTP, Enter correct OTP');
      return {
        status: 'success' as const,
        message: 'Hash has been verified, MFA activated on your account',
      };
    },
    async cancel(user: Principal, operatorId: string, enrollmentId: string) {
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const { actorRole } = await management(transaction, user, operatorId, true);
          const [row] = await transaction
            .select()
            .from(operatorMfaEnrollments)
            .where(
              and(
                eq(operatorMfaEnrollments.id, enrollmentId),
                eq(operatorMfaEnrollments.operatorId, operatorId),
              ),
            )
            .limit(1)
            .for('update');
          if (!row || (row.actorId !== user.id && actorRole !== 1))
            throw new AppError(404, 'MFA_ENROLLMENT_NOT_FOUND', 'Enrollment was not found.');
          if (row.state === 'VERIFIED')
            throw new AppError(409, 'MFA_ALREADY_ACTIVATED', 'Already Activated');
          await transaction
            .update(operatorMfaEnrollments)
            .set({ state: 'CANCELLED' })
            .where(eq(operatorMfaEnrollments.id, enrollmentId));
          return { status: 'success' as const, message: 'Authenticator enrollment cancelled.' };
        }),
      );
    },
    async update(user: Principal, operatorId: string, input: z.infer<typeof mfaControlInput>) {
      const hash = createHmac('sha256', encryptionKey)
        .update(JSON.stringify({ operatorId, input }))
        .digest('hex');
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const { target, actorRole } = await management(transaction, user, operatorId, true);
          if (actorRole !== 1)
            throw new AppError(
              403,
              'MFA_RESET_DENIED',
              'Authenticator reset requires a super administrator.',
            );
          const [previous] = await transaction
            .select()
            .from(operatorMfaMutations)
            .where(eq(operatorMfaMutations.id, input.operationId))
            .limit(1);
          if (previous) {
            if (
              previous.actorId !== user.id ||
              previous.operatorId !== operatorId ||
              previous.hash !== hash
            )
              throw new AppError(
                409,
                'MFA_OPERATION_REUSED',
                'Choose a new authenticator operation.',
              );
            return previous.result;
          }
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
          await transaction
            .update(operatorMfaEnrollments)
            .set({ state: 'CANCELLED' })
            .where(
              and(
                eq(operatorMfaEnrollments.operatorId, operatorId),
                eq(operatorMfaEnrollments.state, 'PENDING'),
              ),
            );
          const result = {
            status: 'success' as const,
            message:
              input.mode === 'replace'
                ? 'Authenticator replaced.'
                : 'Authenticator disabled. Login will use the configured OTP channel.',
          };
          await transaction.insert(operatorMfaMutations).values({
            id: input.operationId,
            actorId: user.id,
            operatorId,
            hash,
            result,
            requestId: currentRequestTrace()?.requestId || null,
            createdAt: now(),
          });
          return result;
        }),
      );
    },
  };
}
export async function pruneOperatorMfaEnrollments(db: Databases, before: Date, limit = 500) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isFinite(before.getTime())
  )
    throw new AppError(400, 'MFA_CLEANUP_BOUND_INVALID', 'Choose a bounded enrollment cleanup.');
  return db
    .get('writer')
    .delete(operatorMfaEnrollments)
    .where(
      lt(
        operatorMfaEnrollments.expiresAt,
        utcMediaTimestamp(Temporal.Instant.fromEpochMilliseconds(before.getTime())),
      ),
    )
    .limit(limit);
}
