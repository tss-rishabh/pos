import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { globalVoucherHistory } from '../../global-vouchers/legacy-schema.js';

/** A ledger scan under FOR UPDATE must not lock unrelated customers' vouchers. */
export async function assertCancellationVoucherIndex(tx: AdministrationTransaction): Promise<void> {
  // Retain the table's metadata lock until commit, preventing a concurrent DROP
  // INDEX between checking capabilities and the protected ledger read.
  await tx
    .select({ id: globalVoucherHistory.id })
    .from(globalVoucherHistory)
    .where(eq(globalVoucherHistory.id, 0n))
    .limit(1)
    .for('share');
  const raw: unknown = await tx.execute(
    sql`SELECT INDEX_NAME AS indexName,COLUMN_NAME AS columnName,SEQ_IN_INDEX AS ordinal FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='gift_voucher_history' AND IS_VISIBLE='YES' ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 1001`,
  );
  const parsed = z
    .tuple([
      z
        .array(
          z
            .object({
              indexName: z.string(),
              columnName: z.string(),
              ordinal: z.number().int().positive(),
            })
            .strict(),
        )
        .max(1000),
      z.unknown(),
    ])
    .safeParse(raw);
  const indexes = new Map<string, string[]>();
  if (parsed.success)
    for (const row of parsed.data[0]) {
      const columns = indexes.get(row.indexName) ?? [];
      columns[row.ordinal - 1] = row.columnName;
      indexes.set(row.indexName, columns);
    }
  if (
    ![...indexes.values()].some(
      (columns) =>
        ((columns[0] === 'order_id' && columns[1] === 'gv_id') ||
          (columns[0] === 'gv_id' && columns[1] === 'order_id')) &&
        columns[2] === 'id',
    )
  )
    throw new AppError(
      503,
      'CANCELLATION_VOUCHER_INDEX_UNVERIFIED',
      'Voucher history needs the reviewed order index before cancellation.',
    );
}
