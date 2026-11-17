import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import ts from 'typescript';
const pin = '70b80159016db39a73572f80bfa87c47201c0a9f',
  path = 'new-src/api/services/vinculum/storeOrderVinc.ts';
const source = execFileSync(
  'git',
  [
    '-C',
    process.env.WHOLE_ORDER_STATUS_SYNC_SOURCE_ROOT ?? '../../backend-sync-api',
    'show',
    pin + ':' + path,
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
const selected = [
  'getInitialDelaySeconds',
  'getRetryDelaySeconds',
  'paceVinculumCall',
  'prepareStorePackShipPayload',
  'prepareDeliverPayload',
  'fireNetcoreEvents',
  'processStoreOrderVincStatus',
];
const functions = selected.map((name) => {
  const found = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!found) throw new Error('Pinned status source function is missing.');
  return found.getText(ast).replace(/^export\s+/, '');
});
let code = functions.join('\n\n');
// All identifier corrections are explicit, source-bound and tested against the original.
code = code.replaceAll('parseInt(orderId)', 'orderId').replaceAll('Number(orderId)', 'orderId');
const minimum = 'Math.min(...hasProductIds)';
if (!code.includes(minimum)) throw new Error('Pinned HP-minimum source expression changed.');
code = code.replaceAll(
  minimum,
  'hasProductIds.reduce((left, right) => BigInt(left) < BigInt(right) ? left : right)',
);
const fire = 'fireNetcoreEvents(orderId, log); // fire-and-forget';
if (!code.includes(fire)) throw new Error('Pinned Netcore call changed.');
code = code.replace(
  fire,
  'await fireNetcoreEvents(orderId, log); // bounded durable effect receipts, same payload/order',
);
const emitted = ts
  .transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ES2022,
      removeComments: false,
    },
  })
  .outputText.replace(/\nexport \{\};?\s*$/, '');
const directory = 'compatibility/upstream/whole-order-status';
mkdirSync(directory, { recursive: true });
const preamble = `// GENERATED from ${pin}:${path}\n// Original SHA256 ${createHash('sha256').update(source).digest('hex')}\n// No bootstrap, credentials, global logger or source database import is executed.\nexport function createSourceStoreRuntime(ports) {\nconst {config,getStoreOrderLocationAndRef,getProductsForPackShip,getOrderProductsForNetcore,hasAutoDeliverSuccess,clearAutoDeliverSuccess,executeVinculumJsonRequest,upsertAutoDeliverLog,enqueue,sendSlackAlert,axios} = ports;\nconst STORE_ORDER_QUEUE='store-order-vinc-pack-ship-deliver';\nconst LOG_PREFIX='Store Order :';\nconst lastVinculumCallAtByPlatform=new Map();\nconst getErrorMessage=(_error)=>'UPSTREAM_ERROR';\nconst getErrorStack=(_error)=>'';\nconst isSingleLineMembershipOrder=()=>{throw new Error('MEMBERSHIP_PROFILE_NOT_ALLOWED');};\nconst markMembershipOrderDelivered=isSingleLineMembershipOrder;\nconst prepareMembershipPackShipPayload=isSingleLineMembershipOrder;\n`;
writeFileSync(
  directory + '/pinned-source.js',
  preamble +
    emitted +
    '\nreturn {process:processStoreOrderVincStatus,packShip:prepareStorePackShipPayload,deliver:prepareDeliverPayload,initialDelay:getInitialDelaySeconds,retryDelay:getRetryDelaySeconds};\n}\n',
);
writeFileSync(
  directory + '/source-manifest.json',
  JSON.stringify(
    {
      pin,
      path,
      sourceSha256: createHash('sha256').update(source).digest('hex'),
      functions: selected,
      corrections: [
        'Lossless order ID propagation',
        'Lossless minimum HP ID selection',
        'Credential-bearing source error helpers replaced with static strings',
        'Await bounded Netcore attempts without changing the source payload or call order',
        'Dependencies injected; original bootstrap/global logger/DB are never loaded',
      ],
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(
  JSON.stringify({
    resource: 'whole-order-status-source',
    prepared: true,
    functions: selected.length,
    sourcePin: pin,
  }) + '\n',
);
