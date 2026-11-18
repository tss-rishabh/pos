import { generatedId } from '../../db/generated-id.js';
import { Temporal } from '@js-temporal/polyfill';
import { eq, or } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { MUser, PosUser } from '../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { manageableOperator } from './policies.js';
import type { OperatorInput } from './contracts.js';
import { lockAdministrationRegistry } from './locks.js';
import { retryTransaction } from '../../db/retry.js';
import { djangoPasswordHash } from '../../auth/crypto.js';
import { assertPasswordPolicy } from '../../auth/password-policy.js';
import { assertCurrentOperatorIdentity } from './authorization.js';

export { djangoPasswordHash };
/** Values preserve Helpers.create_muser plus the Django model field defaults. */
export function operatorMirrorValues(
  id: bigint,
  input: OperatorInput,
  timestamp: string,
): typeof MUser.$inferInsert {
  return {
    firstname: input.firstName,
    lastname: input.lastName,
    company_name: '',
    email: input.email,
    telephone: input.phone,
    password: '',
    plain_password: '',
    birthdate: '2000-01-01',
    gender: '',
    anniversary: null,
    salt: '',
    cart: null,
    wishlist: null,
    newsletter: 0,
    ip: '',
    status: 1,
    approved: 0,
    user_type: '8',
    profile_pic: '',
    cover_pic: '',
    mobile_cover_pic: '',
    size_chart: '',
    logo: '',
    url_key: 'User-' + input.firstName,
    desc: '',
    remember_token: '',
    loyalty_group: 1,
    cashback: 0,
    tss_money: 0,
    tss_points: 0,
    referal_code: '',
    platform: '',
    user_platform: 'STORE_FRONT_USER',
    pos_admin_id: id,
    fb_id: '',
    plus_id: '',
    apple_id: '',
    sort_order: 0n,
    es_search_order: 1000,
    is_merch: 0,
    meta_title: '',
    meta_keys: '',
    meta_desc: '',
    art_bank_details: '',
    art_status: 0,
    is_featured: 0,
    es_search_keywords: '',
    og_title: '',
    og_description: '',
    twitter_title: '',
    twitter_description: '',
    breadcrum_title: '',
    breadcrum_name: '',
    popular_search: '',
    shop_now: '',
    is_from_megento: 0,
    is_cod_enable: 1,
    is_two_fa: 1,
    created_at: timestamp,
    updated_at: timestamp,
    customer_type: 'B2C',
    gstin: '',
    order_gender: '',
    artist_alias_name: '',
  };
}
export function operatorCreator(config: Config, db: Databases) {
  return async (user: Principal, input: OperatorInput) => {
    requireRole(user, [1, 2, 3]);
    manageableOperator(user, 'new-account', input.role, input.role);
    if (user.userType === 2 && input.userType !== 2)
      throw new AppError(
        403,
        'OPERATOR_SCOPE_DENIED',
        'This user type is outside your organization.',
      );
    if (!input.password)
      throw new AppError(400, 'PASSWORD_REQUIRED', 'A password is required for a new account.');
    assertPasswordPolicy(input.password, {
      username: input.email,
      email: input.email,
      first_name: input.firstName,
      last_name: input.lastName,
    });
    const hash = await djangoPasswordHash(input.password),
      timestamp = Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
        .toPlainDateTime()
        .toString({ smallestUnit: 'second' })
        .replace('T', ' ');
    return retryTransaction(() =>
      db.get('writer').transaction(async (transaction) => {
        await lockAdministrationRegistry(transaction, 'operators');
        // Hashing precedes the transaction. Hold current actor authority through
        // both identity inserts so a revocation during hashing cannot admit them.
        const identity = await assertCurrentOperatorIdentity(transaction, user.id, [1, 2, 3]);
        manageableOperator({ ...user, ...identity }, 'new-account', input.role, input.role);
        if (identity.userType === 2 && input.userType !== 2)
          throw new AppError(
            403,
            'OPERATOR_SCOPE_DENIED',
            'This user type is outside your organization.',
          );
        const [duplicate] = await transaction
          .select({ id: PosUser.id })
          .from(PosUser)
          .where(
            or(
              eq(PosUser.email, input.email),
              eq(PosUser.username, input.email),
              eq(PosUser.phone, input.phone),
              eq(PosUser.contact_email, input.contactEmail),
            ),
          )
          .limit(1);
        if (duplicate)
          throw new AppError(
            409,
            'OPERATOR_ALREADY_EXISTS',
            'Email, contact email, or phone is already in use.',
          );
        const [mirror] = await transaction
          .select({ id: MUser.id })
          .from(MUser)
          .where(eq(MUser.email, input.email))
          .limit(1);
        if (mirror)
          throw new AppError(
            409,
            'OPERATOR_MIRROR_CONFLICT',
            'This email already belongs to an existing customer or staff identity.',
          );
        const inserted = await transaction.insert(PosUser).values({
          username: input.email,
          password: hash,
          first_name: input.firstName,
          last_name: input.lastName,
          is_active: true,
          is_staff: false,
          is_superuser: false,
          last_login: null,
          date_joined: timestamp,
          role: input.role,
          gender: null,
          age: null,
          phone: input.phone,
          email: input.email,
          is_mfa: false,
          mfa_hash: null,
          profile_image: 'uploads/users/profile_image/default_profile_image.png',
          cover_image: 'uploads/users/cover_image/default_cover_image.png',
          contact_email: input.contactEmail,
          otp_method: input.otpMethod,
          user_type: input.userType,
        });
        const id = generatedId(inserted);
        if (!id)
          throw new AppError(500, 'OPERATOR_CREATE_FAILED', 'Could not create this operator.');
        await transaction.insert(MUser).values(operatorMirrorValues(id, input, timestamp));
        return { id: String(id), message: 'User has been created.' };
      }),
    );
  };
}
