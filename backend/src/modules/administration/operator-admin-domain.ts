import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';

const version = z.string().regex(/^[a-f0-9]{64}$/);
const email = z
  .union([z.email().max(254), z.literal(''), z.null()])
  .transform((value) => value || null);
const phone = z
  .union([z.string().regex(/^[1-9]\d{9}$/), z.literal(''), z.null()])
  .transform((value) => value || null);
const strip = (value: string) =>
  value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, '');
const name = z
  .string()
  .max(600)
  .transform(strip)
  .refine((value) => Array.from(value).length <= 150, 'Use up to 150 characters.');
export const administrationUsername = z
  .string()
  .max(600)
  .transform(strip)
  .transform((value) => value.normalize('NFKC'))
  .refine(
    (value) =>
      Array.from(value).length >= 1 &&
      Array.from(value).length <= 150 &&
      /^[\p{L}\p{N}_@.+-]+$/u.test(value),
    'Use a username of up to 150 letters, numbers or @ . + - _ characters.',
  );
export const administrationWallTimestamp = z
  .string()
  .regex(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[ T](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/,
  )
  .refine((value) => {
    try {
      return (
        Temporal.PlainDateTime.from(value.replace(' ', 'T'), { overflow: 'reject' }).year >= 1000
      );
    } catch {
      return false;
    }
  }, 'Choose a valid date and time.')
  .transform((value) => value.replace('T', ' '));
export const operatorAdminProfileInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: version,
    username: administrationUsername,
    firstName: name,
    lastName: name,
    email,
    phone,
    contactEmail: email,
    age: z.number().int().min(0).max(150).nullable(),
    gender: z.enum(['M', 'F', 'O']).nullable(),
    role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    userType: z.union([z.literal(1), z.literal(2)]),
    otpMethod: z.union([z.literal(1), z.literal(2)]),
    active: z.boolean(),
    lastLogin: z
      .union([administrationWallTimestamp, z.literal(''), z.null()])
      .transform((value) => value || null),
    dateJoined: administrationWallTimestamp,
  })
  .strict();
export const operatorAdminPasswordInput = z
  .object({
    operationId: z.uuid(),
    expectedVersion: version,
    newPassword: z.string().min(8).max(128),
    confirmation: z.string().min(8).max(128),
  })
  .strict()
  .refine(
    (value) => value.newPassword === value.confirmation,
    'The password confirmation must match.',
  );
export const operatorAdminMutationResult = z.object({
  id: z.string(),
  status: z.literal('success'),
  message: z.string(),
  credentialsChanged: z.boolean(),
});
