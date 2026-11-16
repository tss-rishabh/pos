import mysql from 'mysql2/promise';
import {randomUUID} from 'node:crypto';

const connection=process.env.MYSQL_INTEGRATION_URL;
if(!connection)throw new Error('Configure the isolated local MySQL integration URL.');
const url=new URL(connection);
if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('This query-plan fixture only permits local MySQL.');
const schema='pos_rewrite_explain_'+randomUUID().replaceAll('-','').slice(0,12);
let client,created=false;
try{
  client=await mysql.createConnection({host:url.hostname,port:Number(url.port||3306),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password)});
  await client.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);created=true;await client.changeUser({database:schema});
  await client.query('CREATE TABLE express_line_item(id INT PRIMARY KEY,store_id INT NOT NULL,status VARCHAR(32) NOT NULL,pending_expires_at DATETIME NULL,order_id BIGINT NOT NULL,KEY ix_fixture_expiry(store_id,status,pending_expires_at,order_id))');
  for(let offset=0;offset<20000;offset+=1000){const rows=Array.from({length:1000},(_,index)=>{const id=offset+index+1;return [id,id%10+1,'PENDING',`2026-11-${String(id%16+1).padStart(2,'0')} 12:00:00`,id];});await client.query('INSERT INTO express_line_item VALUES ?',[rows]);}
  await client.query('ANALYZE TABLE express_line_item');
  const source="SELECT DISTINCT order_id FROM express_line_item WHERE store_id=1 AND status='PENDING' AND DATE(pending_expires_at)='2026-11-15'";
  const rewritten="SELECT DISTINCT order_id FROM express_line_item WHERE store_id=1 AND status='PENDING' AND pending_expires_at>='2026-11-15 00:00:00' AND pending_expires_at<'2026-11-16 00:00:00'";
  const [before]=await client.query(source),[after]=await client.query(rewritten);
  if(before.map(row=>String(row.order_id)).sort().join(',')!==after.map(row=>String(row.order_id)).sort().join(','))throw new Error('Fixture result sets differ.');
  const plans={};for(const [name,query] of [['source',source],['rewrite',rewritten]]){const [rows]=await client.query('EXPLAIN FORMAT=JSON '+query);const plan=JSON.parse(rows[0].EXPLAIN),table=plan.query_block.table||plan.query_block.duplicates_removal?.table||plan.query_block.duplicates_removal?.nested_loop?.[0]?.table;if(!table)throw new Error('The local plan shape changed.');plans[name]={accessType:table.access_type,key:table.key,keyParts:table.used_key_parts,estimatedRows:table.rows_examined_per_scan};}
  process.stdout.write(JSON.stringify({fixtureRows:20000,equalResultRows:after.length,plans})+'\n');
}finally{if(client&&created){await client.changeUser({database:'mysql'});await client.query(`DROP DATABASE ${mysql.escapeId(schema)}`);}await client?.end();}
