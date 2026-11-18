import { z } from 'zod';
import { identifier } from '../../domain/validation.js';
export const administrationCollectionColumns = {
  stores: [
    'id',
    'name',
    'locationCode',
    'type',
    'category',
    'phone',
    'email',
    'city',
    'state',
    'address',
    'alternateAddress',
    'pincode',
    'gstin',
    'shortName',
    'active',
  ],
  operators: [
    'id',
    'name',
    'email',
    'phone',
    'role',
    'userType',
    'contactEmail',
    'otpMethod',
    'mfa',
    'stores',
    'active',
  ],
  salespeople: [
    'id',
    'employeeId',
    'name',
    'email',
    'phone',
    'userType',
    'stores',
    'activeStore',
    'active',
  ],
  counters: ['id', 'storeId', 'name', 'type', 'description', 'active'],
  storage: ['id', 'storeId', 'name', 'type', 'description', 'active'],
  documentation: ['id', 'title', 'summary', 'uploader', 'updatedAt', 'sortOrder', 'active'],
} as const;
export const administrationCollectionSorts = {
  stores: ['id', 'name', 'locationCode', 'type', 'category', 'phone', 'email', 'city', 'active'],
  operators: ['id', 'firstName', 'lastName', 'email', 'phone', 'role', 'userType', 'active'],
  salespeople: [
    'id',
    'employeeId',
    'firstName',
    'lastName',
    'email',
    'phone',
    'userType',
    'active',
  ],
  counters: ['id', 'name', 'type', 'description', 'active'],
  storage: ['id', 'name', 'type', 'description', 'active'],
  documentation: ['id', 'title', 'summary', 'updatedAt', 'sortOrder', 'active'],
} as const;
export const administrationCollectionExportInputSchema = z
  .object({
    kind: z.literal('administration-list'),
    resource: z.enum([
      'stores',
      'operators',
      'salespeople',
      'counters',
      'storage',
      'documentation',
    ]),
    storeIds: z.array(identifier).max(1).default([]),
    search: z.string().trim().max(100).default(''),
    active: z.enum(['true', 'false', 'all']).default('true'),
    sort: z.string().max(32).default('id'),
    direction: z.enum(['asc', 'desc']).default('asc'),
    columns: z.array(z.string().max(32)).min(1).max(20),
    label: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((v) => !/[\p{C}]/u.test(v))
      .optional(),
    note: z.string().trim().max(255).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const columns: readonly string[] = administrationCollectionColumns[value.resource],
      sorts: readonly string[] = administrationCollectionSorts[value.resource];
    if (
      value.columns.some((key) => !columns.includes(key)) ||
      new Set(value.columns).size !== value.columns.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Choose distinct supported columns.',
        path: ['columns'],
      });
    if (!sorts.includes(value.sort))
      ctx.addIssue({ code: 'custom', message: 'Choose a supported sort column.', path: ['sort'] });
    if (
      value.resource === 'counters' || value.resource === 'storage'
        ? value.storeIds.length !== 1
        : value.storeIds.length !== 0
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Choose the collection store scope.',
        path: ['storeIds'],
      });
  });
export type AdministrationCollectionExportInput = z.infer<
  typeof administrationCollectionExportInputSchema
>;
