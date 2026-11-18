/** Owned physical snapshot and real authority; never a production connection. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { readConfig } from '../../../src/config.js';
import { createDatabases } from '../../../src/db/pools.js';
import { splitMigration } from '../../../src/db/migrations.js';
import { verifiedMysqlFixture } from '../../operational-reports/verified-mysql-fixture.js';
import { identityService } from '../../../src/auth/identity.js';
import { mysqlSessions } from '../../../src/auth/sessions.js';
import { seal } from '../../../src/auth/crypto.js';
import { checkInService } from '../../../src/modules/administration/checkins.js';
import { sourceNativeRepository } from '../../../src/modules/order-history/search/native.js';
import { searchContactKeys } from '../../../src/modules/order-history/search/contacts.js';
import { orderSearchInput, type SourceSearchScope, type SourceOrder } from '../../../src/modules/order-history/search/contracts.js';
import { readOrderSearchOptions } from '../../../src/modules/order-history/search/options.js';
import { orderRange, historyHeader, historyLine, historyStore } from '../../../src/modules/order-history/contracts.js';
import { workflowViews, type NativeOrderSnapshot } from './publications.js';

export async function orderUiNativeFixture(template: string, origin: string) {
  const url = new URL(template), web = new URL(origin);
  if (url.protocol !== 'mysql:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '54777' || url.pathname !== '/pos_rewrite_order_ui_fixture' || url.search || url.hash)
    throw new Error('OWNED_ORDER_UI_DATABASE_REQUIRED');
  if (web.protocol !== 'http:' || web.hostname !== '127.0.0.1' || !web.port || web.pathname !== '/')
    throw new Error('OWNED_ORDER_UI_ORIGIN_REQUIRED');
  const schema = 'pos_rewrite_order_ui_' + randomUUID().replaceAll('-','').slice(0,12);
  const admin = await mysql.createConnection({host:url.hostname,port:Number(url.port),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),dateStrings:true,supportBigNumbers:true,bigNumberStrings:true});
  await admin.query('CREATE DATABASE '+mysql.escapeId(schema));
  await admin.changeUser({database:schema});
  url.pathname='/'+schema;
  const contactKey = 'owned-synthetic-order-comparison-key-'.repeat(2), contactKeyId='owned-order-ui-001';
  const config = readConfig({NODE_ENV:'test',DEMO_MODE:'false',WEB_ORIGIN:web.origin,
    SESSION_SECRET:'owned-synthetic-order-ui-session-'.repeat(3),MYSQL_ALLOW_LOCAL_PLAINTEXT:'true',
    MYSQL_WRITER_URL:url.href,MYSQL_PRIMARY_READER_URL:url.href,MYSQL_DATA_READER_URL:url.href,BUSINESS_TIMEZONE:'Asia/Kolkata'});
  const db = createDatabases(config);
  const fixture = verifiedMysqlFixture(admin,['evidence/mysql-order-list-collations-schema.json']);
  let identity: ReturnType<typeof identityService> | undefined;
  try {
    await fixture.create(['pos_user','user_stores','stores','store_counters','users','orders','order_stores','has_products','products','order_status','payment_status','payment_method','express_line_item','hyperlocal_order_log','hyperlocal_locations','pos_terminal_transactions','pos_paytm_transactions','pos_terminal_payment_modes','tss_settings']);
    for (const filename of ['migrations/0002_auth_sessions.sql','migrations/0003_login_challenges.sql','migrations/0006_operator_auth_epochs.sql','src/modules/administration/migration.sql','src/modules/administration/mfa-migration.sql'])
      for(const statement of splitMigration(readFileSync(filename,'utf8'))) await admin.query(statement);
    for(const id of [1,2]) {
      await fixture.insert('stores',{id,store_name:'Synthetic order store '+id,short_name:'SYN'+id,location_code:'SYN'+id,is_active:1,type:'STORE',category:'IN_HOUSE',franchise_id:0});
      await fixture.insert('store_counters',{id,store_id:id,counter_name:'Synthetic counter '+id,is_active:1});
    }
    for(const [id,role,store] of [[9,1,1],[10,4,1],[11,4,2]] as const) {
      await fixture.insert('pos_user',{id,role,user_type:1,username:'synthetic-order-operator-'+id,first_name:'Synthetic',last_name:'Operator',email:'operator'+id+'@example.invalid',is_active:1,is_staff:1});
      await fixture.insert('user_stores',{id,django_user_id:id,store_id:store});
    }
    await fixture.insert('users',{id:7,firstname:'Synthetic',lastname:'Customer',telephone:'555007',email:'customer@example.invalid'});
    await fixture.insert('products',{id:101,product:'Synthetic order item',parent_prod_id:0,prod_type:1});
    for(const [id,label] of [[1,'Order Placed'],[3,'Delivered'],[4,'Cancelled']] as const)
      await fixture.insert('order_status',{id,order_status:label,display_name:label});
    await fixture.insert('payment_status',{id:4,payment_status:'Paid'});
    await fixture.insert('payment_method',{id:14,name:'Cash'});
    const now=Date.now(), today=Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDate();
    const day=(offset:number)=>today.subtract({days:offset}).toString();
    const declarations = [
      {id:1001,type:'ST',date:day(0)+' 10:00:00',store:1},
      {id:1002,type:'ST',date:day(1)+' 10:00:00',store:1},
      {id:1003,type:'ST',date:day(5)+' 21:00:00',store:1},
      {id:1004,type:'N',date:day(1)+' 11:00:00',store:1},
      {id:1005,type:'N',date:day(0)+' 12:00:00',store:1},
      {id:1006,type:'HL',date:day(0)+' 13:00:00',store:1},
      {id:1007,type:'HE',date:day(1)+' 14:00:00',store:1},
      {id:1008,type:'ST',date:day(1)+' 15:00:00',store:2},
    ] as const;
    let associationId=1;
    for(const order of declarations) {
      await fixture.insert('orders',{id:order.id,user_id:7,order_ref_no:'SYN-ORDER-'+order.id,order_status:order.type==='HL'?1:3,payment_status:4,payment_method:14,created_at:order.date,order_amt:120,pay_amt:119,phone_no:'555007',location_id:order.type==='HL'?1:null,location_type:order.type==='HL'?'SW':'',is_global_order:0});
      if(order.type==='ST') for(let n=0;n<(order.id===1002?2:1);n++)
        await fixture.insert('order_stores',{id:associationId++,order_id:order.id,store_id:order.store,counter_id:order.store,offline_payment:order.id===1002?59.5:119,online_other_payment:0,is_manually_paid:1,is_offline_order:0,is_shopify_order:0,message:''});
      await fixture.insert('has_products',{id:order.id,order_id:order.id,prod_id:101,qty:1,price:119,gst:5,status:'PLACED'});
      if(order.type==='HE') await fixture.insert('express_line_item',{id:1,order_id:order.id,store_id:1,status:'ACCEPTED',pending_expires_at:day(0)+' 23:59:00',accepted_expires_at:day(0)+' 23:59:00'});
    }
    identity=identityService(config,db);
    const sessions=mysqlSessions(db);
    for(const id of ['9','10','11']) {
      const principal=await identity.get(id);if(!principal)throw new Error('NATIVE_ORDER_UI_IDENTITY_REQUIRED');
      await checkInService(db,config).set(principal,id==='11'?'2':'1',id==='11'?'2':'1');
    }
    async function account(id:string) {
      if(!['9','10','11'].includes(id))throw new Error('UNKNOWN_SYNTHETIC_ACTOR');
      const current=await identity!.get(id);if(!current)throw new Error('NATIVE_ORDER_UI_IDENTITY_REQUIRED');
      const credential=await sessions.create(id,Date.now()+600000);
      return {name:'pos_session',value:seal({id,...credential},config.SESSION_SECRET),url:web.origin,httpOnly:true,sameSite:'Lax' as const};
    }
    async function snapshot():Promise<NativeOrderSnapshot> {
      const options=readOrderSearchOptions({...workflowViews,ORDER_SEARCH_CONTACT_KEY:contactKey,ORDER_SEARCH_CONTACT_KEY_ID:contactKeyId});
      const repo=sourceNativeRepository(db,searchContactKeys(options));
      const range={...orderRange({from:day(5),to:day(0)},config.BUSINESS_TIMEZONE,now),reader:'primary' as const};
      const combined=new Map<string,SourceOrder>();
      for(const type of ['ST','N','HL','HE'] as const) {
        const scope:SourceSearchScope={contextStoreId:'1',checkedInStoreId:'1',allowedStores:['1','2'],selectedStores:['1','2'],internal:true,globalReader:true,explicitIds:false,binding:'owned-snapshot',effectiveType:type,heLocationLabel:type==='HE'?'SYN1 (Synthetic order store 1)':null};
        const input=orderSearchInput.parse({orderType:type,storeIds:['1','2'],from:range.from,to:range.to});
        for(const fact of await repo.currentFacts(scope,input,range,1000))combined.set(fact.id,fact);
      }
      const facts=[...combined.values()].sort((left,right)=>Number(BigInt(left.id)-BigInt(right.id)));
      const [rawHeaders]=await admin.query("SELECT CAST(o.id AS CHAR) AS id,CAST(o.user_id AS CHAR) AS customerId,o.order_ref_no AS reference,u.firstname AS first,u.lastname AS last,CAST(o.pay_amt AS CHAR) AS amount,s.display_name AS status,p.payment_status AS paymentStatus,CAST(o.payment_status AS CHAR) AS paymentStatusId,o.created_at AS createdAt FROM orders o JOIN users u ON u.id=o.user_id LEFT JOIN order_status s ON s.id=o.order_status LEFT JOIN payment_status p ON p.id=o.payment_status ORDER BY o.id");
      const headers=z.array(historyHeader).parse(z.array(z.record(z.string(),z.unknown())).parse(rawHeaders).map(row=>({...row,amount:String(Number(row.amount))})));
      const [rawStores]=await admin.query('SELECT CAST(id AS CHAR) AS id,CAST(order_id AS CHAR) AS orderId,CAST(store_id AS CHAR) AS storeId,CAST(counter_id AS CHAR) AS counterId FROM order_stores ORDER BY id');
      const stores=z.array(historyStore).parse(rawStores);
      const [rawLines]=await admin.query('SELECT CAST(h.id AS CHAR) AS id,CAST(h.order_id AS CHAR) AS orderId,CAST(h.prod_id AS CHAR) AS productId,p.product AS name,CAST(h.qty AS CHAR) AS quantity,CAST(h.price AS CHAR) AS amount,CAST(h.gst AS CHAR) AS gst,h.status FROM has_products h LEFT JOIN products p ON p.id=h.prod_id ORDER BY h.id');
      const lines=z.array(historyLine).parse(z.array(z.record(z.string(),z.unknown())).parse(rawLines).map(row=>({...row,quantity:String(Number(row.quantity)),amount:String(Number(row.amount)),gst:String(Number(row.gst))})));
      if(facts.length!==declarations.length)throw new Error('INCOMPLETE_OWNED_ORDER_SNAPSHOT');
      return {facts,headers,stores,lines};
    }
    return {schema,url:url.href,config,now,contactKey,contactKeyId,account,snapshot,
      async assigned(id:string,storeId:string,enabled:boolean) {
        if(!['10','11'].includes(id)||!['1','2'].includes(storeId))throw new Error('UNKNOWN_SYNTHETIC_ASSIGNMENT');
        if(enabled) await admin.query('INSERT INTO user_stores (django_user_id,store_id) VALUES (?,?)',[id,storeId]);
        else await admin.query('DELETE FROM user_stores WHERE django_user_id=? AND store_id=?',[id,storeId]);
      },
      async active(id:string,enabled:boolean){if(!['9','10','11'].includes(id))throw new Error('UNKNOWN_SYNTHETIC_ACTOR');await admin.query('UPDATE pos_user SET is_active=? WHERE id=?',[enabled,id]);},
      async close(){await identity?.close();await db.close();await admin.changeUser({database:'mysql'});await admin.query('DROP DATABASE '+mysql.escapeId(schema));await admin.end();},
    };
  } catch(error:unknown) {
    await identity?.close();await db.close();await admin.changeUser({database:'mysql'});await admin.query('DROP DATABASE '+mysql.escapeId(schema));await admin.end();throw error;
  }
}
