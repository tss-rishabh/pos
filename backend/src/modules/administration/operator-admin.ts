import { createHmac } from 'node:crypto';
import { and, eq, ne, or } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser } from '../../db/legacy-schema.js';
import { retryTransaction } from '../../db/retry.js';
import { credentialVersion, djangoPasswordHash } from '../../auth/crypto.js';
import { assertPasswordPolicy } from '../../auth/password-policy.js';
import { profileImageReferences } from '../../auth/profile-media.js';
import { redisImageService } from '../../auth/image-reservations.js';
import type { RedisPort } from '../../redis/port.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { assertModelAdministrationPermission } from './access-control.js';
import { administrationAccessReceipts } from './access-receipts.js';
import type { AdministrationTransaction } from './checkins.js';
import { withAdministrationLock } from './locks.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';
import type { ImageOwnerAdapter } from './image-lifecycle/domain.js';
import type { DocumentationMediaStore } from './media-storage.js';
import {
  operatorAdminMutationResult,
  type operatorAdminPasswordInput,
  type operatorAdminProfileInput,
} from './operator-admin-domain.js';

type Account = typeof PosUser.$inferSelect;
export interface OperatorAdminOptions {
  operatorImageStore?: DocumentationMediaStore;
  /** Upload reservations in Redis (pos:profile_upload:*), replacing pos_rewrite_profile_uploads. */
  operatorImageReservations?: RedisPort;
}
export type AuthenticationInvalidator = (
  tx: AdministrationTransaction,
  operatorId: string,
) => Promise<unknown>;
export const operatorAdminRevision = (config: Config, row: Account) =>
  createHmac('sha256', config.SESSION_SECRET + ':operator-administration')
    .update(
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    )
    .digest('hex');
const changed = () =>
  new AppError(
    409,
    'OPERATOR_ADMIN_PROFILE_CHANGED',
    'The operator changed. Reload before saving again.',
  );

async function managedAccount(
  tx: AdministrationTransaction,
  user: Principal,
  id: string,
  mode: 'read' | 'attach' | 'publish',
) {
  const actor = await assertModelAdministrationPermission(
    tx,
    user,
    mode === 'read' ? ['users.view_posuser', 'users.change_posuser'] : ['users.change_posuser'],
  );
  const [target] = await tx
    .select()
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(id)))
    .limit(1)
    .for(mode === 'publish' ? 'update' : 'share');
  if (!target) throw new AppError(404, 'OPERATOR_NOT_FOUND', 'Operator was not found.');
  if (mode !== 'read') {
    if (id === user.id)
      throw new AppError(
        403,
        'SELF_ADMIN_PROFILE_CHANGE_DENIED',
        'Use your personal profile. Another administrator must change your login name or important dates.',
      );
    if (target.is_superuser && !actor.is_superuser)
      throw new AppError(
        403,
        'OPERATOR_ADMIN_TARGET_DENIED',
        'Changing a superuser requires another current superuser.',
      );
  }
  return { actor, target };
}
function managedImages(config: Config): ImageOwnerAdapter {
  return {
    ...profileImageReferences,
    registry: 'operators',
    subject: 'the operator profile',
    errorPrefix: 'OPERATOR_ADMIN',
    kinds: ['image', 'cover-image'],
    reservationOwner: (context) =>
      createHmac('sha256', config.SESSION_SECRET + ':managed-image-owner')
        .update(`${context.ownerId}:${context.user.id}`)
        .digest('hex')
        .slice(0, 32),
    async authorize(tx, context, mode) {
      const { target } = await managedAccount(tx, context.user, context.ownerId, mode);
      return {
        revision: operatorAdminRevision(config, target),
        keys: { image: target.profile_image, 'cover-image': target.cover_image },
      };
    },
    async write(tx, context, kind, key) {
      await tx
        .update(PosUser)
        .set(kind === 'image' ? { profile_image: key } : { cover_image: key })
        .where(eq(PosUser.id, BigInt(context.ownerId)));
    },
    allowsKey: (kind, key) =>
      new RegExp(
        `^uploads/users/${kind === 'image' ? 'profile_image' : 'cover_image'}/[^/]+\\.(?:jpg|jpeg|png|gif|webp)$`,
        'i',
      ).test(key),
  };
}
export function operatorAdministrationService(
  config: Config,
  db: Databases,
  invalidateAuthentication: AuthenticationInvalidator,
  options: OperatorAdminOptions = {},
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
) {
  const receipts = administrationAccessReceipts(config);
  const images = redisImageService(
    db,
    options.operatorImageReservations,
    managedImages(config),
    options.operatorImageStore,
  );
  const context = (user: Principal, id: string) => ({ user, ownerId: id });
  async function guard(tx: AdministrationTransaction, user: Principal, id: string) {
    return managedAccount(tx, user, id, 'publish');
  }
  const locked = <T>(run: () => Promise<T>) =>
    withAdministrationLock(ephemeral, 'operators', () => retryTransaction(run));

  return {
    async profile(user: Principal, id: string) {
      return db.get('writer').transaction(async (tx) => {
        const { actor, target } = await managedAccount(tx, user, id, 'read');
        let canEdit = false;
        if (id !== user.id && (!target.is_superuser || actor.is_superuser)) {
          try {
            await assertModelAdministrationPermission(tx, user, ['users.change_posuser']);
            canEdit = true;
          } catch (error) {
            if (!(error instanceof AppError) || error.status !== 403) throw error;
          }
        }
        return {
          id,
          username: target.username,
          firstName: target.first_name,
          lastName: target.last_name,
          email: target.email,
          phone: target.phone,
          contactEmail: target.contact_email,
          age: target.age,
          gender: target.gender,
          role: target.role,
          userType: target.user_type,
          otpMethod: target.otp_method,
          active: target.is_active,
          isStaff: target.is_staff,
          isSuperuser: target.is_superuser,
          mfaEnabled: Boolean(target.is_mfa),
          passwordConfigured: Boolean(target.password && !target.password.startsWith('!')),
          lastLogin: target.last_login,
          dateJoined: target.date_joined,
          timeZone: config.BUSINESS_TIMEZONE,
          revision: operatorAdminRevision(config, target),
          imagesAvailable: Boolean(options.operatorImageStore),
          hasProfileImage: Boolean(target.profile_image),
          hasCoverImage: Boolean(target.cover_image),
          canEdit,
          canResetPassword: canEdit && actor.is_superuser,
        };
      });
    },
    async updateProfile(
      user: Principal,
      id: string,
      input: z.infer<typeof operatorAdminProfileInput>,
    ) {
      const hash = receipts.inputHash({ id, input }),
        resource = `operator:${id}`;
      return locked(() =>
        db.get('writer').transaction(async (tx) => {
          const { target } = await guard(tx, user, id);
          const previous = await receipts.replay(
            tx,
            user,
            input.operationId,
            resource,
            'operator-profile',
            hash,
          );
          if (previous) return operatorAdminMutationResult.parse(previous);
          if (operatorAdminRevision(config, target) !== input.expectedVersion) throw changed();
          const [duplicate] = await tx
            .select({ id: PosUser.id })
            .from(PosUser)
            .where(
              and(
                ne(PosUser.id, target.id),
                or(
                  eq(PosUser.username, input.username),
                  input.email ? eq(PosUser.email, input.email) : undefined,
                  input.phone ? eq(PosUser.phone, input.phone) : undefined,
                  input.contactEmail ? eq(PosUser.contact_email, input.contactEmail) : undefined,
                ),
              ),
            )
            .limit(1);
          if (duplicate)
            throw new AppError(
              409,
              'OPERATOR_IDENTITY_UNAVAILABLE',
              'This login name or contact is already assigned to another operator.',
            );
          const values = {
            username: input.username,
            first_name: input.firstName,
            last_name: input.lastName,
            email: input.email,
            phone: input.phone,
            contact_email: input.contactEmail,
            age: input.age,
            gender: input.gender,
            role: input.role,
            user_type: input.userType,
            otp_method: input.otpMethod,
            is_active: input.active,
            last_login: input.lastLogin,
            date_joined: input.dateJoined,
          };
          const credentialsChanged =
            credentialVersion(target) !== credentialVersion({ ...target, ...values }) ||
            target.is_active !== values.is_active;
          await tx.update(PosUser).set(values).where(eq(PosUser.id, target.id));
          if (credentialsChanged) await invalidateAuthentication(tx, id);
          const result = {
            id,
            status: 'success' as const,
            message: 'Operator administrative profile saved.',
            credentialsChanged,
          };
          await receipts.receipt(
            tx,
            user,
            input.operationId,
            resource,
            'operator-profile',
            hash,
            result,
          );
          return result;
        }),
      );
    },
    async resetPassword(
      user: Principal,
      id: string,
      input: z.infer<typeof operatorAdminPasswordInput>,
    ) {
      const hash = receipts.inputHash({ id, input }),
        resource = `operator:${id}`;
      const initial = await db.get('writer').transaction(async (tx) => {
        const { actor, target } = await managedAccount(tx, user, id, 'attach');
        if (!actor.is_superuser)
          throw new AppError(
            403,
            'OPERATOR_PASSWORD_RESET_DENIED',
            'Password resets require a current internal superuser.',
          );
        const previous = await receipts.replay(
          tx,
          user,
          input.operationId,
          resource,
          'operator-password',
          hash,
          'share',
        );
        if (previous)
          return { kind: 'replay' as const, result: operatorAdminMutationResult.parse(previous) };
        if (operatorAdminRevision(config, target) !== input.expectedVersion) throw changed();
        assertPasswordPolicy(input.newPassword, target);
        return { kind: 'continue' as const };
      });
      if (initial.kind === 'replay') return initial.result;
      const encoded = await djangoPasswordHash(input.newPassword);
      return locked(() =>
        db.get('writer').transaction(async (tx) => {
          const { actor, target } = await guard(tx, user, id);
          if (!actor.is_superuser)
            throw new AppError(
              403,
              'OPERATOR_PASSWORD_RESET_DENIED',
              'Password resets require a current internal superuser.',
            );
          const previous = await receipts.replay(
            tx,
            user,
            input.operationId,
            resource,
            'operator-password',
            hash,
          );
          if (previous) return operatorAdminMutationResult.parse(previous);
          if (operatorAdminRevision(config, target) !== input.expectedVersion) throw changed();
          assertPasswordPolicy(input.newPassword, target);
          await tx.update(PosUser).set({ password: encoded }).where(eq(PosUser.id, target.id));
          await invalidateAuthentication(tx, id);
          const result = {
            id,
            status: 'success' as const,
            message: 'Operator password reset. Existing authentication was revoked.',
            credentialsChanged: true,
          };
          await receipts.receipt(
            tx,
            user,
            input.operationId,
            resource,
            'operator-password',
            hash,
            result,
          );
          return result;
        }),
      );
    },
    images: {
      reserve: (user: Principal, id: string, input: Parameters<typeof images.reserve>[1]) =>
        images.reserve(context(user, id), input),
      attach: (user: Principal, id: string, uploadId: string, revision: string) =>
        images.attach(context(user, id), uploadId, revision),
      stream: (user: Principal, id: string, kind: 'image' | 'cover-image', signal?: AbortSignal) =>
        images.stream(context(user, id), kind, signal),
    },
  };
}
