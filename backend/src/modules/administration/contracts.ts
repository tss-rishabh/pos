import { z } from 'zod';
import { identifier, cursor } from '../../domain/validation.js';
import { slackWebhook } from './slack-url.js';

const trimmed = (length: number) => z.string().trim().min(1).max(length);
const optionalText = (length: number) => z.string().trim().max(length).default('');
const phone = z.string().regex(/^[1-9]\d{9}$/);
const positiveIdNumber = z.number().int().min(0).max(2_147_483_647);
export const defaultStoreImage = 'uploads/stores/stores_image/default_store_image.jpeg';
export const pageQuery = z
  .object({
    after: cursor.default('0'),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    search: z.string().trim().max(100).default(''),
    active: z.enum(['true', 'false', 'all']).default('true'),
  })
  .strict();
export const statusInput = z.object({ active: z.boolean() }).strict();
export const storeInput = z
  .object({
    name: trimmed(100),
    locationCode: trimmed(255),
    type: z.enum(['STORE', 'WAREHOUSE', 'CORE_WAREHOUSE', 'BUBBLE_STORE']),
    category: z.enum(['IN_HOUSE', 'FRANCHISE']),
    latitude: z
      .string()
      .regex(/^-?\d{1,2}(?:\.\d{1,16})?$/)
      .refine((v) => Math.abs(Number(v)) <= 90),
    longitude: z
      .string()
      .regex(/^-?\d{1,3}(?:\.\d{1,16})?$/)
      .refine((v) => Math.abs(Number(v)) <= 180),
    address: trimmed(500),
    alternateAddress: optionalText(500),
    cityId: positiveIdNumber,
    countryId: positiveIdNumber,
    phone: phone.refine(
      (value) => BigInt(value) >= 1_111_111_111n,
      'Enter a valid store phone number.',
    ),
    email: z.union([z.email().max(55), z.literal('')]).default(''),
    pincode: optionalText(10),
    dailyThreshold: z.number().int().min(0).max(1000000).default(0),
    hourlyThreshold: z.number().int().min(0).max(1000000).default(0),
    gstin: z
      .union([z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/), z.literal('')])
      .default(''),
    shortName: trimmed(100),
    slackUrl: z.union([slackWebhook, z.literal('')]).optional(),
    removeSlack: z.boolean().default(false),
    city: optionalText(255),
    state: optionalText(255),
    stateId: positiveIdNumber.default(0),
    imagePath: optionalText(254).default(defaultStoreImage),
    franchiseId: identifier.optional(),
    franchise: z
      .object({ name: trimmed(255), description: optionalText(255), cin: optionalText(100) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.removeSlack && value.slackUrl)
      context.addIssue({
        code: 'custom',
        message: 'Choose a replacement webhook or remove the connection.',
        path: ['slackUrl'],
      });
    if (value.category === 'FRANCHISE' && !value.franchise && !value.franchiseId)
      context.addIssue({
        code: 'custom',
        message: 'Franchise details are required.',
        path: ['franchise'],
      });
    if (value.franchise && value.franchiseId)
      context.addIssue({
        code: 'custom',
        message: 'Choose existing franchise association or franchise details.',
        path: ['franchiseId'],
      });
    if (value.category !== 'FRANCHISE' && (value.franchise || value.franchiseId))
      context.addIssue({
        code: 'custom',
        message: 'Franchise details apply only to franchise stores.',
        path: ['category'],
      });
  });
export type StoreInput = z.infer<typeof storeInput>;
export const storageInput = z
  .object({ name: trimmed(80), description: trimmed(255), type: z.literal('STORAGE') })
  .strict();
export const storageUpdateInput = storageInput.extend({
  name: trimmed(100),
  destinationStoreId: identifier.optional(),
});
export const locationCodeInput = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,4}$/),
  })
  .strict();
export const counterInput = z
  .object({ description: z.string().trim().max(255).default('') })
  .strict();
const deliveryTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/)
  .transform((value) => (value.length === 5 ? `${value}:00` : value));
export const deliverySlotInput = z
  .object({
    weekday: z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']),
    start: deliveryTime,
    end: deliveryTime,
  })
  .strict();
export type DeliverySlotInput = z.infer<typeof deliverySlotInput>;
export const salespersonInput = z
  .object({
    employeeId: trimmed(45),
    firstName: trimmed(45),
    lastName: trimmed(45),
    email: z.email().max(45),
    phone,
    userType: z.union([z.literal(1), z.literal(2)]),
    active: z.boolean().default(true),
  })
  .strict();
export type SalespersonInput = z.infer<typeof salespersonInput>;
export const operatorInput = z
  .object({
    firstName: trimmed(150),
    lastName: trimmed(150),
    email: z.email().max(254),
    phone,
    role: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    contactEmail: z.email().max(254),
    otpMethod: z.union([z.literal(1), z.literal(2)]),
    userType: z.union([z.literal(1), z.literal(2)]),
    password: z.string().min(12).max(128).optional(),
  })
  .strict();
export type OperatorInput = z.infer<typeof operatorInput>;
export const operatorCreateInput = operatorInput
  .extend({
    firstName: trimmed(32),
    lastName: trimmed(32),
    email: z.email().max(96),
    password: z.string().min(12).max(128),
    confirmPassword: z.string().min(12).max(128),
  })
  .superRefine((value, context) => {
    if (value.password !== value.confirmPassword)
      context.addIssue({
        code: 'custom',
        message: 'Passwords must match.',
        path: ['confirmPassword'],
      });
  });
export const assignmentInput = z.object({ storeIds: z.array(identifier).max(500) }).strict();
export const salespersonAssignmentInput = assignmentInput.extend({
  activeStoreId: identifier.nullable(),
});
export const stockInput = z
  .object({
    stock: z.number().int().min(0).max(2_147_483_647),
    expectedStock: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  })
  .strict();
export const visibilityInput = z
  .object({
    kind: z.enum(['available', 'listed']),
    checked: z.boolean(),
    parentProductId: identifier.nullable().default(null),
  })
  .strict();
export const checkInInput = z
  .object({ storeId: identifier, counterId: identifier.nullable().default(null) })
  .strict();
export const tutorialInput = z
  .object({
    title: trimmed(255),
    summary: trimmed(255),
    description: z.string().max(20000),
    keywords: optionalText(255),
    sortOrder: z.number().int().min(0).max(100000),
    coverImage: z.array(z.url()).max(1),
    images: z.array(z.url()).max(30),
    videos: z.array(z.url()).max(20),
    documents: z.array(z.url()).max(20),
  })
  .strict();
