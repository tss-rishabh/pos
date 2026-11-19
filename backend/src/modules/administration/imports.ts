import { Temporal } from '@js-temporal/polyfill';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { CsvUpload, PosUser } from '../../db/legacy-schema.js';
import { generatedId } from '../../db/generated-id.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError, unavailable } from '../../domain/errors.js';
import type { ModuleRuntime } from '../../jobs/module-runtime.js';
import { assertCurrentOperatorRole } from './authorization.js';
import {
  failedData,
  importMessages,
  importProgressKey,
  importProgressTtlSeconds,
  initialProgress,
  pythonCsv,
  templates,
  type CsvUploadInput,
  type UploadType,
  type uploadListInput,
} from './import-domain.js';
import type { CsvUploadStorage } from './import-storage.js';
import type { InventoryOptions } from './inventory.js';

export interface InventoryImportOptions extends InventoryOptions {
  /** Job producer and Redis state (`src/jobs/module-runtime.ts`). */
  moduleRuntime?: ModuleRuntime;
  csvStorage?: CsvUploadStorage;
}

/** Celery task per upload type (`core/views.py:139,393`). */
export const importJobNames = {
  PRODUCT_STORE_CSV: 'core.tasks.parse_csv_product_store',
  PRODUCT_STOCK_CSV: 'core.tasks.parse_csv_product_stock',
} as const;

/**
 * Stock administration is closed to franchise users (`ProductsStockView` `user_type_exempt([2])`,
 * `core/views.py:155`) and kept to roles 1-3 as the single-edit stock screen.
 */
function authorize(user: Principal) {
  requireRole(user, [1, 2, 3]);
  if (user.userType !== 1)
    throw new AppError(
      403,
      'INVENTORY_ADMINISTRATION_DENIED',
      'Stock administration is restricted for this user type.',
    );
}
const notFound = () => new AppError(404, 'CSV_UPLOAD_NOT_FOUND', 'This CSV upload was not found.');

/** `pos_csv_upload` uploads (`core/views.py:122-142,374-397`) and their history. */
export function inventoryImportService(
  config: Config,
  db: Databases,
  options: InventoryImportOptions = {},
) {
  const localNow = () => Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDateTime();
  const timestamp = () => localNow().toString({ smallestUnit: 'second' }).replace('T', ' ');
  /** `Helpers.create_file_name` / `RenameUploadedFile`: `%Y_%m_%d-%H-%M-%S`. */
  const stamp = () => {
    const now = localNow(),
      two = (value: number) => String(value).padStart(2, '0');
    return `${now.year}_${two(now.month)}_${two(now.day)}-${two(now.hour)}-${two(now.minute)}-${two(now.second)}`;
  };
  async function readable(user: Principal, id: string) {
    const [row] = await db
      .get('primary')
      .select({
        id: CsvUpload.id,
        uploadType: CsvUpload.upload_type,
        uploadedBy: CsvUpload.uploaded_by,
        message: CsvUpload.message,
        failedData: CsvUpload.failed_data,
        isImported: CsvUpload.is_imported,
        createdAt: CsvUpload.created_at,
        updatedAt: CsvUpload.updated_at,
      })
      .from(CsvUpload)
      .where(eq(CsvUpload.id, BigInt(id)))
      .limit(1);
    if (
      !row ||
      (row.uploadType !== 'PRODUCT_STOCK_CSV' && row.uploadType !== 'PRODUCT_STORE_CSV') ||
      (user.role !== 1 && String(row.uploadedBy) !== user.id)
    )
      throw notFound();
    return row;
  }
  const summary = (row: {
    id: bigint;
    uploadType: string | null;
    uploadedBy: bigint | null;
    uploaderName?: string | null;
    message: string | null;
    isImported: boolean;
    createdAt: string | null;
    updatedAt: string | null;
  }) => ({
    id: String(row.id),
    uploadType: row.uploadType,
    uploadedBy: row.uploadedBy === null ? null : String(row.uploadedBy),
    ...(row.uploaderName === undefined ? {} : { uploaderName: row.uploaderName }),
    message: row.message,
    isImported: row.isImported,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return {
    /** Kept for the catalog product screen, which gates its edit controls on these flags. */
    capabilities(user: Principal) {
      authorize(user);
      return {
        visibilityEnabled: true,
        stockEnabled: !!options.procedureVerified,
        uploadEnabled: !!options.csvStorage && !!options.moduleRuntime,
      };
    },
    template(user: Principal, type: UploadType) {
      authorize(user);
      const template = templates[type];
      return { filename: `${template.prefix}${stamp()}.csv`, content: pythonCsv(template.rows) };
    },
    /** Store the file, write `pos_csv_upload`, then enqueue the legacy task after commit. */
    async upload(user: Principal, input: CsvUploadInput) {
      authorize(user);
      const storage = options.csvStorage,
        runtime = options.moduleRuntime;
      if (!storage) return unavailable('CSV file storage');
      if (!runtime) return unavailable('Job queue');
      await db.get('writer').transaction((tx) => assertCurrentOperatorRole(tx, user.id, [1, 2, 3]));
      const filename = await storage.save(
        `uploads/csv/Csv-${stamp()}.csv`,
        Buffer.from(input.csv, 'utf8'),
      );
      const now = timestamp();
      const id = String(
        generatedId(
          await db
            .get('writer')
            .insert(CsvUpload)
            .values({
              upload_type: input.type,
              uploaded_by: BigInt(user.id),
              filename,
              is_imported: false,
              created_at: now,
              updated_at: now,
            }),
        ),
      );
      await runtime.ephemeral.set(importProgressKey(id), JSON.stringify(initialProgress()), {
        EX: importProgressTtlSeconds,
      });
      await runtime.jobs.enqueue(
        importJobNames[input.type],
        { upload_id: id, user_id: user.id, role_id: user.role },
        { queue: 'core' },
      );
      return { id, message: importMessages.uploaded };
    },
    async list(user: Principal, input: z.infer<typeof uploadListInput>) {
      authorize(user);
      const rows = await db
        .get('primary')
        .select({
          id: CsvUpload.id,
          uploadType: CsvUpload.upload_type,
          uploadedBy: CsvUpload.uploaded_by,
          firstName: PosUser.first_name,
          lastName: PosUser.last_name,
          message: CsvUpload.message,
          isImported: CsvUpload.is_imported,
          createdAt: CsvUpload.created_at,
          updatedAt: CsvUpload.updated_at,
        })
        .from(CsvUpload)
        .leftJoin(PosUser, eq(PosUser.id, CsvUpload.uploaded_by))
        .where(
          and(
            // Only the two inventory upload types are live (order punch-in CSVs are removed).
            input.type
              ? eq(CsvUpload.upload_type, input.type)
              : inArray(CsvUpload.upload_type, ['PRODUCT_STOCK_CSV', 'PRODUCT_STORE_CSV']),
            input.before ? lt(CsvUpload.id, BigInt(input.before)) : undefined,
            user.role === 1 ? undefined : eq(CsvUpload.uploaded_by, BigInt(user.id)),
          ),
        )
        .orderBy(desc(CsvUpload.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return {
        data: page.map((row) =>
          summary({
            ...row,
            uploaderName:
              row.firstName === null && row.lastName === null
                ? null
                : `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
          }),
        ),
        nextBefore: rows.length > input.limit ? String(rows[input.limit - 1]!.id) : null,
      };
    },
    async detail(user: Principal, id: string) {
      authorize(user);
      const row = await readable(user, id);
      let failed: z.infer<typeof failedData> | null = null;
      if (row.failedData !== null) {
        try {
          const parsed = failedData.safeParse(JSON.parse(row.failedData) as unknown);
          failed = parsed.success ? parsed.data : null;
        } catch {
          failed = null;
        }
      }
      return { ...summary(row), failedData: failed };
    },
  };
}
