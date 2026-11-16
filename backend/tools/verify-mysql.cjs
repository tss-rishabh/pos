// Read-only metadata and bounded query comparison. Credentials arrive on hidden stdin.
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main(credentials) {
  const conn = await mysql.createConnection({
    ...credentials,
    connectTimeout: 6000,
    ssl: { ca: fs.readFileSync('/Users/rishabhbhatia/code/global-bundle.pem'), rejectUnauthorized: true },
    multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
  });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query('SET SESSION MAX_EXECUTION_TIME=5000');
    const [server] = await conn.query('SELECT VERSION() AS version, @@read_only AS read_only');
    const [dbs] = await conn.query('SHOW DATABASES');
    const schemas=[];
    for (const row of dbs) {
      const name=Object.values(row)[0];
      if (['mysql','sys','performance_schema','information_schema'].includes(name)) continue;
      const [tables]=await conn.query('SHOW TABLES FROM '+mysql.escapeId(name)+' LIKE ?', ['product_store']);
      if(tables.length) schemas.push({table_schema:name});
    }
    console.log(JSON.stringify({stage:'schema-discovery',schemas}));
    const report = { timestamp: new Date().toISOString(), connection: 'TLS verified; read-only session', server, schemas, columns: [], indexes: [], comparisons: [] };
    const output=path.join(__dirname,'../evidence/mysql-readonly.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});
    const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
    save();
    if (schemas.length === 1) {
      const schema = schemas[0].TABLE_SCHEMA ?? schemas[0].table_schema;
      const tables = ['products','product_store','products_gs1','stores','store_counters','orders','has_products','order_stores','pos_user','user_stores','pricelist','has_categories','categories','product_types','store_day_close'];
      for(const table of tables) {
        try {
          const [cols]=await conn.query('SHOW COLUMNS FROM '+mysql.escapeId(schema)+'.'+mysql.escapeId(table));
          const [indexes]=await conn.query('SHOW INDEX FROM '+mysql.escapeId(schema)+'.'+mysql.escapeId(table));
          report.columns.push(...cols.map(c=>({table_name:table,column_name:c.Field,data_type:c.Type,is_nullable:c.Null,column_key:c.Key})));
          report.indexes.push(...indexes.map(i=>({table_name:table,index_name:i.Key_name,seq_in_index:i.Seq_in_index,column_name:i.Column_name,non_unique:i.Non_unique})));
        } catch(error) { report.comparisons.push({table,error:error.code}); }
        save();
      }
      console.log(JSON.stringify({stage:'metadata-complete',column_count:report.columns.length,index_count:report.indexes.length}));
      // Identifiers are obtained from server metadata and escaped, never interpolated from client input.
      await conn.changeUser({ database: schema });
      await conn.query('SET SESSION TRANSACTION READ ONLY');
      await conn.query('SET SESSION MAX_EXECUTION_TIME=5000');
      const [stores] = await conn.query('SELECT id FROM stores WHERE is_active=1 ORDER BY id LIMIT 1');
      if (stores.length) {
        const store = stores[0].id;
        const queries = [
          ['legacy-bounded-window', 'SELECT p.id,p.product,p.price,ps.stock FROM products p JOIN product_store ps ON ps.product_id=p.id WHERE ps.store_id=? AND ps.is_del=0 AND p.product<>? AND (p.is_del=0 OR ps.stock>0) AND p.id>0 AND p.id<=10000 ORDER BY p.id LIMIT 25', [store,'']],
          ['rewrite-bounded-window','SELECT p.id,p.product,p.price,ps.stock FROM products p FORCE INDEX(PRIMARY) STRAIGHT_JOIN product_store ps FORCE INDEX(uq_product_store) ON ps.product_id=p.id AND ps.store_id=? WHERE ps.is_del=0 AND p.product<>? AND (p.is_del=0 OR ps.stock>0) AND p.id>0 AND p.id<=10000 ORDER BY p.id LIMIT 25', [store,'']],
          ['rewrite-unbounded-first-page','SELECT p.id,p.product,p.price,ps.stock FROM products p FORCE INDEX(PRIMARY) STRAIGHT_JOIN product_store ps FORCE INDEX(uq_product_store) ON ps.product_id=p.id AND ps.store_id=? WHERE ps.is_del=0 AND p.product<>? AND (p.is_del=0 OR ps.stock>0) AND p.id>0 ORDER BY p.id LIMIT 25', [store,'']],
        ];
        const values = [];
        for (const [name,sql,params] of queries) {
          const start = performance.now();
          const [plan] = await conn.execute('EXPLAIN FORMAT=JSON '+sql,params);
          try {
            const [rows] = await conn.execute(sql,params);
            values.push(rows);
            report.comparisons.push({name, elapsed_ms: Math.round((performance.now()-start)*100)/100, row_count:rows.length, plan:JSON.parse(plan[0].EXPLAIN)});
          } catch(error) {
            values.push(null);
            report.comparisons.push({name,error:error.code,plan:JSON.parse(plan[0].EXPLAIN)});
          }
          save();
        }
        report.sample_parity = values.every(v=>v!==null) && JSON.stringify(values[0])===JSON.stringify(values[1]);
        report.sample_parity = values[0]!==null && values[1]!==null && JSON.stringify(values[0])===JSON.stringify(values[1]);
        report.scope = 'First 25 rows in product-id window (0,10000], one store; not the complete legacy product datatable contract. Third query measures the unbounded first page only.';
      }
    }
    save();
    console.log(JSON.stringify({saved:output,server,schema_count:schemas.length,column_count:report.columns.length,sample_parity:report.sample_parity,scope:report.scope}));
  } finally { await conn.end(); }
}
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8'); process.stdin.resume();
let input='';
console.log('Ready for MySQL credentials on hidden stdin.');
process.stdin.on('data', async chunk => {
  input+=chunk;
  if (!input.includes('\n') && !input.includes('\r')) return;
  process.stdin.pause();
  try { const c=JSON.parse(input.trim()); input=''; await main(c); process.exitCode=0; }
  catch(error) { console.error(JSON.stringify({error:error.code??error.name,message:String(error.message).replace(/password[^\s]*/gi,'[redacted]')})); process.exitCode=1; }
  finally { if(process.stdin.isTTY) process.stdin.setRawMode(false); process.exit(process.exitCode); }
});
