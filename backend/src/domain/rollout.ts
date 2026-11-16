import { and, eq, inArray } from 'drizzle-orm';
import type { Databases } from '../db/pools.js';
import { Store } from '../db/legacy-schema.js';

export function parseStoreRollout(raw: string) {
  const parts = raw.split(',').map((value) => value.trim().toUpperCase());
  return {
    all: raw.trim().toLowerCase() === 'all',
    ids: [...new Set(parts.filter((value) => /^\d+$/.test(value)).map((value) => BigInt(value)))],
    categories: [
      ...new Set(
        parts.flatMap((value) =>
          value === 'COCO' ? ['IN_HOUSE'] : value === 'FOFO' ? ['FRANCHISE'] : [],
        ),
      ),
    ],
  };
}
type StoreExecutor = Pick<ReturnType<Databases['get']>, 'select'>;
/** Mirrors source feature_enabled; the caller chooses reader or transaction consistency. */
export async function storeRolloutEnabled(
  database: () => StoreExecutor,
  raw: string,
  role: number,
  storeId: string,
) {
  if (role === 1) return true;
  const selected = parseStoreRollout(raw);
  if (selected.all || selected.ids.includes(BigInt(storeId))) return true;
  if (!selected.categories.length) return false;
  const [store] = await database()
    .select({ id: Store.id })
    .from(Store)
    .where(
      and(
        eq(Store.id, BigInt(storeId)),
        eq(Store.is_active, true),
        eq(Store.type, 'STORE'),
        inArray(Store.category, selected.categories),
      ),
    )
    .limit(1);
  return Boolean(store);
}
