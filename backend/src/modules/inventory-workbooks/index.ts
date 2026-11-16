import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { AppError } from '../../domain/errors.js';
import type { ExportBuilder } from '../operational-reports/export-service.js';
import { readInventoryWorkbookOptions, type InventoryWorkbookOptions } from './options.js';
import { readInventoryWorkbookPage } from './queries.js';
import { writeInventoryWorkbook } from './xlsx.js';
import { pruneInventoryWorkbookStaging } from './staging.js';

export { readInventoryWorkbookOptions, pruneInventoryWorkbookStaging };
export function inventoryWorkbookBuilder(
  config: Config,
  db: Databases,
  options: InventoryWorkbookOptions = readInventoryWorkbookOptions(),
): ExportBuilder {
  return async (_user, input, context) => {
    if (config.DEMO_MODE || input.kind !== 'current-inventory-workbook' || !context)
      throw new AppError(
        503,
        'INVENTORY_WORKBOOK_UNAVAILABLE',
        'Inventory workbook export requires a configured report worker.',
      );
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(options.INVENTORY_WORKBOOK_MAX_BUILD_MS),
    ]);
    await pruneInventoryWorkbookStaging(options);
    return db.get('data').transaction(
      async (tx) => {
        async function* stores() {
          for (const storeId of input.storeIds) {
            async function* pages() {
              let after = '0';
              while (true) {
                signal.throwIfAborted();
                const page = await readInventoryWorkbookPage(
                  tx,
                  storeId,
                  after,
                  options.INVENTORY_WORKBOOK_PAGE_SIZE,
                  signal,
                );
                if (!page.candidateIds.length) return;
                yield page;
                const last = page.candidateIds.at(-1)!;
                if (BigInt(last) <= BigInt(after))
                  throw new AppError(
                    503,
                    'INVENTORY_WORKBOOK_CURSOR_INVALID',
                    'Inventory pagination could not be verified.',
                  );
                after = last;
                if (page.candidateIds.length < options.INVENTORY_WORKBOOK_PAGE_SIZE) return;
              }
            }
            yield { storeId, pages: pages() };
          }
        }
        return writeInventoryWorkbook(stores(), options, context.maxBytes, signal);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  };
}
