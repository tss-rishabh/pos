// Read-only schema metadata. Credentials are accepted on hidden stdin only.
const mysql = require('mysql2/promise');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const root = path.resolve(__dirname, '..');
async function inspect(credentials) {
  const outputName = process.env.VERIFY_SCHEMA_OUTPUT_FILE;
  if (outputName && !/^mysql-[a-z0-9-]+\.json$/.test(outputName))
    throw new Error('Invalid metadata output filename');
  const input = z
    .object({
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535).optional(),
      user: z.string().min(1).max(128),
      password: z.string().max(4096),
      database: z.literal('tss').optional(),
    })
    .strict()
    .parse(credentials);
  const ca = process.env.MYSQL_TLS_CA_FILE || path.resolve(root, '../../global-bundle.pem');
  const connection = await mysql.createConnection({
    ...input,
    database: 'tss',
    connectTimeout: 6000,
    ssl: { ca: fs.readFileSync(ca), rejectUnauthorized: true },
    multipleStatements: false,
  });
  const result = {
    checkedAt: new Date().toISOString(),
    schema: 'tss',
    tables: {},
    indexes: {},
    foreignKeys: {},
    inboundForeignKeys: [],
    locations: [],
    errors: [],
  };
  const extraOnly = process.env.VERIFY_EXTRA_ONLY === 'true';
  const file = path.join(
    root,
    'evidence',
    outputName || (extraOnly ? 'mysql-extra-schema.json' : 'mysql-schema.json'),
  );
  // Publish one complete snapshot. Concurrent fixture readers must never see a
  // partially rewritten physical schema while metadata inspection is running.
  const save = () => {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    await connection.query('SET SESSION MAX_EXECUTION_TIME=5000');
    if (process.env.VERIFY_CORE_WAREHOUSE_ASSOCIATIONS_ONLY === 'true') {
      // Operational IDs/location codes and aggregate counts only. No customer,
      // staff, product, address or stock quantity rows leave this inspection.
      const [associations] = await connection.query(
        "SELECT CAST(s.id AS CHAR) AS store_id,s.location_code AS store_location_code,CAST(h.id AS CHAR) AS hyperlocal_location_id,CAST(h.store_id AS CHAR) AS hyperlocal_store_id,h.location_code AS hyperlocal_location_code,h.db_column_name,(SELECT COUNT(*) FROM product_store ps WHERE ps.store_id=s.id) AS product_store_rows FROM stores s LEFT JOIN hyperlocal_locations h ON h.store_id=s.id WHERE s.type='CORE_WAREHOUSE' AND s.is_active=1 ORDER BY s.id,h.id LIMIT 101",
      );
      if (associations.length > 100)
        throw new Error('Warehouse association result exceeds the inspection limit');
      const evidence = {
        checkedAt: new Date().toISOString(),
        activeCoreWarehousesOnly: true,
        rowDataIncluded: false,
        associations,
      };
      fs.writeFileSync(
        path.join(root, 'evidence/mysql-core-warehouse-associations.json'),
        JSON.stringify(evidence, null, 2) + '\n',
        { mode: 0o600 },
      );
      console.log(JSON.stringify({ inspectedAssociations: associations.length }));
      return;
    }
    if (process.env.VERIFY_SERVER_VARIABLES_ONLY === 'true') {
      const [rows] = await connection.query(
        'SELECT @@SESSION.sql_mode AS sql_mode,@@SESSION.time_zone AS time_zone,@@SESSION.group_concat_max_len AS group_concat_max_len,@@SESSION.transaction_read_only AS transaction_read_only,VERSION() AS version,DATABASE() AS schema_name',
      );
      const evidence = { checkedAt: new Date().toISOString(), server: rows[0] };
      fs.writeFileSync(
        path.join(root, 'evidence/mysql-server.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
      console.log(JSON.stringify(evidence));
      return;
    }
    if (process.env.VERIFY_AUTH_SCHEMA_ONLY === 'true') {
      const [tables] = await connection.query(
        "SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_NAME IN ('auth_group','auth_permission','auth_group_permissions','pos_user_groups','pos_user_user_permissions','django_content_type') AND TABLE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema') ORDER BY TABLE_SCHEMA,TABLE_NAME LIMIT 100",
      );
      const evidence = { checkedAt: new Date().toISOString(), tables };
      fs.writeFileSync(
        path.join(root, 'evidence/mysql-auth-schemas.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
      console.log(JSON.stringify({ visibleAuthTables: tables.length }));
      return;
    }
    if (process.env.VERIFY_PASSWORD_FORMATS_ONLY === 'true') {
      // The server returns fixed labels/counts only, never hashes or identifiers.
      const [formats] = await connection.query(
        "SELECT CASE WHEN password='' THEN 'empty' WHEN BINARY password LIKE '!%' THEN 'unusable' WHEN BINARY password LIKE 'pbkdf2_sha256$%' THEN 'pbkdf2_sha256' WHEN BINARY password LIKE 'pbkdf2_sha1$%' THEN 'pbkdf2_sha1' WHEN BINARY password LIKE 'argon2$%' THEN 'argon2' WHEN BINARY password LIKE 'bcrypt_sha256$%' THEN 'bcrypt_sha256' WHEN BINARY password LIKE 'bcrypt$%' THEN 'bcrypt' WHEN BINARY password LIKE 'scrypt$%' THEN 'scrypt' ELSE 'other' END AS format, COUNT(*) AS count FROM pos_user WHERE is_active=1 GROUP BY format",
      );
      const [types] = await connection.query(
        "SELECT CASE WHEN user_type=1 THEN 'internal' WHEN user_type=2 THEN 'franchise' ELSE 'other' END AS type, COUNT(*) AS count FROM pos_user WHERE is_active=1 GROUP BY type",
      );
      const evidence = {
        checkedAt: new Date().toISOString(),
        activeAccountsOnly: true,
        formats,
        types,
      };
      fs.writeFileSync(
        path.join(root, 'evidence/auth-password-formats.json'),
        JSON.stringify(evidence, null, 2) + '\n',
      );
      console.log(JSON.stringify(evidence));
      return;
    }
    if (process.env.VERIFY_PROCEDURE_ONLY === 'true') {
      const [rows] = await connection.query('SHOW CREATE PROCEDURE tss.pos_stock_syncer');
      const body = rows[0]?.['Create Procedure'];
      if (typeof body !== 'string') throw new Error('Procedure definition unavailable');
      const sanitized = body.replace(
        /CREATE\s+DEFINER\s*=\s*`[^`]+`@`[^`]+`\s+PROCEDURE/i,
        'CREATE PROCEDURE',
      );
      const directory = path.join(root, 'evidence/private/procedures');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'pos_stock_syncer.sql'), sanitized + '\n');
      console.log(
        JSON.stringify({
          procedure: 'pos_stock_syncer',
          saved: true,
          sha256: require('node:crypto').createHash('sha256').update(sanitized).digest('hex'),
        }),
      );
      return;
    }
    const models = JSON.parse(
      fs.readFileSync(path.join(root, 'parity/legacy-inventory.json'), 'utf8'),
    ).models;
    const extra = (process.env.VERIFY_EXTRA_TABLES || '').split(',').filter(Boolean);
    if (extra.some((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name)))
      throw new Error('Invalid metadata table name');
    const names = [
      ...new Set([
        ...(extraOnly ? [] : models.map((model) => model.table).filter(Boolean)),
        ...extra,
      ]),
    ];
    if (process.env.VERIFY_TABLE_LOCATIONS === 'true' && names.length > 0) {
      const [locations] = await connection.query(
        "SELECT TABLE_SCHEMA AS schema_name,TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_NAME IN (?) AND TABLE_SCHEMA NOT IN ('mysql','sys','information_schema','performance_schema') ORDER BY TABLE_SCHEMA,TABLE_NAME LIMIT 100",
        [names],
      );
      result.locations = locations;
    }
    if (process.env.VERIFY_INBOUND_FOREIGN_KEYS === 'true' && names.length > 0) {
      const [inbound] = await connection.query(
        'SELECT k.CONSTRAINT_SCHEMA AS schema_name,k.TABLE_NAME AS table_name,k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS column_name,k.ORDINAL_POSITION AS position,k.REFERENCED_TABLE_SCHEMA AS referenced_schema,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.UPDATE_RULE AS update_rule,r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.REFERENCED_TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IN (?) ORDER BY k.REFERENCED_TABLE_NAME,k.CONSTRAINT_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION LIMIT 1001',
        [names],
      );
      if (inbound.length === 1001)
        throw new Error('Inbound metadata result exceeds the inspection limit');
      result.inboundForeignKeys = inbound;
    }
    for (const name of names) {
      try {
        const [rows] = await connection.query('SHOW FULL COLUMNS FROM ' + mysql.escapeId(name));
        result.tables[name] = rows.map((row) => ({
          name: row.Field,
          type: row.Type,
          nullable: row.Null === 'YES',
          key: row.Key,
          extra: row.Extra,
          ...(row.Collation ? { collation: row.Collation } : {}),
          ...(process.env.VERIFY_INCLUDE_DEFAULTS === 'true' ? { default: row.Default } : {}),
        }));
        if (process.env.VERIFY_EXTRA_INDEXES === 'true') {
          const [indexes] = await connection.query('SHOW INDEX FROM ' + mysql.escapeId(name));
          result.indexes[name] = indexes.map((row) => ({
            name: row.Key_name,
            column: row.Column_name,
            position: row.Seq_in_index,
            unique: row.Non_unique === 0,
          }));
        }
        if (process.env.VERIFY_FOREIGN_KEYS === 'true') {
          const [foreignKeys] = await connection.query(
            'SELECT k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS column_name,k.ORDINAL_POSITION AS position,k.REFERENCED_TABLE_SCHEMA AS referenced_schema,k.REFERENCED_TABLE_NAME AS referenced_table,k.REFERENCED_COLUMN_NAME AS referenced_column,r.UPDATE_RULE AS update_rule,r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME,k.ORDINAL_POSITION',
            [name],
          );
          result.foreignKeys[name] = foreignKeys;
        }
      } catch (error) {
        result.errors.push({ table: name, code: error.code });
      }
    }
    save();
    console.log(
      JSON.stringify({
        tables: Object.keys(result.tables).length,
        errors: result.errors,
        user_stores_id: result.tables.user_stores?.find((column) => column.name === 'id'),
      }),
    );
  } finally {
    await connection.end();
  }
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
console.log('Ready for MySQL credentials on hidden stdin.');
let input = '';
process.stdin.on('data', async (chunk) => {
  input += chunk;
  if (!/[\r\n]/.test(input)) return;
  process.stdin.pause();
  try {
    const credentials = JSON.parse(input.trim());
    input = '';
    await inspect(credentials);
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ code: error.code || error.name }));
    process.exitCode = 1;
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(process.exitCode);
  }
});
