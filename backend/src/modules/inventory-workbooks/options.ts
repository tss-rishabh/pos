import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
export function readInventoryWorkbookOptions(
  environment: Record<string, string | undefined> = process.env,
) {
  return z
    .object({
      INVENTORY_WORKBOOK_PAGE_SIZE: z.coerce.number().int().min(100).max(500).default(250),
      INVENTORY_WORKBOOK_STAGING_DIRECTORY: z
        .string()
        .refine((value) => isAbsolute(value) && !/[\p{C}]/u.test(value))
        .default(join(tmpdir(), 'pos-report-workbooks')),
      INVENTORY_WORKBOOK_MAX_BUILD_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(1800000)
        .default(900000),
      INVENTORY_WORKBOOK_MAX_XML_BYTES: z.coerce
        .number()
        .int()
        .min(1048576)
        .max(2147483648)
        .default(536870912),
      INVENTORY_WORKBOOK_MAX_SHEET_XML_BYTES: z.coerce
        .number()
        .int()
        .min(1048576)
        .max(1073741824)
        .default(268435456),
      INVENTORY_WORKBOOK_STAGING_TTL_MS: z.coerce
        .number()
        .int()
        .min(3600000)
        .max(604800000)
        .default(86400000),
      INVENTORY_WORKBOOK_LEGACY_MAX_ENTRIES: z.coerce
        .number()
        .int()
        .min(10)
        .max(3000)
        .default(1024),
      INVENTORY_WORKBOOK_LEGACY_MAX_XML_BYTES: z.coerce
        .number()
        .int()
        .min(1048576)
        .max(2147483648)
        .default(536870912),
      INVENTORY_WORKBOOK_LEGACY_MAX_ENTRY_BYTES: z.coerce
        .number()
        .int()
        .min(1048576)
        .max(1073741824)
        .default(268435456),
    })
    .parse(environment);
}
export type InventoryWorkbookOptions = ReturnType<typeof readInventoryWorkbookOptions>;
