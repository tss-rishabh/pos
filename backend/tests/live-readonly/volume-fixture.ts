/**
 * W16: production-shaped row volume for the loopback live read-only fixture.
 *
 * The plain loopback fixture (`tools/live-readonly/seed-loopback.ts`) holds a handful of rows, so
 * every plan is trivially small and the plan gate cannot reproduce the production rejection
 * (`products` range, estimate 181,046, evidence `live-readonly-2026-11-19.json`). This adds a
 * synthetic catalog of the same order of magnitude on top of that fixture: ~360k `products`
 * (60k configurable parents and 300k variants; a PK range from id 0 then estimates ~180k rows,
 * about half the table, as on production), `product_store` rows for 40 stores (~22k per store),
 * one GS1 record per variant, a membership price per parent, and hold/storage rows for store 1.
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
  stores: 40,
  firstParentId: 200_001,
  firstVariantId: 400_001,
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
  const { parents, variants, stores, firstParentId, firstVariantId } = volumeShape;
  const sequence = (count: number) =>
    `with recursive n (k) as (select 1 union all select k + 1 from n where k < ${count})`;
  try {
    await connection.query("SET SESSION sql_mode = ''");
    await connection.query('SET SESSION cte_max_recursion_depth = 1000000');
    // Configurable parents (prod_type 3) and their size variants (prod_type 1).
    await connection.query(
      `insert into products (id, product, erp_product, parent_prod_id, prod_type, price, spl_price, gst, is_del, images_new)
       ${sequence(parents)}
       select ${firstParentId - 1} + k, concat('Volume parent ', k), concat('VOL-', k), 0, 3, 999, 799, 12,
              if(k % 97 = 0, 1, 0), '{}'
       from n`,
    );
    await connection.query(
      `insert into products (id, product, erp_product, parent_prod_id, prod_type, price, spl_price, gst, is_del, images_new)
       ${sequence(variants)}
       select ${firstVariantId - 1} + k, concat('Volume variant ', k), '', ${firstParentId - 1} + 1 + ((k - 1) % ${parents}),
              1, 0, 0, 12, if(k % 50 = 0, 1, 0), '{}'
       from n`,
    );
    // Store s holds the variants with k % 16 = s % 16 (~18.75k) plus their parents at stock 0.
    await connection.query(
      `insert into product_store (product_id, store_id, stock, is_avail, is_del)
       ${sequence(variants)}, s (store) as (select 1 union all select store + 1 from s where store < ${stores})
       select ${firstVariantId - 1} + k, store, (k * 7 + store) % 5, if(k % 41 = 0, 0, 1), if(k % 53 = 0, 1, 0)
       from n join s on k % 16 = store % 16`,
    );
    await connection.query(
      `insert into product_store (product_id, store_id, stock, is_avail, is_del)
       ${sequence(parents)}, s (store) as (select 1 union all select store + 1 from s where store < ${stores})
       select ${firstParentId - 1} + k, store, 0, 1, 0
       from n join s on k % 16 = store % 16`,
    );
    await connection.query(
      `insert into products_gs1 (product_id, gtin)
       ${sequence(variants)}
       select ${firstVariantId - 1} + k, 8900000000000 + k from n`,
    );
    await connection.query(
      `insert into pricelist (product_id, pricelist_id, price, location_id)
       ${sequence(parents)}
       select ${firstParentId - 1} + k, 2, 699, 0 from n`,
    );
    await connection.query(
      `insert into hold_stock_store (product_id, store_id, stock)
       ${sequence(variants / 20)}
       select ${firstVariantId} + k * 16, 1, 1 from n`,
    );
    await connection.query(
      `insert into stock_storages (storage_id, store_id, product_id, stock)
       ${sequence(variants / 20)}
       select 1, 1, ${firstVariantId} + k * 16, 2 from n`,
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
