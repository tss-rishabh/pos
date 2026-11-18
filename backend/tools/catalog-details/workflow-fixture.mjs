// Benchmark-only fixture construction. No production schema, grants or indexes are changed.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { z } from 'zod';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.ts';

export const mysqlImage = 'mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97';
const metadataSchema = z.object({
  tables: z.record(z.string(), z.array(z.object({
    name: z.string().regex(/^\w+$/), type: z.string(), extra: z.string(), collation: z.string().nullable().optional(),
  }))),
  indexes: z.record(z.string(), z.array(z.object({
    name: z.string().regex(/^\w+$/), column: z.string().regex(/^\w+$/),
    position: z.number().int(), unique: z.boolean(),
  }))).default({}),
});
const tables = ['products', 'product_store', 'product_types', 'pricelist', 'products_gs1',
  'has_categories', 'categories', 'stores', 'tss_settings', 'pos_user', 'user_stores'];

function metadata() {
  const main = metadataSchema.parse(JSON.parse(readFileSync('evidence/mysql-schema.json', 'utf8')));
  const extra = metadataSchema.parse(JSON.parse(readFileSync('evidence/mysql-extra-schema.json', 'utf8')));
  return { tables: { ...main.tables, ...extra.tables }, indexes: { ...main.indexes, ...extra.indexes } };
}
const money = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
function categoryCombinations() {
  const result = [];
  for (let first = 1; first <= 22; first++)
    for (let second = first + 1; second <= 23; second++)
      for (let third = second + 1; third <= 24; third++) result.push([first, second, third]);
  return result;
}

export async function createWorkflowFixture(base, profile, nonce) {
  if (!['mixed', 'dense'].includes(profile) || !/^[a-f0-9]{12}$/.test(nonce))
    throw new Error('INVALID_WORKFLOW_FIXTURE_PROFILE');
  const url = new URL(base);
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.pathname !== '/pos_rewrite_catalog_workflow_test' || url.search || url.hash)
    throw new Error('EXPLICIT_LOCAL_WORKFLOW_SERVER_REQUIRED');
  const schema = 'pos_rewrite_catalog_workflow_' + randomBytes(6).toString('hex');
  const admin = await mysql.createConnection({
    host: url.hostname, port: Number(url.port), user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), supportBigNumbers: true, bigNumberStrings: true,
    dateStrings: true, multipleStatements: false,
  });
  const users = [];
  let created = false;
  const closed = async () => {
    await admin.changeUser({ database: 'mysql' });
    if (created) { await admin.query('DROP DATABASE ' + mysql.escapeId(schema)); created = false; }
    for (const name of users) await admin.query(`DROP USER IF EXISTS ${mysql.escape(name)}@'%'`);
    await admin.end();
  };
  try {
    await admin.query(`CREATE DATABASE ${mysql.escapeId(schema)} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    created = true;
    await admin.changeUser({ database: schema });
    await admin.query("SET SESSION sql_mode='STRICT_TRANS_TABLES'");
    await admin.query('SET SESSION MAX_EXECUTION_TIME=15000');
    const facts = metadata(), fixture = verifiedMysqlFixture(admin);
    await fixture.create(tables);
    const restoredIndexes = {};
    for (const table of tables) {
      const groups = new Map();
      for (const index of facts.indexes[table] ?? []) {
        if (index.name === 'PRIMARY') continue;
        const group = groups.get(index.name) ?? [];
        group.push(index); groups.set(index.name, group);
      }
      for (const [name, group] of groups) {
        group.sort((a, b) => a.position - b.position);
        await admin.query(`CREATE ${group[0].unique ? 'UNIQUE ' : ''}INDEX ${mysql.escapeId(name)} ON ${mysql.escapeId(table)}(${group.map((row) => mysql.escapeId(row.column)).join(',')})`);
      }
      restoredIndexes[table] = [...groups.keys()];
    }
    for (const file of ['migrations/0002_auth_sessions.sql', 'migrations/0006_operator_auth_epochs.sql'])
      for (const statement of readFileSync(file, 'utf8').split(';').filter((entry) => entry.trim()))
        await admin.query(statement);

    // First obtain a complete verified physical record, then batch bounded copies.
    // Auto-increment fields remain native unless every record supplies one.
    async function bulk(table, records) {
      if (!records.length) return;
      if (!tables.includes(table) || records.length > 48000) throw new Error('FIXTURE_BATCH_OUT_OF_BOUNDS');
      await fixture.insert(table, records[0]);
      const [rows] = await admin.query('SELECT * FROM ' + mysql.escapeId(table) + ' LIMIT 1');
      const template = rows[0];
      await admin.query('DELETE FROM ' + mysql.escapeId(table));
      const columns = facts.tables[table].filter((column) => !column.extra.includes('auto_increment') || records.every((row) => Object.hasOwn(row, column.name)));
      for (let start = 0; start < records.length; start += 250) {
        const values = records.slice(start, start + 250).map((row) => columns.map((column) => {
          const value = Object.hasOwn(row, column.name) ? row[column.name] : template[column.name];
          return column.type === 'json' && value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        }));
        await admin.query(`INSERT INTO ${mysql.escapeId(table)}(${columns.map((column) => mysql.escapeId(column.name)).join(',')}) VALUES ?`, [values]);
      }
    }
    await bulk('stores', Array.from({ length: 8 }, (_, index) => ({
      id: index + 1, store_name: profile === 'dense' ? `Fixture store ${index + 1}` : `Fixture store ${String(index + 1).padStart(2, '0')}`,
      location_code: `CW${index + 1}`, phone: `900000000${index + 1}`, type: 'STORE',
      category: 'IN_HOUSE', is_active: 1,
    })));
    await bulk('product_types', [{ id: 1, type: 'Simple' }, { id: 3, type: 'Configurable' }, { id: 5, type: 'Digital' }]);
    await bulk('categories', Array.from({ length: 24 }, (_, index) => ({ id: index + 1,
      category: `${profile === 'dense' ? 'Fixture category' : 'Category'} ${String(index + 1).padStart(2, '0')}` })));
    const products = [], stocks = [], memberships = [], categoryRows = [], combinations = categoryCombinations();
    let stockId = 1;
    for (let sequence = 1; sequence <= 2000; sequence++) {
      const dense = profile === 'dense';
      const parent = !dense && sequence >= 401 && sequence <= 1600 ? Math.floor((sequence - 401) / 3) + 1 : 0;
      const type = !dense && sequence <= 400 ? 3 : !dense && sequence > 1600 && sequence % 53 === 0 ? 5 : 1;
      const id = !dense && sequence === 2000 ? '9007199254740993' : String(sequence);
      const tagged = dense || sequence % 29 !== 0;
      const priced = dense || sequence % 7 !== 0;
      const priceNull = !dense && sequence % 11 === 0;
      let name = dense ? `Fixture product ${String(sequence).padStart(5, '0')}`
        : `${parent ? 'Variant' : priced && !priceNull && sequence % 4 === 1 ? 'Priced' : 'Standard'} ${tagged ? 'Tagged' : 'Unclassified'} SKU ${String(sequence).padStart(5, '0')}`;
      if (!dense && sequence > 1600 && sequence % 71 === 0) name = '';
      if (!dense && sequence === 1605) name = 'Literal %_SKU';
      if (!dense && sequence === 1606) name = 'Café precise SKU';
      const deleted = dense ? 0 : sequence <= 400 ? Number(sequence % 10 === 0)
        : parent ? Number(sequence % 9 === 0) : Number(sequence % 17 === 0);
      products.push({ id, product: name, erp_product: dense ? `ERP ${String(sequence).padStart(5, '0')}` : sequence % 17 === 0 ? null : `Own ERP ${String(sequence).padStart(5, '0')}`,
        prod_type: type, parent_prod_id: parent, is_del: deleted, price: dense ? '100.00' : money(10000 + sequence),
        spl_price: dense ? '90.00' : money(sequence % 19 === 0 ? 1 : 9000 + sequence),
        url_key: `workflow-sku-${sequence}`, images_new: '{"male":[],"female":[]}' });
      if (dense || sequence % 23 !== 0) for (let store = 1; store <= 8; store++) {
        if (!dense && store !== 1 && store !== 8 && (sequence + store) % 3 !== 0) continue;
        const stock = dense ? 3 : sequence <= 400 ? 0 : parent
          ? Number((store === 8 || (store === 1 && parent % 2 === 1)) && sequence % 5 !== 0) * 3
          : sequence % 4 === 0 ? 0 : 3;
        stocks.push({ id: stockId++, product_id: id, store_id: store, stock,
          is_avail: dense || (sequence + store) % 5 !== 0 ? 1 : 0,
          is_del: !dense && store === 2 && sequence % 7 === 0 ? 1 : 0 });
      }
      if (!parent) {
        if (tagged) {
          const choice = dense ? Array.from({ length: 24 }, (_, index) => index + 1)
            : combinations[sequence <= 400 ? sequence - 1 : 400 + sequence - 1601];
          for (const category of choice) categoryRows.push({ prod_id: id, cat_id: category });
        }
        if (priced) for (let location = 1; location <= (dense || sequence % 5 === 0 ? 2 : 1); location++)
          memberships.push({ product_id: id, pricelist_id: 2, location_id: location,
            price: dense ? '80.25' : priceNull ? null : money(3000 + sequence) });
      }
    }
    await bulk('products', products);
    await bulk('product_store', stocks);
    await bulk('has_categories', categoryRows);
    await bulk('pricelist', memberships);
    await fixture.insert('pos_user', { id: 900001, username: 'catalog-workflow-operator', first_name: 'Fixture', last_name: 'Operator',
      email: 'fixture@example.invalid', role: 1, user_type: 1, is_active: 1 });
    for (let store = 1; store <= 8; store++) await fixture.insert('user_stores', { django_user_id: 900001, store_id: store });
    await fixture.insert('tss_settings', { id: 1, platform: 'STORE_LOCATION_CODE', value: '[]' });
    for (const table of tables) await admin.query('ANALYZE TABLE ' + mysql.escapeId(table));
    const accounts = {};
    for (const label of ['source', 'service', 'api_auth', 'api_primary', 'calibration']) {
      const name = `cw_${nonce}_${label}`, password = randomBytes(24).toString('base64url');
      await admin.query(`CREATE USER ${mysql.escape(name)}@'%' IDENTIFIED BY ${mysql.escape(password)}`);
      users.push(name);
      await admin.query(`GRANT SELECT ON ${mysql.escapeId(schema)}.* TO ${mysql.escape(name)}@'%'`);
      const account = new URL(url); account.pathname = '/' + schema; account.username = name; account.password = password;
      accounts[label] = { name, url: account.href };
    }
    const adminUrl = new URL(url); adminUrl.pathname = '/' + schema;
    const collationFacts = Object.fromEntries(tables.map((table) => [table, facts.tables[table].map(({ name, type, collation }) => ({ name, type, collation: collation ?? null }))]));
    return { schema, admin, adminUrl: adminUrl.href, accounts, close: closed,
      facts: { profile, products: products.length, stores: 8, categories: 24,
        stockAssociations: stocks.length, categoryAssociations: categoryRows.length,
        membershipLocations: memberships.length, restoredIndexes, columns: collationFacts,
        schemaProjection: 'verified columns/primary/secondary indexes; no production-constraint certification' } };
  } catch (error) { await closed().catch(() => undefined); throw error; }
}
