// Runner-only local fixture IPC. No production startup, live provider or install.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
const [work, network, port, pattern, mode = 'confirmation'] = process.argv.slice(2);
if (!['confirmation', 'membership', 'cache'].includes(mode))
  throw new Error('Unknown native fixture mode');
if (
  !/^\/tmp\/pos-(?:import-go|csv-member|csv-cache)\.[A-Za-z0-9]+$/.test(work ?? '') ||
  !/^pos-(?:import-contract|csv-member|csv-cache)-[0-9]+$/.test(network ?? '') ||
  !/^[0-9]+$/.test(port ?? '')
)
  throw new Error('Explicit disposable import runner required');
const backend = resolve(new URL('../../..', import.meta.url).pathname);
process.chdir(backend);
const require = createRequire(resolve(backend, 'package.json'));
const mysql = require('mysql2/promise');
const { installNativeHeadFixture } = await import(
  pathToFileURL(resolve(backend, 'tests/native-head-metadata/fixture.ts'))
);
const { screeningCounterSourceCapture, initializeScreeningCounter } = await import(
  pathToFileURL(resolve(backend, 'src/modules/legacy-order-imports/screening-counter/publisher.ts'))
);
const { sealCounterPublication } = await import(
  pathToFileURL(resolve(backend, 'src/modules/legacy-order-imports/screening-counter/contracts.ts'))
);
const buildCache = process.env.POS_IMPORT_GO_BUILD_CACHE ?? resolve(work, 'build-cache');
if (buildCache !== resolve(work, 'build-cache') && !buildCache.startsWith('/tmp/pos-import-go'))
  throw new Error('Task-only build cache required');
mkdirSync(buildCache, { recursive: true });
const bridge = resolve(work, 'fixture-bridge');
mkdirSync(bridge, { mode: 0o700 });
const admin = await mysql.createConnection({
  host: '127.0.0.1',
  port: Number(port),
  user: 'root',
  database: 'pos_checkout_contract_test',
});
const sourceKey = 'isolated-go-import-source-key-'.repeat(2),
  publicationKey = 'isolated-go-import-publication-key-'.repeat(2);
let native;
let basic;
const appDSN = (url) =>
  decodeURIComponent(url.username) +
  ':' +
  decodeURIComponent(url.password) +
  '@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true&transaction_isolation=%27READ-COMMITTED%27';
async function cleanup() {
  if (mode !== 'confirmation') return;
  if (native) {
    await native.cleanup();
    native = undefined;
  }
  for (const table of [
    'pos_rewrite_screening_contributions',
    'pos_rewrite_screening_counters',
    'pos_rewrite_screening_counter_heads',
    'pos_rewrite_screening_origin_history_changes',
    'pos_rewrite_screening_origin_history_heads',
  ])
    await admin.query('DROP TABLE IF EXISTS ' + mysql.escapeId(table));
}
async function grantApplication(name) {
  const ordinary = new Set([
    'orders',
    'has_products',
    'users',
    'order_coupon_log',
    'coupons',
    'spiderman_screening_orders',
    'pos_user',
    'stores',
    'store_counters',
    'user_stores',
    'pos_rewrite_operator_auth_epochs',
    'order_stores',
    'user_eav',
    'comments',
    'product_store',
    'products',
    'referral_log',
    'tss_money_history',
    'tss_point_history',
    'reward_point_history',
    'order_tss_money',
    'order_tss_point',
    'orders_gift_voucher',
    'gift_voucher_history',
    'gift_vouchers',
    'gift_card_collection',
    'pos_rewrite_gift_card_issuances',
    'coupons_users',
    'pos_rewrite_customer_contact_revisions',
    'pos_rewrite_checkout_customer_consents',
    'pos_rewrite_checkout_projections',
    'pos_rewrite_checkout_projection_lines',
    'pos_rewrite_checkout_projection_effects',
    'pos_rewrite_cancellation_membership_provenance',
    'pos_rewrite_membership_versions',
  ]);
  const [tables] = await admin.query(
    "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'",
  );
  for (const row of tables) {
    const table = String(row.name);
    if (ordinary.has(table) || table.startsWith('pos_rewrite_import_'))
      await admin.query(
        'GRANT INSERT,UPDATE,DELETE ON ' +
          mysql.escapeId('pos_checkout_contract_test') +
          '.' +
          mysql.escapeId(table) +
          ' TO ' +
          mysql.escape(name) +
          "@'%'",
      );
  }
}
async function basicApplication() {
  if (!basic) {
    const name = 'nh_import_' + randomUUID().replaceAll('-', '').slice(0, 12),
      password = 'fixture-' + randomUUID();
    await admin.query(
      'CREATE USER ' + mysql.escape(name) + "@'%' IDENTIFIED BY " + mysql.escape(password),
    );
    await admin.query(
      'GRANT SELECT ON pos_checkout_contract_test.* TO ' + mysql.escape(name) + "@'%'",
    );
    basic = { name, password };
  }
  await grantApplication(basic.name);
  const url = new URL('mysql://root@127.0.0.1:' + port + '/pos_checkout_contract_test');
  url.username = basic.name;
  url.password = basic.password;
  return { environment: {}, dsn: appDSN(url) };
}
async function install() {
  if (mode !== 'confirmation') return basicApplication();
  if (native) throw new Error('Prior fixture was not closed');
  // No membership products are selected by this confirmation runner.
  for (const name of [
    'pos_rewrite_mem_eav_insert',
    'pos_rewrite_mem_eav_update',
    'pos_rewrite_mem_eav_delete',
    'pos_rewrite_mem_user_email',
  ])
    await admin.query('DROP TRIGGER IF EXISTS ' + mysql.escapeId(name));
  native = await installNativeHeadFixture(
    admin,
    'mysql://root@127.0.0.1:' + port + '/pos_checkout_contract_test',
    { families: ['counter'] },
  );
  // An explicit fixture-only writer allowlist. Head/projection DML remains solely
  // under the independent trigger owners and publication account.
  await grantApplication(native.names.app);
  const [customers] = await admin.query(
    'SELECT CAST(id AS CHAR) id FROM users ORDER BY id LIMIT 101',
  );
  if (customers.length > 100) throw new Error('Unexpected fixture customer count');
  for (const customer of customers) {
    const snapshot = await screeningCounterSourceCapture(
      native.sourceDb,
      sourceKey,
      Date.now,
      native.headMetadata,
    ).snapshot(String(customer.id));
    const [rows] = await admin.query(
      'SELECT CAST(s.id AS CHAR) markerId,CAST(s.order_id AS CHAR) orderId,CAST(s.has_product_id AS CHAR) lineId,CAST(IF(hp.prod_id=390238 AND o.order_status NOT IN(0,17),1,0) AS CHAR) included FROM spiderman_screening_orders s LEFT JOIN orders o ON o.id=s.order_id LEFT JOIN has_products hp ON hp.id=s.has_product_id WHERE s.user_id=? ORDER BY s.id',
      [customer.id],
    );
    const baseline = sealCounterPublication(snapshot.capture, sourceKey, publicationKey, {
      generationId: 'a'.repeat(64),
      snapshotId: snapshot.capture.snapshotId,
      sourceCaptureHash: snapshot.capture.signature,
      sourceCdcThrough: Date.now(),
      complete: true,
      rows: rows.map((row) => ({
        markerId: String(row.markerId),
        orderId: String(row.orderId),
        lineId: String(row.lineId),
        included: row.included === '1',
      })),
    });
    await initializeScreeningCounter(
      native.publisherDb,
      baseline,
      publicationKey,
      null,
      Date.now(),
      {
        headMetadata: native.headMetadata,
        configuration: snapshot.configuration,
        purpose: 'counter-publication',
      },
    );
  }
  const app = new URL(native.appUrl);
  return {
    environment: {
      ...native.environment,
      POS_SCREENING_COUNTER_CONTRACT: 'pos-screening-current-counter-v1',
      POS_SCREENING_COUNTER_PUBLICATION_KEY: publicationKey,
    },
    dsn: appDSN(app),
  };
}
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    for (const name of readdirSync(bridge).filter((n) => /^[a-f0-9]{32}\.request$/.test(n))) {
      const path = resolve(bridge, name),
        response = path.replace(/\.request$/, '.response');
      let reply;
      try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.action === 'install') reply = await install();
        else if (value.action === 'cleanup') {
          await cleanup();
          reply = {};
        } else throw new Error('Unknown fixture action');
      } catch (error) {
        process.stderr.write(
          'Native import fixture setup: ' +
            (error instanceof Error ? error.name : typeof error) +
            '\n',
        );
        reply = { error: 'reviewed native fixture setup failed' };
      }
      writeFileSync(response + '.tmp', JSON.stringify(reply), { mode: 0o600 });
      renameSync(response + '.tmp', response);
      unlinkSync(path);
    }
  } finally {
    busy = false;
  }
}, 10);
try {
  const image =
    'golang:1.25.4@sha256:698183780de28062f4ef46f82a79ec0ae69d2d22f7b160cf69f71ea8d98bf25d';
  const child =
    mode === 'confirmation'
      ? spawn(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            network,
            '-v',
            work + ':/work',
            '-v',
            'pos-rewrite-membership-go-modules:/go/pkg/mod:ro',
            '-v',
            buildCache + ':/root/.cache/go-build',
            '-w',
            '/work',
            '-e',
            'GOPROXY=off',
            '-e',
            'POS_IMPORT_NATIVE_FIXTURE_BRIDGE=/work/fixture-bridge',
            '-e',
            'POS_MEMBERSHIP_PRODUCT_IDS=[]',
            '-e',
            'POS_CHECKOUT_MYSQL_DSN=root@tcp(mysql:3306)/pos_checkout_contract_test?parseTime=true&transaction_isolation=%27READ-COMMITTED%27',
            image,
            'go',
            'test',
            '-mod=readonly',
            '-race',
            '-count=1',
            '-run',
            pattern,
            '-v',
            './internal/poscheckout',
            './internal/poscheckout/sourcefixture',
          ],
          { stdio: 'inherit' },
        )
      : spawn(
          'sh',
          [
            resolve(
              backend,
              'compatibility/upstream/legacy-order-imports',
              mode === 'membership' ? 'run-membership-tests.sh' : 'run-cache-order-tests.sh',
            ),
            '--steps',
          ],
          { stdio: 'inherit' },
        );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally {
  clearInterval(timer);
  while (busy) await new Promise((r) => setTimeout(r, 10));
  await cleanup();
  if (basic) await admin.query('DROP USER IF EXISTS ' + mysql.escape(basic.name) + "@'%'");
  await admin.end();
}
