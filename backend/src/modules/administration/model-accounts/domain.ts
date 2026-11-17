import { z } from 'zod';
import { administrationUsername } from '../operator-admin-domain.js';
export const modelAccountInput = z
  .object({
    operationId: z.uuid(),
    username: administrationUsername,
    password: z.string().min(1).max(512),
    confirmation: z.string().min(1).max(512),
  })
  .strict()
  .refine(
    (value) => value.password === value.confirmation,
    'The password confirmation must match.',
  );
export const modelAccountResult = z
  .object({
    id: z.string().regex(/^[1-9]\d{0,18}$/),
    operationId: z.uuid(),
    actorId: z.string().regex(/^[1-9]\d{0,18}$/),
    status: z.literal('success'),
    message: z.literal('Administrative account created.'),
  })
  .strict();
export const modelAccountDefaults = {
  role: 1,
  userType: 1,
  otpMethod: 2,
  active: true,
  staff: false,
  superuser: false,
  mfa: false,
  firstName: '',
  lastName: '',
  email: '',
  phone: null,
  contactEmail: null,
  age: null,
  gender: null,
  lastLogin: null,
} as const;
