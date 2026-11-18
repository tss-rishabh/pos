// Run with Node's existing tsx loader from backend. No package installation.
// Args: backend root, assembled payments, task-only module cache, build cache.
// Requires an explicit disposable local CHECKOUT_MYSQL_TEST_URL and an isolated
// Docker network whose mysql alias addresses that same disposable server.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { copyFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const [backend,assembly,modules,build]=process.argv.slice(2).map(v=>resolve(v));
if(!backend||!assembly||!modules||!build)throw new Error('Explicit source and isolated caches required');
const url=new URL(process.env.CHECKOUT_MYSQL_TEST_URL??'');
const network=process.env.POS_ORIGIN_HEAD_DOCKER_NETWORK??'';
if(url.protocol!=='mysql:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username!=='root'||url.password!==''||url.pathname!=='/pos_rewrite_checkout_test'||url.search||url.hash||!/^pos-origin-[a-z0-9-]+$/.test(network))throw new Error('Explicit isolated origin fixture required');
const diagnostic=process.env.POS_ORIGIN_DIAGNOSTIC_UPSTREAM_VET_GAP==='1';
if(diagnostic)process.stderr.write('DIAGNOSTIC ONLY: upstream juspay vet remains unresolved; native poscheckout vet stays enabled.\n');
const require=createRequire(resolve(backend,'package.json'));
const mysql=require('mysql2/promise');
const {installNativeHeadFixture}=await import(pathToFileURL(resolve(backend,'tests/native-head-metadata/fixture.ts')));
process.chdir(backend);
const work=mkdtempSync(resolve(tmpdir(),'pos-origin-fullhead-'));
const here=fileURLToPath(new URL('.',import.meta.url));
cpSync(assembly,work,{recursive:true});
for(const name of ['origin_native_test.go','origin_head_metadata_native_test.go'])copyFileSync(resolve(here,name),resolve(work,'internal/poscheckout',name));
const base=['run','--rm','--network',network,'-e','GOMODCACHE=/module-cache','-e','GOCACHE=/build-cache','-e','GOPROXY=off','-v',modules+':/module-cache','-v',build+':/build-cache','-v',work+':/source:ro','-w','/source'];
const image='golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d';
function go(args,env={}){const flags=Object.entries(env).flatMap(([k,v])=>['-e',k+'='+v]);const result=spawnSync('docker',[...base,...flags,image,'go',...args],{stdio:'inherit'});if(result.status!==0)throw new Error('Native Go fixture command failed');}
let admin,f;
try {
 go(['build','-mod=readonly','./internal/poscheckout','./juspay']);
 go(['vet','-mod=readonly','./internal/poscheckout']);
 if(!diagnostic)go(['vet','-mod=readonly','./juspay']);
 admin=await mysql.createConnection({host:url.hostname,port:Number(url.port||3306),user:'root',password:decodeURIComponent(url.password)});
 await admin.query('CREATE DATABASE IF NOT EXISTS native_head_go_validation');await admin.changeUser({database:'native_head_go_validation'});
 go(['test','-mod=readonly','-count=1','-run','^TestOriginNativePrepareFullHeadSourceTables$','-v','./internal/poscheckout'],{POS_ORIGIN_PREPARE_HEAD_FIXTURE:'1'});
 f=await installNativeHeadFixture(admin,url.toString(),{families:['counter']});
 for(const n of ['origin_go_app','origin_go_unknown']){await admin.query("DROP USER IF EXISTS ?@'%'",[n]);await admin.query("CREATE USER ?@'%'",[n]);}
 await admin.query("GRANT SELECT ON native_head_go_validation.* TO 'origin_go_app'@'%'");
 await admin.query("GRANT SELECT ON sys.sys_config TO 'origin_go_app'@'%'");
 await admin.query("GRANT SHOW_ROUTINE ON *.* TO 'origin_go_app'@'%'");
 for(const n of ['history','transaction'])await admin.query("GRANT EXECUTE ON FUNCTION native_head_go_validation.pos_rewrite_origin_"+n+"_metadata TO 'origin_go_app'@'%'");
 await admin.query('CREATE TABLE IF NOT EXISTS pos_rewrite_screening_origin_payment_attempts(command_id VARCHAR(36) PRIMARY KEY,order_id BIGINT,customer_id BIGINT,phase VARCHAR(16),data JSON,proof_hash VARCHAR(64),payload MEDIUMTEXT,response MEDIUMTEXT NULL)');
 await admin.query("GRANT INSERT,UPDATE ON native_head_go_validation.pos_rewrite_screening_origin_payment_attempts TO 'origin_go_app'@'%'");
 go(['test','-mod=readonly','-race','-count=1','-run','^TestOriginNative(Head|FirstStart)','-v','./internal/poscheckout'],{...f.environment,POS_ORIGIN_PREPARED_HEAD_FIXTURE:'1',POS_ORIGIN_MYSQL_DSN:'root@tcp(mysql:3306)/native_head_go_validation?parseTime=true',POS_ORIGIN_HEAD_DSN:'origin_go_app@tcp(mysql:3306)/native_head_go_validation?parseTime=true'});
} finally {
 if(f)await f.cleanup();
 if(admin){for(const n of ['origin_go_app','origin_go_unknown'])await admin.query("DROP USER IF EXISTS ?@'%'",[n]);await admin.end();}
 rmSync(work,{recursive:true,force:true});
}
