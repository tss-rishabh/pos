/**
 * W16: production-shaped row volume for the loopback live read-only fixture.
 *
 * The plain loopback fixture (`tools/live-readonly/seed-loopback.ts`) holds a handful of rows, so
 * every plan is trivially small and the plan gate cannot reproduce the production rejection
 * (`products` range, estimate 181,046, evidence `live-readonly-2026-11-19.json`). This adds a
 * synthetic catalog with production's size and per-store density, laid out by age like a real
 * catalog (W16 round 3):
 * - 360k `products` with interleaved ids: each configurable parent (prod_type 3) is followed by
 *   its 5 size variants (60k parents, 300k variants); a PK range from id 0 estimates ~180k rows,
 *   about half the table, as on production (181,046);
 * - age follows the id: the older half has 30% deleted products (`is_del`), the newer half 2%;
 * - 4 stores each hold 90% of the catalog (~324k `product_store` rows per store; production's
 *   `store_id` ref estimates 318,880), with 2.4% `is_avail = 0` and 1.9% `is_del = 1`;
 * - stock is where the newest catalog is: variants in the newest 20% of ids are 60% in stock,
 *   older variants almost never (1 in 20,000), parents never; ~33k in-stock rows per store, so an
 *   id-ordered walk for an in-stock page crosses ~290k old products first;
 * - a GS1 record for every other variant (~150k; production 165,308), a membership price per
 *   parent, and hold/storage rows for store 1.
 * No real data.
 * Then `ANALYZE TABLE` so EXPLAIN estimates come from statistics, as on production.
 *
 * Refuses any host other than loopback and any schema not named `pos_live_readonly_*`.
 *
 * Usage (after seed-loopback): node --import tsx tests/live-readonly/volume-fixture.ts \
 *   mysql://root@127.0.0.1:<port>/pos_live_readonly_fixture
 */
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

export const volumeShape = {
  parents: 60_000,
  variants: 300_000,
  stores: 4,
  firstId: 200_001,
} as const;

export async function addLoopbackVolume(target: string): Promise<void> {
  const url = new URL(target);
  const schema = decodeURIComponent(url.pathname.slice(1));
  if (url.protocol !== 'mysql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('The volume fixture only runs against a local MySQL server.');
  if (!/^pos_live_readonly_[a-z0-9_]{1,40}$/.test(schema))
    throw new Error('The volume fixture schema must be named pos_live_readonly_*.');
  const connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: schema,
    multipleStatements: false,
  });
  const { parents, variants, stores, firstId } = volumeShape;
  const sequence = (count: number) =>
    `with recursive n (k) as (select 1 union all select k + 1 from n where k < ${count})`;
  try {
    await connection.query("SET SESSION sql_mode = ''");
    await connection.query('SET SESSION cte_max_recursion_depth = 1000000');
    // Ids interleave as in production: a configurable parent (prod_type 3), then its 5 variants.
    const total = parents + variants,
      old = Math.floor(total * 0.8),
      storeSequence = `s (store) as (select 1 union all select store + 1 from s where store < ${stores})`;
    await connection.query(
      `insert into products (id, product, erp_product, parent_prod_id, prod_type, price, spl_price, gst, is_del, images_new)
       ${sequence(total)}
       select ${firstId - 1} + k,
              concat(if((k - 1) % 6 = 0, 'Volume parent ', 'Volume variant '), k),
              if((k - 1) % 6 = 0, concat('VOL-', k), ''),
              if((k - 1) % 6 = 0, 0, ${firstId - 1} + k - (k - 1) % 6),
              if((k - 1) % 6 = 0, 3, 1),
              if((k - 1) % 6 = 0, 999, 0), if((k - 1) % 6 = 0, 799, 0), 12,
              if(k <= ${total / 2}, k % 10 < 3, k % 50 = 0), '{}'
       from n`,
    );
    // Store s holds every product with k % 10 <> s (90%).
    await connection.query(
      `insert into product_store (product_id, store_id, stock, is_avail, is_del)
       ${sequence(total)}, ${storeSequence}
       select ${firstId - 1} + k, store,
              case when (k - 1) % 6 = 0 then 0
                   when k > ${old} then if((k * 7 + store) % 5 < 3, 1 + k % 3, 0)
                   else if(k % 20000 = 0, 1, 0) end,
              if(k % 41 = 0, 0, 1), if(k % 53 = 0, 1, 0)
       from n join s on k % 10 <> store`,
    );
    await connection.query(
      `insert into products_gs1 (product_id, gtin)
       ${sequence(total)}
       select ${firstId - 1} + k, 8900000000000 + k from n where (k - 1) % 6 <> 0 and k % 2 = 0`,
    );
    await connection.query(
      `insert into pricelist (product_id, pricelist_id, price, location_id)
       ${sequence(total)}
       select ${firstId - 1} + k, 2, 699, 0 from n where (k - 1) % 6 = 0`,
    );
    await connection.query(
      `insert into hold_stock_store (product_id, store_id, stock)
       ${sequence(total / 20)}
       select ${firstId - 1} + ${old} + k, 1, 1 from n where k % 6 <> 1`,
    );
    await connection.query(
      `insert into stock_storages (storage_id, store_id, product_id, stock)
       ${sequence(total / 20)}
       select 1, 1, ${firstId - 1} + ${old} + k, 2 from n where k % 6 <> 1`,
    );
    for (const table of [
      'products',
      'product_store',
      'products_gs1',
      'pricelist',
      'hold_stock_store',
      'stock_storages',
    ])
      await connection.query(`ANALYZE TABLE ${mysql.escapeId(table)}`);
  } finally {
    await connection.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) throw new Error('Usage: volume-fixture.ts mysql://root@127.0.0.1:<port>/<schema>');
  await addLoopbackVolume(target);
  process.stdout.write('loopback volume ready\n');
}
