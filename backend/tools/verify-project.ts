import { execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runCheck, stopProcess, type Check, type CheckResult } from './verification/check.js';

// Run with Node 24 and tsx. Never load .env or pass live service credentials to checks.
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(backend, '..');
const flags = new Set(process.argv.slice(2));
if (
  process.versions.node.split('.')[0] !== '24' ||
  flags.size !== process.argv.length - 2 ||
  [...flags].some((flag) => !['--mysql', '--browser', '--release'].includes(flag))
) {
  process.stderr.write('Use Node 24 with optional --mysql, --browser and --release flags.\n');
  process.exit(1);
}
const childEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  CI: 'true',
  TZ: 'UTC',
  FORCE_COLOR: '0',
};
for (const name of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'COMSPEC'])
  if (process.env[name]) childEnvironment[name] = process.env[name];
// Only local source roots are forwarded, never arbitrary service environment or
// credentials. Every source consumer still validates its immutable byte pins.
for (const name of ['POS_LEGACY_IMPORT_SOURCE_ROOT', 'SCREENING_SOURCE_ROOT']) {
  const value = process.env[name];
  if (value) {
    const path = resolve(value);
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new Error('Pinned source root is unavailable.');
    childEnvironment[name] = path;
  }
}
// Reuse only an existing, caller-owned disposable runner cache. Go still runs
// every test with -count=1; this retains compilation, never successful results.
if (flags.has('--mysql') && process.env.POS_IMPORT_GO_BUILD_CACHE) {
  const cache = resolve(process.env.POS_IMPORT_GO_BUILD_CACHE);
  if (!/^\/tmp\/pos-import-go\.[A-Za-z0-9]{6,12}\/build-cache$/.test(cache))
    throw new Error('Native Go verification requires an owned disposable build cache.');
  const parent = lstatSync(dirname(cache)),
    directory = lstatSync(cache);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    typeof process.getuid !== 'function' ||
    parent.uid !== process.getuid() ||
    directory.uid !== process.getuid() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error('Native Go verification requires a private caller-owned build cache.');
  childEnvironment.POS_IMPORT_GO_BUILD_CACHE = cache;
}
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)
  childEnvironment.PLAYWRIGHT_CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
childEnvironment.WHOLE_ORDER_STATUS_ORACLE_PYTHON = resolve(
  backend,
  'tools/order-search/run-oracle.sh',
);
if (flags.has('--mysql')) {
  let url: URL;
  try {
    url = new URL(
      process.env.POS_VERIFY_MYSQL_URL || 'mysql://root@127.0.0.1/pos_rewrite_integration',
    );
  } catch {
    process.stderr.write('Verification requires a valid local fixture database URL.\n');
    process.exit(1);
  }
  if (
    url.protocol !== 'mysql:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    url.pathname !== '/pos_rewrite_integration'
  )
    throw new Error('Verification requires the explicit local fixture database URL.');
  for (const [name, schema] of Object.entries({
    MYSQL_INTEGRATION_URL: 'pos_rewrite_integration',
    AUTH_MYSQL_TEST_URL: 'pos_rewrite_auth_test',
    ADMINISTRATION_MYSQL_TEST_URL: 'pos_rewrite_administration_test',
    CHECKOUT_MYSQL_TEST_URL: 'pos_rewrite_checkout_test',
    MEMBERSHIP_HEAD_MYSQL_TEST_URL: 'pos_rewrite_checkout_test',
    ORIGIN_PREVIEW_MYSQL_TEST_URL: 'pos_rewrite_origin_preview_test',
    MIGRATION_MYSQL_TEST_URL: 'pos_rewrite_migrations_test',
    SPECIAL_PERMISSION_MYSQL_TEST_URL: 'pos_rewrite_activity_history_test',
    APPLICATION_LINK_MYSQL_TEST_URL: 'pos_rewrite_application_links_test',
    CUSTOMER_PROFILE_MYSQL_TEST_URL: 'pos_rewrite_customer_profile_test',
    CUSTOMER_CONTACT_MYSQL_TEST_URL: 'pos_rewrite_customer_contacts_test',
    CUSTOMER_OTP_MYSQL_TEST_URL: 'pos_rewrite_customer_otp_test',
    CUSTOMER_WEBSITE_HANDOFF_MYSQL_TEST_URL: 'pos_rewrite_customer_website_handoff_test',
    GLOBAL_VOUCHERS_MYSQL_TEST_URL: 'pos_rewrite_global_vouchers_test',
    LEGACY_ORDER_IMPORT_MYSQL_TEST_URL: 'pos_rewrite_legacy_order_imports_test',
    MEMBERSHIP_PUBLICATION_MYSQL_TEST_URL: 'pos_rewrite_membership_publication_test',
    INVENTORY_WORKBOOK_MYSQL_TEST_URL: 'pos_rewrite_inventory_workbooks_test',
    DASHBOARD_MYSQL_TEST_URL: 'pos_rewrite_dashboard_test',
    BARCODE_ASSIGNMENTS_MYSQL_TEST_URL: 'pos_rewrite_barcodes_test',
    ORDER_HISTORY_MYSQL_TEST_URL: 'pos_rewrite_order_history_test',
    ORDER_SEARCH_MYSQL_TEST_URL: 'pos_rewrite_order_search_test',
    PARENT_STORE_IMPORTS_MYSQL_TEST_URL: 'pos_rewrite_parent_store_test',
    MODEL_ACCOUNTS_MYSQL_TEST_URL: 'pos_rewrite_model_accounts_test',
    ECOMMERCE_SYNC_MYSQL_TEST_URL: 'pos_rewrite_integration',
    WHOLE_ORDER_STATUS_MYSQL_TEST_URL: 'pos_rewrite_whole_status_test',
    GIFT_CARD_BATCH_MYSQL_TEST_URL: 'pos_rewrite_gift_card_batches_test',
    ADMINISTRATION_HISTORY_MYSQL_TEST_URL: 'pos_rewrite_administration_history_test',
    SHORTCUT_REFERENCE_MYSQL_TEST_URL: 'pos_rewrite_shortcut_reference_test',
  })) {
    url.pathname = '/' + schema;
    childEnvironment[name] = url.href;
  }
  childEnvironment.ORDER_SEARCH_ORACLE_PYTHON = resolve(
    backend,
    'tools/order-search/run-oracle.sh',
  );
}

const directories = [
  'backend/src',
  'backend/tests',
  'backend/tools',
  'backend/migrations',
  'backend/resources',
  'backend/parity',
  'backend/compatibility',
  'frontend/src',
  'frontend/tests',
  'frontend/tools',
  'frontend/e2e',
  'frontend/electron',
  'frontend/public',
  'frontend/nginx',
  '.github/workflows',
];
const ignoredDirectories = new Set([
  'node_modules',
  'dist',
  'release',
  '__pycache__',
  '.git',
  '.venv',
  '.ruff_cache',
  '.cache',
  '.pytest_cache',
]);
function inputChecksums() {
  const files = new Set<string>();
  function addTree(path: string) {
    const absolute = resolve(workspace, path);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.env') && entry.name !== '.env.example') continue;
      const name = path + '/' + entry.name;
      if (
        entry.isDirectory() &&
        !ignoredDirectories.has(entry.name) &&
        name !== 'backend/parity/evidence'
      )
        addTree(name);
      else if (entry.isFile() && !entry.name.endsWith('.pyc')) files.add(name);
      else if (entry.isSymbolicLink())
        throw new Error('Verification inputs must be regular files.');
    }
  }
  for (const directory of directories) addTree(directory);
  // Verified physical schema and index facts are executable test/generator inputs.
  // Exclude private captures and verification outputs to avoid circular evidence.
  for (const name of [
    'mysql-schema.json',
    'mysql-extra-schema.json',
    'mysql-auth-schemas.json',
    'mysql-readonly.json',
    'mysql-admin-shipping-schema.json',
    'mysql-order-import-address-schema.json',
    'mysql-screening-schema.json',
    'mysql-import-referral-schema.json',
    'mysql-import-benefit-profile-schema.json',
    'mysql-import-coupon-country-schema.json',
    'mysql-auth-history-schema.json',
    'mysql-administration-inbound-schema.json',
    'mysql-legacy-fulfillment-schema.json',
    'mysql-global-benefits-schema.json',
    'mysql-gift-card-batches-schema.json',
    'mysql-legacy-cancellations-schema.json',
    'mysql-pending-cancellation-benefits-schema.json',
    'mysql-inventory-workbooks-schema.json',
    'mysql-order-point-cashback-schema.json',
    'mysql-core-warehouse-associations.json',
    'mysql-customer-contact-schema.json',
    'mysql-customer-benefit-schema.json',
    'mysql-product-feedback-schema.json',
    'bigquery-schema.json',
    'bigquery-source-coverage.json',
    'bigquery-parameter-validation.json',
    'bigquery-customer-history-dry-run.json',
  ]) {
    const path = 'backend/evidence/' + name;
    if (existsSync(resolve(workspace, path))) files.add(path);
  }
  for (const directory of ['', 'backend', 'frontend'])
    for (const entry of readdirSync(resolve(workspace, directory), { withFileTypes: true })) {
      if (!entry.isFile() || (entry.name.startsWith('.env') && entry.name !== '.env.example'))
        continue;
      if (
        /\.(?:json|ts|js|cjs|mjs|md|html|yaml|yml)$/.test(entry.name) ||
        ['Dockerfile', '.dockerignore', '.nvmrc', '.env.example'].includes(entry.name)
      )
        files.add(relative(workspace, resolve(workspace, directory, entry.name)));
    }
  return Object.fromEntries(
    [...files].sort().map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(resolve(workspace, name)))
        .digest('hex'),
    ]),
  );
}

function generatedEvidenceChecksums() {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    const absolute = resolve(workspace, directory);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const name = directory + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Generated evidence must use regular files.');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile())
        result[name] = createHash('sha256')
          .update(readFileSync(resolve(workspace, name)))
          .digest('hex');
    }
  }
  visit('backend/parity/evidence');
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

const checks: Check[] = [
  {
    id: 'backend-dependency-security-integrity',
    directory: 'backend',
    args: ['tools/dependency-security/verify.mjs'],
    prerequisite: true,
  },
  {
    id: 'frontend-dependency-security-integrity',
    directory: 'frontend',
    args: ['tools/dependency-security/verify.mjs'],
    prerequisite: true,
  },
  {
    id: 'dependency-security-mirrors',
    directory: 'backend',
    args: ['tools/dependency-security/sync-mirrors.mjs'],
    prerequisite: true,
  },
  {
    id: 'dependency-security-integrity-tests',
    directory: 'backend',
    args: ['--test', 'tools/dependency-security/verify.test.mjs'],
    prerequisite: true,
  },
  {
    id: 'dependency-security-pattern-regression',
    directory: 'backend',
    args: ['tools/dependency-security/review.mjs', '..'],
    timeoutMs: 3 * 60 * 1000,
    prerequisite: true,
  },
  {
    id: 'verification-process-cleanup-tests',
    directory: 'backend',
    args: ['--import', 'tsx', '--test', 'tools/verification/check.test.ts'],
    prerequisite: true,
  },
  {
    id: 'source-oracle-environments',
    directory: 'backend',
    args: ['tools/verify-fixture-environments.mjs'],
    prerequisite: true,
  },
  {
    id: 'payments-base-metadata-packaging-tests',
    directory: 'backend',
    command: 'python3',
    args: ['compatibility/upstream/test_assemble_payments.py'],
  },
  {
    id: 'backend-build',
    directory: 'backend',
    args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  },
  {
    id: 'backend-lint',
    directory: 'backend',
    args: ['node_modules/eslint/bin/eslint.js', 'src', 'tests', 'tools', 'vitest.config.ts'],
  },
  {
    id: 'source-pricing-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/source-pricing.tsconfig.json',
    ],
  },
  {
    id: 'shipping-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/fulfillment/tsconfig.shipping-tests.json',
    ],
  },
  {
    id: 'customer-profile-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/customer-insights/tsconfig.tests.json',
    ],
  },
  {
    id: 'global-benefits-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/global-benefits.tsconfig.json',
    ],
  },
  {
    id: 'customer-context-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/customer-context.tsconfig.json',
    ],
  },
  {
    id: 'google-sso-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/auth/tsconfig.sso-tests.json',
    ],
  },
  {
    id: 'gift-issuance-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/gift-issuance.tsconfig.json',
    ],
  },
  {
    id: 'global-vouchers-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/global-vouchers/tsconfig.tests.json',
    ],
  },
  {
    id: 'pending-cancellations-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/cancellations.tsconfig.json',
    ],
  },
  {
    id: 'dashboard-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/dashboard/tsconfig.tests.json',
    ],
  },
  {
    id: 'customer-website-handoff-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/customer-website-handoff/backend.tsconfig.json',
    ],
  },
  {
    id: 'fast-cash-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/fast-cash.tsconfig.json',
    ],
  },
  {
    id: 'customer-contacts-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/customer-contacts/tsconfig.tests.json',
    ],
  },
  {
    id: 'customer-otp-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/customer-otp/tsconfig.tests.json',
    ],
  },
  {
    id: 'customer-history-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/customer-history/tsconfig.tests.json',
    ],
  },
  {
    id: 'warehouse-parameters-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/warehouse/tsconfig.tests.json',
    ],
  },
  {
    id: 'product-feedback-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/product-feedback/tsconfig.tests.json',
    ],
  },
  {
    id: 'customer-consent-proof-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/customer-consent-proof.tsconfig.json',
    ],
  },
  {
    id: 'customer-verification-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/customer-verification.tsconfig.json',
    ],
  },
  {
    id: 'order-messages-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/order-messages.tsconfig.json',
    ],
  },
  {
    id: 'checkout-performance-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout-performance/tsconfig.tests.json',
    ],
  },
  {
    id: 'invoice-security-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/checkout/invoice-security.tsconfig.json',
    ],
  },
  {
    id: 'invoice-documents-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/invoice-documents/tsconfig.tests.json',
    ],
  },
  {
    id: 'legacy-delivery-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-fulfillment/tsconfig.tests.json',
    ],
  },
  {
    id: 'legacy-order-imports-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-order-imports/tsconfig.tests.json',
    ],
  },
  {
    id: 'whole-order-status-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-order-status/backend.tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-financial-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-financial/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-source-boundary-tests',
    directory: 'backend',
    command: 'sh',
    args: ['compatibility/upstream/legacy-order-imports/run-source-tests.sh'],
  },
  {
    id: 'legacy-import-preparation-core-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/legacy-import-preparation/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-preparation-source-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-preparation/tsconfig.json',
    ],
  },
  {
    id: 'public-screening-writer-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/public-screening-writer/tsconfig.json',
    ],
  },
  {
    id: 'source-runtime-acceptance-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/source-runtime-acceptance/tsconfig.json',
    ],
  },
  {
    id: 'coupon-history-publication-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-coupon-history/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-native-esm-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-esm/tsconfig.json',
    ],
  },
  {
    id: 'coupon-history-bigquery-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-coupon-history/bigquery.tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-native-esm-startup',
    directory: 'backend',
    args: ['--import', 'tsx', 'tools/legacy-import-esm/check.ts'],
  },
  {
    id: 'screening-recovery-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/screening-writer/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-coupon-go-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-coupon-go/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-tender-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-tender/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-membership-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-membership/tsconfig.json',
    ],
  },
  {
    id: 'checkin-lock-order-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/administration/tsconfig.checkin-lock-order.json',
    ],
  },
  {
    id: 'legacy-import-benefits-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-import-benefits/tsconfig.json',
    ],
  },
  {
    id: 'legacy-import-membership-publication-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-order-imports/membership-publication.tsconfig.json',
    ],
  },
  {
    id: 'import-correction-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/import-corrections/tsconfig.json',
    ],
  },
  {
    id: 'whole-order-status-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/legacy-order-status/tsconfig.json',
    ],
  },
  {
    id: 'import-order-holds-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/import-order-holds/backend.tsconfig.json',
    ],
  },
  {
    id: 'inventory-workbooks-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/inventory-workbooks/tsconfig.tests.json',
    ],
  },
  {
    id: 'legacy-order-import-history-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/legacy-order-imports/history.tsconfig.json',
    ],
  },
  {
    id: 'bigquery-tools-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/operational-reports/tsconfig.bigquery.json',
    ],
  },
  {
    id: 'gift-card-batches-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/administration/gift-card-batches.tsconfig.json',
    ],
  },
  {
    id: 'backend-tests',
    directory: 'backend',
    // Native authority audits inspect the shared account/definer universe.
    // Keep its fixtures serial; unrelated fixture DDL must not look like an
    // authority attack, or consume another fixture's setup timeout.
    args: [
      'node_modules/vitest/vitest.mjs',
      'run',
      ...(flags.has('--mysql') ? ['--maxWorkers=1', '--no-file-parallelism'] : ['--maxWorkers=4']),
    ],
    timeoutMs: flags.has('--mysql') ? 20 * 60 * 1000 : 10 * 60 * 1000,
  },
  {
    id: 'frontend-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit'],
  },
  {
    id: 'frontend-lint',
    directory: 'frontend',
    args: [
      'node_modules/eslint/bin/eslint.js',
      'src',
      'tests',
      'e2e',
      'vite.config.ts',
      'playwright.config.ts',
      'vitest.config.ts',
    ],
  },
  {
    id: 'cash-manager-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/checkout-manager/tsconfig.json',
    ],
  },
  {
    id: 'shipping-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/shipping-label/tsconfig.json',
    ],
  },
  {
    id: 'owner-cash-import-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/checkout-order-import/tsconfig.json',
    ],
  },
  {
    id: 'customer-profile-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/customer-profile/tsconfig.json',
    ],
  },
  {
    id: 'product-feedback-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/product-feedback/tsconfig.json',
    ],
  },
  {
    id: 'wallet-adjustments-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/wallet-adjustments/tsconfig.json',
    ],
  },
  {
    id: 'gift-card-batches-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/administration/tsconfig.gift-card-batches.json',
    ],
  },
  {
    id: 'frontend-tests',
    directory: 'frontend',
    // Match the native CI bound; unbounded forks can starve IndexedDB cleanup.
    args: ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=2'],
  },
  {
    id: 'fast-cash-browser-fixture-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/fast-cash/tsconfig.json'],
  },
  {
    id: 'order-payments-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/order-payments/tsconfig.json',
    ],
  },
  {
    id: 'global-vouchers-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/global-vouchers/tsconfig.json',
    ],
  },
  {
    id: 'invoice-documents-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/invoice-documents/tsconfig.json',
    ],
  },
  {
    id: 'inventory-workbooks-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/inventory-workbooks/tsconfig.tests.json',
    ],
  },
  {
    id: 'cashier-shortcuts-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/cashier-shortcuts/tsconfig.json',
    ],
  },
  {
    id: 'desktop-sso-browser-fixture-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/desktop-sso/tsconfig.json'],
  },
  {
    id: 'legacy-delivery-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/legacy-fulfillment/tsconfig.json',
    ],
  },
  {
    id: 'customer-contacts-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/customer-contacts/tsconfig.json',
    ],
  },
  {
    id: 'customer-otp-browser-fixture-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/customer-otp/tsconfig.json'],
  },
  {
    id: 'performance-browser-fixture-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/performance/tsconfig.json'],
  },
  {
    id: 'performance-review-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/performance-review/tsconfig.json',
    ],
  },
  {
    id: 'performance-runner-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/performance-runner/tsconfig.json',
    ],
  },
  {
    id: 'performance-production-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/performance-runner/tsconfig.e2e.json',
    ],
  },
  {
    id: 'frontend-build',
    directory: 'frontend',
    args: ['node_modules/vite/bin/vite.js', 'build'],
    environment: { NODE_ENV: 'production' },
  },
  {
    id: 'dashboard-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/dashboard/tsconfig.tests.json',
    ],
  },
  {
    id: 'customer-website-handoff-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/customer-website-handoff.tsconfig.json',
    ],
  },
  {
    id: 'offline-worksheet-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/offline-worksheet/tsconfig.json',
    ],
  },
  {
    id: 'barcode-assignments-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/administration/barcodes/tsconfig.tests.json',
    ],
  },
  {
    id: 'barcode-assignments-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/administration/barcodes/tsconfig.tests.json',
    ],
  },
  {
    id: 'order-copy-fixture-typecheck',
    directory: 'backend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tools/order-copy/tsconfig.json'],
  },
  {
    id: 'order-search-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/order-search/backend.tsconfig.json',
    ],
  },
  {
    id: 'order-search-browser-fixture-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/order-search/tsconfig.json'],
  },
  {
    id: 'payment-reversals-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/payment-reversals/tsconfig.json',
    ],
  },
  {
    id: 'payment-reversals-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/payment-reversals/tsconfig.json',
    ],
  },
  {
    id: 'payment-correction-finance-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/payment-correction-finance/tsconfig.json',
    ],
  },
  {
    id: 'ecommerce-sync-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/administration/ecommerce-sync/tsconfig.tests.json',
    ],
  },
  {
    id: 'ecommerce-sync-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/administration/ecommerce-sync/tsconfig.tests.json',
    ],
  },
  {
    id: 'legacy-order-import-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/order-imports/tsconfig.json',
    ],
  },
  {
    id: 'model-accounts-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/administration/model-accounts/tsconfig.tests.json',
    ],
  },
  {
    id: 'model-accounts-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/administration/model-accounts/tsconfig.tests.json',
    ],
  },
  {
    id: 'parent-store-import-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/administration/parent-store-imports/tsconfig.tests.json',
    ],
  },
  {
    id: 'parent-store-import-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/administration/parent-store-imports/tsconfig.tests.json',
    ],
  },
  {
    id: 'order-history-fixture-typecheck',
    directory: 'backend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tools/order-history/backend.tsconfig.json',
    ],
  },
  {
    id: 'order-copy-browser-fixture-typecheck',
    directory: 'frontend',
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tests/order-copy/tsconfig.json'],
  },
  {
    id: 'order-history-browser-fixture-typecheck',
    directory: 'frontend',
    args: [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '-p',
      'tests/order-history/tsconfig.json',
    ],
  },
];
for (const [id, directory, config] of [
  ['backend-vitest-config-typecheck', 'backend', 'tsconfig.vitest.json'],
  ['lookup-workflow-backend-typecheck', 'backend', 'tools/lookup-workflow/backend.tsconfig.json'],
  ['lookup-workflow-browser-typecheck', 'frontend', 'tests/lookup-workflow/tsconfig.json'],
  [
    'customer-profile-native-workflow-typecheck',
    'backend',
    'tools/customer-profile/native-workflow.tsconfig.json',
  ],
  [
    'customer-profile-native-browser-typecheck',
    'frontend',
    'tests/customer-profile/native-workflow.tsconfig.json',
  ],
  [
    'feedback-native-workflow-typecheck',
    'backend',
    'tools/product-feedback/native-workflow.tsconfig.json',
  ],
  [
    'shortcut-joined-workflow-typecheck',
    'frontend',
    'tools/cashier-shortcuts/tsconfig.joined.json',
  ],
] as const)
  checks.push({
    id,
    directory,
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', config],
  });
if (flags.has('--mysql')) {
  checks.push(
    {
      id: 'legacy-import-confirmation-native-tests',
      directory: 'backend',
      command: 'sh',
      args: ['compatibility/upstream/legacy-order-imports/run-go-tests.sh'],
    },
    {
      id: 'legacy-import-corrected-source-go-tests',
      directory: 'backend',
      command: 'sh',
      args: ['compatibility/upstream/legacy-order-imports/run-correction-tests.sh'],
    },
    {
      id: 'legacy-import-benefits-native-tests',
      directory: 'backend',
      command: 'sh',
      args: ['compatibility/upstream/legacy-order-imports/benefit-profile/run-native-tests.sh'],
    },
    {
      id: 'legacy-import-benefits-composed-source-native-tests',
      directory: 'backend',
      command: 'sh',
      args: ['tools/legacy-import-benefits/run-source-tests.sh'],
    },
    {
      id: 'legacy-import-coupon-consumption-native-tests',
      directory: 'backend',
      command: 'sh',
      args: [
        'compatibility/upstream/legacy-order-imports/run-coupon-tests.sh',
        'tests/legacy-import-benefits/consumed-recovery.mysql.test.ts',
      ],
    },
    {
      id: 'public-screening-writer-native-tests',
      directory: 'backend',
      command: 'sh',
      args: ['compatibility/upstream/public-screening-writer/run-native-tests.sh'],
    },
    {
      id: 'membership-native-producer-tests',
      directory: 'backend',
      command: 'sh',
      args: ['compatibility/upstream/pending-cancellation/run-membership-native.sh'],
    },
    {
      id: 'customer-website-receiver-tests',
      directory: 'backend',
      args: ['tools/customer-website-handoff/check-receiver.mjs'],
    },
  );
}
if (flags.has('--browser')) {
  if (flags.has('--mysql')) {
    const source = resolve(workspace, '../backend-pos-web');
    checks.push(
      {
        id: 'lookup-native-source-api-browser-workflow',
        directory: 'backend',
        command: 'sh',
        args: ['tools/lookup-workflow/run.sh'],
        environment: { LOOKUP_WORKFLOW_SOURCE_ROOT: source },
      },
      {
        id: 'feedback-native-source-api-browser-workflow',
        directory: 'backend',
        command: 'sh',
        args: ['tools/product-feedback/run-native-workflow.sh'],
        environment: { PRODUCT_FEEDBACK_SOURCE_ROOT: source },
      },
      {
        id: 'customer-profile-native-source-api-browser-workflow',
        directory: 'backend',
        command: 'sh',
        args: ['tools/customer-profile/native-workflow-run.sh'],
        environment: { CUSTOMER_PROFILE_SOURCE_ROOT: source },
      },
      {
        id: 'shortcut-native-source-api-browser-workflow',
        directory: 'backend',
        command: 'sh',
        args: ['tools/cashier-shortcuts/run-joined.sh', source, '--native-reference'],
      },
    );
  }
  checks.push({
    id: 'daily-reports-browser-tests',
    directory: 'frontend',
    args: ['tools/run-browser-fixture.mjs', 'daily-reports'],
  });
  checks.push({
    id: 'report-columns-browser-tests',
    directory: 'frontend',
    args: [
      '--import',
      '../backend/node_modules/tsx/dist/loader.mjs',
      'tools/run-browser-fixture.mjs',
      'report-columns',
    ],
  });
  checks.push({
    id: 'order-search-browser-tests',
    directory: 'frontend',
    args: ['tests/order-search/browser-check.mjs'],
  });
  checks.push({
    id: 'payment-reversals-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/payment-reversals/browser.test.ts'],
    environment: { PAYMENT_REVERSAL_BROWSER_TESTS: 'true' },
  });
  checks.push(
    {
      id: 'whole-order-status-browser-tests',
      directory: 'frontend',
      args: ['tests/legacy-order-status/browser-check.mjs'],
    },
    {
      id: 'rejected-return-repair-browser-tests',
      directory: 'frontend',
      args: ['tests/legacy-order-status/repair-browser-check.mjs'],
    },
    {
      id: 'legacy-order-import-browser-tests',
      directory: 'frontend',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'tests/order-imports/vitest.config.ts',
      ],
      environment: { ORDER_IMPORT_BROWSER_TESTS: 'true' },
    },
    {
      id: 'import-correction-browser-tests',
      directory: 'frontend',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/import-corrections/browser.test.ts',
        '--maxWorkers=1',
      ],
      environment: { ORDER_IMPORT_BROWSER_TESTS: 'true' },
    },
    {
      id: 'order-copy-browser-tests',
      directory: 'frontend',
      args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/order-copy', '--maxWorkers=1'],
      environment: { ORDER_COPY_BROWSER_TESTS: 'true' },
    },
    {
      id: 'order-history-browser-tests',
      directory: 'frontend',
      args: ['tests/order-history/browser-check.mjs'],
    },
  );
  checks.push({
    id: 'offline-worksheet-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/offline-worksheet/browser.test.ts'],
    environment: { OFFLINE_WORKSHEET_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'global-vouchers-browser-tests',
    directory: 'frontend',
    args: [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/global-vouchers/vouchers.browser.test.ts',
    ],
    environment: { ADMINISTRATION_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'order-payments-browser-tests',
    directory: 'frontend',
    args: [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/order-payments/order-payments.browser.test.ts',
    ],
    environment: { ADMINISTRATION_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'screening-recovery-browser-tests',
    directory: 'frontend',
    args: [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/screening-writer/recovery.browser.test.ts',
      '--maxWorkers=1',
    ],
    environment: { ADMINISTRATION_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'product-feedback-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/product-feedback/browser.test.ts'],
    environment: { PRODUCT_FEEDBACK_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'desktop-sso-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/desktop-sso/browser.test.ts'],
    environment: { DESKTOP_SSO_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'customer-profile-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/customer-profile/browser.test.ts'],
    environment: { CUSTOMER_PROFILE_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'cash-manager-browser-tests',
    directory: 'frontend',
    args: ['tools/run-browser-fixture.mjs', 'cash-manager'],
  });
  checks.push({
    id: 'shipping-label-browser-tests',
    directory: 'frontend',
    args: ['tools/run-browser-fixture.mjs', 'shipping-label'],
  });
  checks.push({
    id: 'invoice-documents-browser-tests',
    directory: 'frontend',
    args: ['tools/run-browser-fixture.mjs', 'invoice-documents'],
  });
  checks.push({
    id: 'administration-browser-tests',
    directory: 'frontend',
    args: [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/administration/workflows.test.ts',
      'tests/administration/history.browser.test.ts',
      'tests/administration/group-bulk.browser.test.ts',
      'tests/administration/gift-card-batches.browser.test.ts',
      'tests/customer-contacts/contacts.browser.test.ts',
      'tests/customer-otp/otp.browser.test.ts',
      'tests/inventory-workbooks/browser.test.ts',
      'tests/dashboard/browser.test.ts',
      'tests/administration/barcodes/browser.test.ts',
      'tests/administration/parent-store-imports/browser.test.ts',
      'tests/administration/model-accounts/browser.test.ts',
      '--maxWorkers=1',
    ],
    environment: { ADMINISTRATION_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'legacy-delivery-browser-tests',
    directory: 'frontend',
    args: ['tools/run-browser-fixture.mjs', 'legacy-delivery'],
  });
  checks.push({
    id: 'legacy-delivery-lifecycle-browser-tests',
    directory: 'frontend',
    args: ['tools/run-browser-fixture.mjs', 'legacy-delivery-lifecycle'],
  });
  checks.push({
    id: 'browser-tests',
    directory: 'frontend',
    args: ['node_modules/@playwright/test/cli.js', 'test'],
  });
}

mkdirSync(resolve(backend, 'evidence/private'), { recursive: true });
const checksums = inputChecksums();
const inventory = z
  .object({ source_commit: z.string().regex(/^[a-f0-9]{40}$/) })
  .parse(
    JSON.parse(readFileSync(resolve(backend, 'parity/legacy-inventory.json'), 'utf8')) as unknown,
  );
function sourceBaseline() {
  const source = resolve(workspace, '../backend-pos-web');
  try {
    const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync(
      'git',
      ['-C', source, 'status', '--porcelain', '--untracked-files=no'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return { commit, clean: status.length === 0 };
  } catch {
    throw new Error('The pinned local source checkout is required for parity verification.');
  }
}
const sourceBefore = sourceBaseline();
if (sourceBefore.commit !== inventory.source_commit || !sourceBefore.clean)
  throw new Error('Parity verification requires the clean pinned source checkout.');
function rewriteCommit() {
  return z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(
      execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
}
const rewriteBefore = rewriteCommit();
const activeProcesses = new Set<ChildProcess>();
let stopped = false;
function stopActive(signal: NodeJS.Signals) {
  for (const child of activeProcesses) stopProcess(child, signal);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopped = true;
    stopActive(signal);
  });
function run(check: Check): Promise<CheckResult> {
  return runCheck(check, { workspace, environment: childEnvironment, activeProcesses });
}
const results: CheckResult[] = [];
const isReadOnlyTypecheck = (check: Check) =>
  !check.command &&
  check.args[0] === 'node_modules/typescript/bin/tsc' &&
  check.args.includes('--noEmit');
const typecheckResults = new Map<string, CheckResult>();
let typechecksPrepared = false;
async function prepareTypechecks() {
  const pending = checks.filter(isReadOnlyTypecheck);
  let cursor = 0;
  // Only no-emit compiler checks run together. Builds, migrations, databases,
  // browsers and their dependencies retain their original sequential order.
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (!stopped) {
        const check = pending[cursor++];
        if (!check) return;
        typecheckResults.set(check.id, await run(check));
      }
    }),
  );
  typechecksPrepared = true;
}
for (const check of checks) {
  if (stopped) break;
  if (check.id === 'browser-tests' && results.some((result) => result.exitCode !== 0)) break;
  let result: CheckResult;
  if (isReadOnlyTypecheck(check)) {
    if (!typechecksPrepared) await prepareTypechecks();
    if (stopped) break;
    const prepared = typecheckResults.get(check.id);
    if (!prepared) throw new Error('A required compiler check was not recorded.');
    result = prepared;
  } else result = await run(check);
  results.push(result);
  // Refuse toolchain execution when reviewed dependency integrity is absent.
  if (check.prerequisite && result.exitCode !== 0) break;
}
// Compiler preparation can finish many checks before the sequential loop
// consumes them. Retain those actual results even if a signal interrupts the
// preparation; they must not be reported as unexecuted or silently discarded.
const recordedIds = new Set(results.map((result) => result.id));
for (const check of checks) {
  const prepared = typecheckResults.get(check.id);
  if (prepared && !recordedIds.has(check.id)) results.push(prepared);
}
const gate = await run({
  id: 'release-gate',
  directory: 'backend',
  args: ['--import', 'tsx', 'tools/parity-gate.ts'],
});
const after = inputChecksums();
const sourceAfter = sourceBaseline();
const sourceChanged = sourceAfter.commit !== sourceBefore.commit || !sourceAfter.clean;
const rewriteAfter = rewriteCommit();
const rewriteChanged = rewriteBefore !== rewriteAfter;
const completedIds = new Set(results.map((result) => result.id));
const unexecutedChecks = checks
  .filter((check) => !completedIds.has(check.id))
  .map((check) => check.id);
const changedInputs = [...new Set([...Object.keys(checksums), ...Object.keys(after)])].filter(
  (name) => checksums[name] !== after[name],
);
const exitCode =
  stopped ||
  results.length !== checks.length ||
  results.some((check) => check.exitCode !== 0) ||
  sourceChanged ||
  rewriteChanged ||
  changedInputs.length ||
  (flags.has('--release') && gate.exitCode !== 0)
    ? 1
    : 0;
const report = {
  version: 1,
  sourceCommit: inventory.source_commit,
  sourceBaseline: { before: sourceBefore, after: sourceAfter, changed: sourceChanged },
  rewriteBaseline: { before: rewriteBefore, after: rewriteAfter, changed: rewriteChanged },
  recordedAt: new Date().toISOString(),
  command: `node --import tsx tools/verify-project.ts${[...flags].map((flag) => ' ' + flag).join('')}`,
  exitCode,
  nodeVersion: process.versions.node,
  scope: {
    localMySql: flags.has('--mysql'),
    browser: flags.has('--browser'),
    taskGoBuildCache: Boolean(childEnvironment.POS_IMPORT_GO_BUILD_CACHE),
  },
  productionReady: gate.exitCode === 0 && exitCode === 0,
  interrupted: stopped,
  expectedChecks: checks.length,
  completedChecks: results.length,
  unexecutedChecks,
  checks: results,
  releaseGate: gate,
  changedInputs,
  checksums,
  generatedEvidenceChecksums: generatedEvidenceChecksums(),
};
writeFileSync(
  resolve(backend, 'evidence/verification.json'),
  JSON.stringify(report, null, 2) + '\n',
);
process.stdout.write(
  JSON.stringify({
    eventId: 'verification.project.completed',
    exitCode,
    productionReady: report.productionReady,
    rewriteCommit: rewriteAfter,
    completedChecks: results.length,
    expectedChecks: checks.length,
    unexecutedChecks,
    changedInputs: changedInputs.length,
    evidence: 'backend/evidence/verification.json',
  }) + '\n',
);
process.exitCode = exitCode;
