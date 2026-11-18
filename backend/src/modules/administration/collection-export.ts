import { eq } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosUser, UserStore } from '../../db/legacy-schema.js';
import { roles } from '../../domain/access.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import type { ExportArtifact, ExportBuildContext } from '../operational-reports/export-artifact.js';
import type { AdministrationTransaction } from './checkins.js';
import { assertCurrentOperatorRole, assertCurrentStoreAccess } from './authorization.js';
import {
  administrationCollectionExportInputSchema,
  type AdministrationCollectionExportInput,
} from './collection-export-contracts.js';
import { administrationService } from './service.js';
import { documentationService } from './documentation.js';
import { documentationPageQuery } from './media-domain.js';

export function collectionExportScope(user: Principal, input: AdministrationCollectionExportInput) {
  return {
    storeIds: input.storeIds.length
      ? input.storeIds
      : input.resource === 'stores' && !(user.role === 1 && user.userType === 1)
        ? user.storeIds
        : [],
    requiresGlobal: input.resource === 'stores' && user.role === 1 && user.userType === 1,
  };
}
/** Called by the shared queue at admission, build and download, under native locks. */
export async function assertAdministrationCollectionExport(
  tx: AdministrationTransaction,
  user: Principal,
  supplied: AdministrationCollectionExportInput,
) {
  const input = administrationCollectionExportInputSchema.parse(supplied);
  const role = await assertCurrentOperatorRole(
    tx,
    user.id,
    input.resource === 'documentation' && input.active === 'true'
      ? [1, 2, 3, 4, 5]
      : input.resource === 'documentation'
        ? [1]
        : [1, 2, 3],
  );
  const [actor] = await tx
    .select({ userType: PosUser.user_type })
    .from(PosUser)
    .where(eq(PosUser.id, BigInt(user.id)))
    .limit(1)
    .for('share');
  if (role !== user.role || actor?.userType !== user.userType)
    throw new AppError(
      403,
      'ADMINISTRATION_EXPORT_ACCESS_CHANGED',
      'Refresh your current operator access before exporting.',
    );
  if (input.resource === 'stores' && !(role === 1 && user.userType === 1)) {
    const assignments = await tx
      .select({ storeId: UserStore.store_id })
      .from(UserStore)
      .where(eq(UserStore.django_user_id, BigInt(user.id)))
      .limit(10001)
      .for('share');
    const current = new Set(
      assignments.flatMap((row) => (row.storeId === null ? [] : [String(row.storeId)])),
    );
    if (
      assignments.length > 10000 ||
      current.size !== new Set(user.storeIds).size ||
      user.storeIds.some((id) => !current.has(id))
    )
      throw new AppError(
        403,
        'ADMINISTRATION_EXPORT_ACCESS_CHANGED',
        'Refresh your store assignments before exporting.',
      );
  }
  for (const storeId of input.storeIds)
    await assertCurrentStoreAccess(tx, user.id, storeId, [1, 2, 3], 'share');
}
const labels: Readonly<Record<string, string>> = {
  id: 'ID',
  name: 'Name',
  locationCode: 'Location code',
  type: 'Type',
  category: 'Ownership',
  phone: 'Phone',
  email: 'Email',
  city: 'City',
  state: 'State',
  address: 'Address',
  alternateAddress: 'Alternate address',
  pincode: 'Postal code',
  gstin: 'GSTIN',
  shortName: 'Short name',
  active: 'Active',
  role: 'Role',
  userType: 'User type',
  contactEmail: 'OTP email',
  otpMethod: 'OTP method',
  mfa: 'MFA',
  stores: 'Stores',
  employeeId: 'Employee ID',
  activeStore: 'Active store ID',
  storeId: 'Store ID',
  description: 'Description',
  title: 'Title',
  summary: 'Summary',
  uploader: 'Uploaded by',
  updatedAt: 'Updated at',
  sortOrder: 'Sort order',
};
function cell(value: unknown) {
  let text =
    value === null || value === undefined
      ? ''
      : Array.isArray(value)
        ? value.map(String).join(', ')
        : String(value);
  if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function exportRow(
  resource: AdministrationCollectionExportInput['resource'],
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (resource === 'stores')
    return {
      ...row,
      name: row.store_name,
      locationCode: row.location_code,
      city: row.city_name,
      state: row.state_name,
      alternateAddress: row.alt_address,
      shortName: row.short_name,
      active: row.is_active ? 'Active' : 'Archived',
    };
  if (resource === 'operators')
    return {
      ...row,
      name: [row.firstName, row.lastName].filter(Boolean).join(' '),
      stores: row.storeNames ?? row.storeIds,
      role: roles[row.role as keyof typeof roles] ?? String(row.role),
      userType: row.userType === 2 ? 'Franchise' : 'In house',
      otpMethod: row.otpMethod === 1 ? 'SMS' : 'Email',
      mfa: row.mfa ? 'Enabled' : 'Disabled',
      active: row.active ? 'Active' : 'Archived',
    };
  if (resource === 'salespeople')
    return {
      ...row,
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      employeeId: row.employee_id,
      userType: row.user_type === 2 ? 'Franchise' : 'In house',
      active: row.is_active ? 'Active' : 'Archived',
      stores: row.storeNames ?? row.storeIds,
      activeStore: row.activeStoreId,
    };
  if (resource === 'counters' || resource === 'storage')
    return {
      ...row,
      storeId: row.store,
      name: row[resource === 'counters' ? 'counter_name' : 'storage_name'],
      type: row[resource === 'counters' ? 'counter_type' : 'storage_type'],
      description: row[resource === 'counters' ? 'counter_desc' : 'storage_desc'],
      active: row.is_active ? 'Active' : 'Archived',
    };
  return { ...row, uploader: row.uploaderName, active: row.active === 1 ? 'Active' : 'Archived' };
}
export function administrationCollectionExport(config: Config, db: Databases) {
  const service = administrationService(config, db),
    guides = documentationService(config, db);
  return async (
    user: Principal,
    supplied: AdministrationCollectionExportInput,
    context?: ExportBuildContext,
  ): Promise<ExportArtifact> => {
    const input = administrationCollectionExportInputSchema.parse(supplied),
      parts: Buffer[] = [];
    let bytes = 0,
      rowCount = 0,
      after = '0';
    const append = (line: string) => {
      const part = Buffer.from(line + '\r\n', 'utf8');
      bytes += part.length;
      if (bytes > Math.min(context?.maxBytes ?? 10_000_000, 32_000_000))
        throw new AppError(422, 'EXPORT_TOO_LARGE', 'Choose fewer matching rows or columns.');
      parts.push(part);
    };
    append(input.columns.map((key) => cell(labels[key] ?? key)).join(','));
    for (;;) {
      context?.signal.throwIfAborted();
      await db
        .get('writer')
        .transaction((tx) => assertAdministrationCollectionExport(tx, user, input));
      const page = {
        after,
        limit: 500,
        search: input.search,
        active: input.active,
        sort: input.sort,
        direction: input.direction,
      };
      const result =
        input.resource === 'stores'
          ? await service.stores(user, page)
          : input.resource === 'operators'
            ? await service.operators(user, page)
            : input.resource === 'salespeople'
              ? await service.salespeople(user, page)
              : input.resource === 'counters'
                ? await service.counters(user, input.storeIds[0]!, page)
                : input.resource === 'storage'
                  ? await service.storages(user, input.storeIds[0]!, page)
                  : await guides.list(user, documentationPageQuery.parse(page));
      for (const raw of result.data) {
        if (++rowCount > 70000)
          throw new AppError(422, 'EXPORT_TOO_LARGE', 'Choose fewer matching rows.');
        const row = exportRow(input.resource, raw);
        append(input.columns.map((key) => cell(row[key])).join(','));
      }
      if (!result.nextCursor) break;
      if (result.nextCursor === after)
        throw new AppError(
          503,
          'ADMINISTRATION_EXPORT_CURSOR_INVALID',
          'The collection could not advance.',
        );
      after = result.nextCursor;
    }
    context?.signal.throwIfAborted();
    return { bytes: Buffer.concat(parts, bytes), rowCount, format: 'CSV' };
  };
}
