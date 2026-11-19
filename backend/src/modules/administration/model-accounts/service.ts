import { Temporal } from '@js-temporal/polyfill';
import { eq, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { PosUser } from '../../../db/legacy-schema.js';
import { generatedId } from '../../../db/generated-id.js';
import { retryTransaction } from '../../../db/retry.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { assertPasswordPolicy } from '../../../auth/password-policy.js';
import { djangoPasswordHash } from '../../../auth/crypto.js';
import { assertModelAdministrator } from '../model-administration.js';
import { administrationAccessReceipts } from '../access-receipts.js';
import type { EphemeralStore } from '../../../jobs/ephemeral.js';
import { withAdministrationLock } from '../locks.js';
import { administrationEphemeralStore } from '../ephemeral-runtime.js';
import type { AdministrationTransaction } from '../checkins.js';
import { modelAccountDefaults, modelAccountInput, modelAccountResult } from './domain.js';
const resource = 'operator-model-account',
  action = 'create';
/**
 * Django UserAdmin._add_view requires users.add_posuser AND users.change_posuser; with the grants
 * feature deleted only a current staff superuser holds both.
 */
async function authorize(tx: AdministrationTransaction, user: Principal) {
  await assertModelAdministrator(tx, user);
}
export function operatorModelAccountService(
  config: Config,
  db: Databases,
  clock = () => Temporal.Now.instant(),
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
) {
  const receipts = administrationAccessReceipts(config, ephemeral);
  return {
    async capabilities(user: Principal) {
      await db.get('writer').transaction((tx) => authorize(tx, user));
      return { canCreate: true, defaults: modelAccountDefaults };
    },
    async create(user: Principal, value: z.infer<typeof modelAccountInput>) {
      const input = modelAccountInput.parse(value),
        hash = receipts.inputHash({
          resource,
          action,
          username: input.username,
          password: input.password,
        });
      await db.get('writer').transaction((tx) => authorize(tx, user));
      const prior = await receipts.replay(user, input.operationId, resource, action, hash);
      if (prior) return modelAccountResult.parse(prior);
      assertPasswordPolicy(input.password, {
        username: input.username,
        first_name: '',
        last_name: '',
        email: '',
      });
      const password = await djangoPasswordHash(input.password);
      return withAdministrationLock(ephemeral, 'operators', async () => {
        const previous = await receipts.replay(user, input.operationId, resource, action, hash);
        if (previous) return modelAccountResult.parse(previous);
        const result = await retryTransaction(() =>
          db.get('writer').transaction(async (tx) => {
            await authorize(tx, user);
            const [duplicate] = await tx
              .select({ id: PosUser.id })
              .from(PosUser)
              .where(or(eq(PosUser.username, input.username), eq(PosUser.email, input.username)))
              .limit(1)
              .for('share');
            if (duplicate)
              throw new AppError(
                409,
                'OPERATOR_USERNAME_EXISTS',
                'This username is already in use.',
              );
            // UserCreationForm invokes AbstractUser.clean(): absent email becomes ''.
            // The physical UNIQUE email index permits one such pending account.
            const [incomplete] = await tx
              .select({ id: PosUser.id })
              .from(PosUser)
              .where(eq(PosUser.email, ''))
              .limit(1)
              .for('share');
            if (incomplete)
              throw new AppError(
                409,
                'OPERATOR_MODEL_EMAIL_SETUP_REQUIRED',
                'Complete the existing administrative account email before creating another account.',
              );
            const id = generatedId(
              await tx.insert(PosUser).values({
                username: input.username,
                password,
                first_name: '',
                last_name: '',
                is_active: true,
                is_staff: false,
                is_superuser: false,
                date_joined: clock()
                  .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
                  .toPlainDateTime()
                  .toString({ smallestUnit: 'second' })
                  .replace('T', ' '),
                last_login: null,
                role: 1,
                user_type: 1,
                otp_method: 2,
                email: '',
                phone: null,
                contact_email: null,
                age: null,
                gender: null,
                is_mfa: false,
                mfa_hash: null,
                profile_image: 'uploads/users/profile_image/default_profile_image.png',
                cover_image: 'uploads/users/cover_image/default_cover_image.png',
              }),
            );
            const result = modelAccountResult.parse({
              id: String(id),
              operationId: input.operationId,
              actorId: user.id,
              status: 'success',
              message: 'Administrative account created.',
            });
            return result;
          }),
        );
        await receipts.save(user, input.operationId, resource, action, hash, result);
        return result;
      });
    },
    async read(user: Principal, operationId: string) {
      z.uuid().parse(operationId);
      await db.get('writer').transaction((tx) => authorize(tx, user));
      const saved = await receipts.read(operationId);
      if (
        !saved ||
        saved.actorId !== user.id ||
        saved.resourceId !== resource ||
        saved.action !== action
      )
        throw new AppError(
          404,
          'OPERATOR_MODEL_ACCOUNT_NOT_FOUND',
          'The original account operation was not found.',
        );
      return modelAccountResult.parse(saved.result);
    },
  };
}
