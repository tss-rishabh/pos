import { createHmac } from 'node:crypto';
import { and, eq, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Databases } from '../db/pools.js';
import { PosUser } from '../db/legacy-schema.js';
import { retryTransaction } from '../db/retry.js';
import { AppError } from '../domain/errors.js';
import type { Principal } from '../domain/access.js';
import { credentialVersion, djangoPasswordHash, verifyDjangoPassword } from './crypto.js';
import { assertPasswordPolicy } from './password-policy.js';

/** mysql2 duplicate-key error on the pos_user unique keys (email, phone, contact_email). */
function duplicateKey(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && current.code === 'ER_DUP_ENTRY') return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

const password = z.string().min(1).max(512);
const phone = z
  .string()
  .regex(/^\d{10}$/)
  .refine((value) => BigInt(value) >= 1111111111n)
  .nullable();
export const profileInput = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    firstName: z.string().trim().max(150),
    lastName: z.string().trim().max(150),
    gender: z.enum(['M', 'F', 'O']).nullable(),
    age: z.number().int().min(0).max(2147483647).nullable(),
    email: z.email().max(254).nullable(),
    phone,
    contactEmail: z.email().max(254).nullable(),
    otpMethod: z.enum(['sms', 'email']),
    currentPassword: password.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.otpMethod === 'email' && !input.contactEmail)
      context.addIssue({
        code: 'custom',
        path: ['contactEmail'],
        message: 'Add an OTP contact email.',
      });
    if (input.otpMethod === 'sms' && !input.phone)
      context.addIssue({ code: 'custom', path: ['phone'], message: 'Add an OTP phone number.' });
  });
export const passwordInput = z
  .object({
    currentPassword: password,
    newPassword: password.min(8),
    confirmation: password,
  })
  .strict()
  .refine((input) => input.newPassword === input.confirmation, {
    path: ['confirmation'],
    message: 'Passwords must match.',
  });
type Account = typeof PosUser.$inferSelect;
export function profileRevision(config: Config, row: Account) {
  return createHmac('sha256', config.SESSION_SECRET)
    .update(
      JSON.stringify([
        row.id.toString(),
        credentialVersion(row),
        row.first_name,
        row.last_name,
        row.email,
        row.gender,
        row.age,
        row.profile_image,
        row.cover_image,
      ]),
    )
    .digest('hex');
}
export function profileService(
  config: Config,
  db: Databases,
  options: { imagesAvailable?: boolean } = {},
) {
  const revision = (row: Account) => profileRevision(config, row);
  function view(row: Account) {
    return {
      firstName: row.first_name,
      lastName: row.last_name,
      gender: row.gender,
      age: row.age,
      email: row.email,
      phone: row.phone,
      contactEmail: row.contact_email,
      otpMethod: row.otp_method === 1 ? ('sms' as const) : ('email' as const),
      mfaEnabled: Boolean(row.is_mfa),
      canChangeEmailAndPhone: row.role === 1,
      hasProfileImage: Boolean(row.profile_image),
      hasCoverImage: Boolean(row.cover_image),
      imagesAvailable: Boolean(options.imagesAvailable),
      revision: revision(row),
    };
  }
  async function account(user: Principal) {
    const [row] = await db
      .get('writer')
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(user.id)))
      .limit(1);
    if (!row || !row.is_active) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return row;
  }
  async function currentPassword(row: Account, supplied: string | undefined) {
    if (!supplied || !(await verifyDjangoPassword(supplied, row.password)))
      throw new AppError(400, 'CURRENT_PASSWORD_INVALID', 'Check your current password.');
  }
  async function locked(
    user: Principal,
    expected: string,
    change: (row: Account) => Partial<Account>,
    protectUnique = false,
  ) {
    // Legacy profile and password saves take no registry lock (users/views.py:297-316,508-516);
    // the pos_user unique keys reject a duplicate contact.
    try {
      return await retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(PosUser)
            .where(eq(PosUser.id, BigInt(user.id)))
            .limit(1)
            .for('update');
          if (!row || !row.is_active)
            throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
          if (revision(row) !== expected)
            throw new AppError(
              409,
              'PROFILE_CHANGED',
              'Your profile changed. Reload it before saving.',
            );
          const values = change(row);
          if (protectUnique) {
            const [duplicate] = await tx
              .select({ id: PosUser.id })
              .from(PosUser)
              .where(
                and(
                  ne(PosUser.id, row.id),
                  or(
                    values.email ? eq(PosUser.email, values.email) : undefined,
                    values.phone ? eq(PosUser.phone, values.phone) : undefined,
                    values.contact_email
                      ? eq(PosUser.contact_email, values.contact_email)
                      : undefined,
                  ),
                ),
              )
              .limit(1);
            if (duplicate)
              throw new AppError(
                409,
                'PROFILE_CONTACT_UNAVAILABLE',
                'A contact field is already in use.',
              );
          }
          await tx.update(PosUser).set(values).where(eq(PosUser.id, row.id));
          const updated = { ...row, ...values };
          return {
            profile: view(updated),
            /** Set when the password hash changed: other sessions end on their next request. */
            password: updated.password !== row.password ? updated.password : null,
          };
        }),
      );
    } catch (error) {
      if (duplicateKey(error))
        throw new AppError(
          409,
          'PROFILE_CONTACT_UNAVAILABLE',
          'That email or phone number is already used by another account.',
        );
      throw error;
    }
  }
  return {
    async get(user: Principal) {
      return view(await account(user));
    },
    async update(user: Principal, input: z.infer<typeof profileInput>) {
      const row = await account(user);
      if (revision(row) !== input.revision)
        throw new AppError(
          409,
          'PROFILE_CHANGED',
          'Your profile changed. Reload it before saving.',
        );
      if (row.role !== 1 && (row.email !== input.email || row.phone !== input.phone))
        throw new AppError(
          403,
          'PROFILE_CONTACT_CHANGE_DENIED',
          'Ask an administrator to change your email or phone.',
        );
      if (row.role === 1 && (!input.email || !input.phone))
        throw new AppError(
          400,
          'PROFILE_CONTACT_REQUIRED',
          'An administrator account requires email and phone.',
        );
      const otpMethod = input.otpMethod === 'sms' ? 1 : 2;
      const sensitive =
        row.email !== input.email ||
        row.phone !== input.phone ||
        row.contact_email !== input.contactEmail ||
        row.otp_method !== otpMethod;
      if (sensitive) await currentPassword(row, input.currentPassword);
      return locked(
        user,
        input.revision,
        () => ({
          first_name: input.firstName,
          last_name: input.lastName,
          gender: input.gender,
          age: input.age,
          email: input.email,
          phone: input.phone,
          contact_email: input.contactEmail,
          otp_method: otpMethod,
        }),
        true,
      );
    },
    async changePassword(user: Principal, input: z.infer<typeof passwordInput>) {
      const row = await account(user);
      await currentPassword(row, input.currentPassword);
      assertPasswordPolicy(input.newPassword, row);
      const hash = await djangoPasswordHash(input.newPassword);
      return locked(user, revision(row), () => ({ password: hash }));
    },
  };
}
export type ProfileService = ReturnType<typeof profileService>;
