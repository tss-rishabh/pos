import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import mysql from 'mysql2/promise';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildApp } from '../../src/app.js';
import { readConfig } from '../../src/config.js';
import { createDatabases } from '../../src/db/pools.js';
import { migrationPlan } from '../../src/db/migrations.js';
import { PosUser, Store } from '../../src/db/legacy-schema.js';
import { mysqlSessions } from '../../src/auth/sessions.js';
import { seal } from '../../src/auth/crypto.js';
import { checkoutStateSchema } from '../../src/modules/checkout/contracts.js';
import { checkoutSessions } from '../../src/modules/checkout/schema.js';
import { checkInService } from '../../src/modules/administration/checkins.js';
import { verifiedMysqlFixture } from '../operational-reports/verified-mysql-fixture.js';

import { profileCheckout, profileDraft, profileDraftVersion, profileAdjustmentApi, profileInitial } from './native-workflow-contracts.js';
export { profileCheckout, profileDraft, profileDraftVersion, profileBase, profileApi, profileAdjustmentApi, profileInitial } from './native-workflow-contracts.js';
const sourceResult = z.object({
  status: z.number().int().optional(), body: z.unknown().optional(), html: z.string().optional(),
  location: z.string().nullable().optional(), exceptionType: z.string().nullable().optional(),
  queries: z.number().int().nonnegative(), nativeUpdates: z.number().int().nonnegative(),
  mro: z.record(z.string(), z.array(z.string())), sourceHashes: z.record(z.string(), z.string()),
});
const nativeValue = z.union([z.string(), z.number(), z.null()]);
const profileRow = z.object({
  id: z.union([z.string(), z.number()]).transform(String), firstname: z.string().nullable(),
  lastname: z.string().nullable(), email: z.string().nullable(), telephone: z.string().nullable(),
  birthdate: z.string().nullable(), anniversary: z.string().nullable(), gender: z.string().nullable(),
  customer_type: z.string().nullable(), gstin: z.string().nullable(),
  tss_money: nativeValue, tss_points: nativeValue, cashback: nativeValue, updated_at: z.string().nullable(),
});

/** Dialog/notification carrier only: original source content/actions remain untouched. */
const dialogCarrier = `window.console.log=function(){};window.profileSourceNotices=[];
window.toast_message=function(message){window.profileSourceNotices.push(String(message));};
$.alert=function(message){window.profileSourceNotices.push(String(message));};
$.confirm=function(options){var host=document.createElement('section');host.setAttribute('role','dialog');
var heading=document.createElement('h2');heading.textContent=options.title;host.appendChild(heading);
var content=document.createElement('div');content.innerHTML=options.content;host.appendChild(content);
Object.entries(options.buttons).forEach(function(entry){var button=document.createElement('button');
var action=entry[1];button.textContent=typeof action==='function'?entry[0]:action.text;
button.onclick=function(){var result=typeof action==='function'?action():action.action();if(result!==false)host.remove();};
host.appendChild(button);});document.body.appendChild(host);};`;

export async function nativeProfileFixture(output: string) {
  const base = new URL(process.env.CUSTOMER_PROFILE_WORKFLOW_MYSQL_URL ?? '');
  if (base.protocol !== 'mysql:' || base.hostname !== '127.0.0.1' || !base.port ||
      base.pathname !== '/pos_rewrite_profile_workflow' || base.search || base.hash)
    throw new Error('Only the owned localhost profile fixture is permitted.');
  const schema = 'pos_rewrite_profile_workflow_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const connection = await mysql.createConnection({ host: base.hostname, port: Number(base.port),
    user: decodeURIComponent(base.username), password: decodeURIComponent(base.password),
    database: base.pathname.slice(1), supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
  await connection.query(`CREATE DATABASE ${mysql.escapeId(schema)}`);
  await connection.changeUser({ database: schema });
  const physical = verifiedMysqlFixture(connection, ['evidence/mysql-customer-benefit-schema.json']);
  await physical.create(['users','pos_user','stores','store_counters','user_stores','products','product_store','products_gs1','pricelist']);
  await connection.query('CREATE UNIQUE INDEX uq_product_store ON product_store(product_id,store_id)');
  for (const id of [7,8]) {
    await physical.insert('pos_user', { id, role: 4, user_type: 1, username: `synthetic-profile-${id}`, is_active: 1, is_staff: 1 });
    await physical.insert('stores', { id: id-6, store_name: `Synthetic store ${id-6}`, location_code: `SYN${id-6}`, type: 'STORE', is_active: 1 });
    await physical.insert('store_counters', { id: id-5, store_id: id-6, counter_name: `Counter ${id-5}`, is_active: 1 });
    await physical.insert('user_stores', { django_user_id: id, store_id: id-6 });
  }
  await physical.insert('user_stores', { django_user_id: 7, store_id: 2 });
  for (const id of [777,778]) await physical.insert('users', { id, firstname: 'Synthetic', lastname: 'Guest',
    email: `profile-${id}@example.test`, telephone: '9876543210', ...profileInitial,
    status: 1, is_block: 0, is_disabled: 0, tss_money: 100.5, tss_points: 10, cashback: 7 });
  await physical.insert('products', { id: 10, product: 'Synthetic profile fixture product', parent_prod_id: 0,
    prod_type: 1, price: '125.00', spl_price: '100.00', gst: 18, is_del: 0 });
  await physical.insert('product_store', { product_id: 10, store_id: 1, stock: 10, is_del: 0, is_avail: 1 });
  for (const migration of migrationPlan()) for (const statement of migration.statements) await connection.query(statement);
  base.pathname = '/' + schema;
  let backendOrigin = '', loseResponse = false, rollbackFault = false, gstinFault = false;
  const traffic: { method: string; path: string; status: number }[] = [];
  const sourceTraffic: { path: string; fields: Record<string,string>; status: number }[] = [];
  const pendingSource = new Set<Promise<void>>();
  function source(action: 'dispatch' | 'browser', target = '', serialized = '', authenticated = true) {
    const python = process.env.CUSTOMER_PROFILE_SOURCE_PYTHON, root = process.env.CUSTOMER_PROFILE_SOURCE_ROOT;
    if (!python || !root) throw new Error('Pinned source environment is required.');
    const result = spawnSync(python, ['-B','tools/customer-profile/native-workflow-source.py'], {
      input: JSON.stringify({ url: base.href, action, target, serialized, authenticated }), encoding: 'utf8',
      timeout: 20000, maxBuffer: 1024*1024,
      env: { PATH: process.env.PATH, TZ: 'Asia/Kolkata', CUSTOMER_PROFILE_SOURCE_ROOT: root },
    });
    if (result.status !== 0) throw new Error('Native source execution failed; diagnostics omitted.');
    return sourceResult.parse(JSON.parse(result.stdout) as unknown);
  }
  const gateway = createServer(async (request,response) => {
    const target = request.url ?? '/', pathname = new URL(target,'http://127.0.0.1').pathname;
    if (pathname === '/__profile_source_jquery.js') {
      const result = spawnSync('git',['-C',process.env.CUSTOMER_PROFILE_SOURCE_ROOT ?? '', 'show',
        '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:static/adminlte/plugins/jquery/jquery.min.js'],
        { encoding:'utf8', timeout:5000, maxBuffer:512000, env:{ PATH:process.env.PATH } });
      response.writeHead(result.status===0?200:503,{'content-type':'text/javascript'});response.end(result.status===0?result.stdout:'');return;
    }
    if (pathname === '/__profile_source_dialog_carrier.js') {
      response.writeHead(200,{'content-type':'text/javascript'});response.end(dialogCarrier);return;
    }
    if (pathname === '/__profile_source__') {
      const result = source('browser');response.writeHead(200,{'content-type':'text/html'});response.end(result.html);return;
    }
    if (pathname === '/users/update-user' || pathname === '/users/ajax-update-user-data/') {
      const operation = (async()=>{
        const chunks:Buffer[]=[];let size=0;
        for await(const value of request){const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);size+=chunk.length;if(size>16000)throw new Error('Bounded source body exceeded');chunks.push(chunk);}
        const serialized=Buffer.concat(chunks).toString('utf8'), fields=new URLSearchParams(serialized);
        fields.delete('csrfmiddlewaretoken');
        const result=source('dispatch',pathname,serialized);
        sourceTraffic.push({ path:pathname, fields:Object.fromEntries(fields), status:result.status??500 });
        response.writeHead(result.status??500,{'content-type':'application/json',...(result.location?{location:result.location}:{})});response.end(JSON.stringify(result.body));
      })();pendingSource.add(operation);
      try{await operation;}catch{if(!response.destroyed){response.writeHead(503);response.end();}}finally{pendingSource.delete(operation);}return;
    }
    if (pathname.startsWith('/api/v1/')) {
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
      try{
        const upstream=await fetch(backendOrigin+target,{method:request.method,
          headers:Object.fromEntries(Object.entries(request.headers).filter(([name,value])=>name!=='host'&&name!=='connection'&&typeof value==='string').map(([name,value])=>[name,String(value)])),
          ...(chunks.length?{body:Buffer.concat(chunks)}:{})});
        const bytes=Buffer.from(await upstream.arrayBuffer());traffic.push({method:request.method??'',path:target,status:upstream.status});
        if(request.method==='POST'&&pathname===profileAdjustmentApi&&loseResponse){loseResponse=false;response.writeHead(upstream.status,{'content-type':'application/json','content-length':String(bytes.length)});response.flushHeaders();response.write(bytes.subarray(0,1),()=>response.destroy());return;}
        response.writeHead(upstream.status,Object.fromEntries(upstream.headers));response.end(bytes);
      }catch{response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{code:'SYNTHETIC_PROXY_UNAVAILABLE'}}));}return;
    }
    try{
      const file=pathname.startsWith('/assets/')?resolve(output,'.'+pathname):resolve(output,pathname==='/__profile_seed__'?'tests/customer-profile/native-workflow-seed.html':'index.html');
      if(!file.startsWith(resolve(output)+sep))throw new Error('Invalid fixture path');
      response.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});response.end(await readFile(file));
    }catch{response.writeHead(404);response.end();}
  });
  await new Promise<void>(done=>gateway.listen(0,'127.0.0.1',done));
  const address=gateway.address();if(!address||typeof address==='string')throw new Error('Fixture gateway unavailable');
  const origin=`http://127.0.0.1:${address.port}`;
  const config=readConfig({NODE_ENV:'test',DEMO_MODE:'false',WEB_ORIGIN:origin,SESSION_SECRET:'synthetic-profile-native-secret-'.repeat(3),
    MYSQL_WRITER_URL:base.href,MYSQL_PRIMARY_READER_URL:base.href,MYSQL_DATA_READER_URL:base.href,MYSQL_ALLOW_LOCAL_PLAINTEXT:'true'});
  const previousContext={contract:process.env.UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT,key:process.env.TSS_POS_CUSTOMER_CONTEXT_KEY};
  process.env.UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT='pos-customer-context-v1';
  process.env.TSS_POS_CUSTOMER_CONTEXT_KEY='synthetic-profile-context-key-'.repeat(3);
  const db=createDatabases(config),app=await buildApp(config,{logger:false});
  backendOrigin=await app.listen({host:'127.0.0.1',port:0});
  const principal={id:'7',role:4 as const,userType:1 as const,name:'Synthetic operator',email:'operator@example.test',storeIds:['1','2']};
  function initialState(customerId='777',version=1){return checkoutStateSchema.parse({
    id:profileCheckout,operatorId:'7',operatorCustomerId:'700',storeId:'1',counterId:'2',tabId:1,customerId,
    draftId:profileDraft,draftVersion:profileDraftVersion,draftImport:{lineItems:[{productId:'10',quantity:1}],completedProductIds:['10'],status:'complete'},
    verifiedCustomerUntil:null,version,phase:'quoted',cart:{products:{items:[{id:'10',product_id:'10',quantity:1,product:'Synthetic profile fixture product',price:125}] }},
    quote:{meta:{items:[]}},orderId:null,paymentConfirmation:null,salespersonId:null,lineSalespersons:{},giftCards:{},busyOperationId:null,createdAt:Date.now(),updatedAt:Date.now(),
  });}
  await db.get('writer').insert(checkoutSessions).values({id:profileCheckout,operatorId:'7',storeId:'1',version:1,state:initialState()});
  await checkInService(db,config).set(principal,'1','2');
  async function allowWrites(){if(rollbackFault){await connection.query('DROP TRIGGER profile_workflow_late_failure');rollbackFault=false;}if(gstinFault){await connection.query('ALTER TABLE users DROP CHECK profile_workflow_gstin');gstinFault=false;}}
  async function drain(){while(pendingSource.size)await Promise.allSettled([...pendingSource]);}
  return {origin,traffic,sourceTraffic,source,drain,
    async cookie(id='7'){const credential=await mysqlSessions(db).create(id,Date.now()+300000);return{name:'pos_session',value:seal({id,...credential},config.SESSION_SECRET),url:origin,httpOnly:true,sameSite:'Lax' as const};},
    loseNextCommittedResponse(){loseResponse=true;},
    async rows(){const[rows]=await connection.query('SELECT id,firstname,lastname,email,telephone,birthdate,anniversary,gender,customer_type,gstin,tss_money,tss_points,cashback,updated_at FROM users WHERE id IN(777,778) ORDER BY id');return z.array(profileRow).parse(rows);},
    async checkout(){const[row]=await db.get('writer').select().from(checkoutSessions).where(eq(checkoutSessions.id,profileCheckout));if(!row)throw new Error('Fixture checkout missing');return row;},
    async receipts(){const[rows]=await connection.query('SELECT id,checkout_version,receipt FROM pos_rewrite_customer_profile_adjustments ORDER BY id');return z.array(z.record(z.string(),z.unknown())).parse(rows);},
    async attachCustomer(customerId:string,version:number){await db.get('writer').update(checkoutSessions).set({version,state:initialState(customerId,version)}).where(eq(checkoutSessions.id,profileCheckout));},
    async archiveOperator(active:boolean){await db.get('writer').update(PosUser).set({is_active:active}).where(eq(PosUser.id,7n));},
    async archiveStore(active:boolean){await db.get('writer').update(Store).set({is_active:active}).where(eq(Store.id,1n));},
    async rejectGstin(){await connection.query("ALTER TABLE users ADD CONSTRAINT profile_workflow_gstin CHECK(gstin <> '27ERROR1234F1Z5')");gstinFault=true;},
    async rejectLateWrite(){await connection.query("CREATE TRIGGER profile_workflow_late_failure BEFORE UPDATE ON pos_rewrite_checkout_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic profile rollback'");rollbackFault=true;},allowWrites,
    async reset(){await drain();await allowWrites();await db.get('writer').update(PosUser).set({is_active:true}).where(eq(PosUser.id,7n));await db.get('writer').update(Store).set({is_active:true}).where(eq(Store.id,1n));
      await connection.execute('UPDATE users SET birthdate=?,anniversary=?,gender=?,customer_type=?,gstin=?,updated_at=? WHERE id IN(777,778)',[profileInitial.birthdate,profileInitial.anniversary,profileInitial.gender,profileInitial.customer_type,profileInitial.gstin,'2020-01-01 12:00:00']);
      await connection.query('DELETE FROM pos_rewrite_customer_profile_adjustments');await db.get('writer').update(checkoutSessions).set({version:1,state:initialState()}).where(eq(checkoutSessions.id,profileCheckout));traffic.length=0;sourceTraffic.length=0;loseResponse=false;},
    async close(){await drain();await allowWrites();await app.close();await db.close();await new Promise<void>(done=>gateway.close(()=>done()));await connection.query(`DROP DATABASE ${mysql.escapeId(schema)}`);await connection.end();
      if(previousContext.contract===undefined)delete process.env.UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT;else process.env.UPSTREAM_POS_CUSTOMER_CONTEXT_CONTRACT=previousContext.contract;
      if(previousContext.key===undefined)delete process.env.TSS_POS_CUSTOMER_CONTEXT_KEY;else process.env.TSS_POS_CUSTOMER_CONTEXT_KEY=previousContext.key;},
  };
}
