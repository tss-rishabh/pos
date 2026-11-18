import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { cancellationMembershipRows } from './benefit-schema.js';
import { nativeMembershipFenceDefinitions } from './membership-fence-contract.js';
import {
  readNativeHeadMetadata,
  readNativeHeadMetadataOptions,
} from '../../screening-origins/native-head-metadata.js';

const unavailable = () =>
  new AppError(
    503,
    'MEMBERSHIP_NATIVE_FENCE_UNVERIFIED',
    'The native membership revision fence requires verification.',
  );
const integer = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);
function rows<T>(raw: unknown, schema: z.ZodType<T>): T[] {
  const result = z.tuple([z.array(schema).max(1000), z.unknown()]).safeParse(raw);
  if (!result.success) throw unavailable();
  return result.data[0];
}
/** Requires current user lock; preserves table MDL against fence/index removal. */
export async function assertNativeMembershipFence(tx: AdministrationTransaction): Promise<void> {
  await tx
    .select({ entity: cancellationMembershipRows.entity })
    .from(cancellationMembershipRows)
    .where(eq(cancellationMembershipRows.entity, ''))
    .limit(1)
    .for('share');
  const columns = rows(
    await tx.execute(
      sql`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,DATA_TYPE AS dataType,COLLATION_NAME AS collationName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='users' AND COLUMN_NAME='email') OR (TABLE_NAME='user_eav' AND COLUMN_NAME IN ('created_at','updated_at')))`,
    ),
    z
      .object({
        tableName: z.string(),
        columnName: z.string(),
        dataType: z.string(),
        collationName: z.string().nullable(),
      })
      .strict(),
  );
  if (
    columns.length !== 3 ||
    !columns.some(
      (row) => row.tableName === 'users' && row.collationName === 'utf8mb3_general_ci',
    ) ||
    columns.some((row) => row.tableName === 'user_eav' && row.dataType !== 'timestamp')
  )
    throw unavailable();
  const indexes = rows(
    await tx.execute(
      sql`SELECT TABLE_NAME AS tableName,INDEX_NAME AS indexName,SEQ_IN_INDEX AS ordinal,COLUMN_NAME AS columnName,SUB_PART AS prefixLength FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','user_eav') AND IS_VISIBLE='YES' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 1001`,
    ),
    z
      .object({
        tableName: z.string(),
        indexName: z.string(),
        ordinal: integer,
        columnName: z.string(),
        prefixLength: integer.nullable(),
      })
      .strict(),
  );
  const groups = new Map<string, typeof indexes>();
  for (const row of indexes) {
    const key = row.tableName + ':' + row.indexName,
      list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const supports = (table: string, names: string[]) =>
    [...groups.values()].some(
      (group) =>
        group[0]?.tableName === table &&
        names.every(
          (name, index) =>
            group[index]?.ordinal === index + 1 &&
            group[index]?.columnName === name &&
            group[index]?.prefixLength === null,
        ),
    );
  if (!supports('users', ['email']) || !supports('user_eav', ['entity', 'attribute']))
    throw unavailable();
  let triggers: Awaited<ReturnType<typeof readNativeHeadMetadata>>['membershipRevisionTriggers'];
  try {
    // This authenticates the fixed readonly routine and current writer/owner
    // policy inside this transaction; application TRIGGER authority is forbidden.
    const metadata = await readNativeHeadMetadata(tx, readNativeHeadMetadataOptions());
    triggers = metadata.membershipRevisionTriggers;
  } catch {
    throw unavailable();
  }
  if (
    triggers.length !== nativeMembershipFenceDefinitions.length ||
    nativeMembershipFenceDefinitions.some((expected) => {
      const actual = triggers.find((row) => row.name === expected.name);
      return (
        !actual ||
        actual.event !== expected.event ||
        actual.tableName !== expected.table ||
        actual.timing !== expected.timing ||
        actual.hash !== expected.hash ||
        !actual.sqlMode
          .split(',')
          .some((mode) => ['STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'].includes(mode))
      );
    })
  )
    throw unavailable();
}
