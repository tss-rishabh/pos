import { execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)
  childEnvironment.PLAYWRIGHT_CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
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
    ADMINISTRATION_CREATOR_MYSQL_URL: 'pos_rewrite_creator_authority_test',
    STORE_DEFAULT_OPERATORS_MYSQL_URL: 'pos_rewrite_store_defaults_test',
    CHECKOUT_MYSQL_TEST_URL: 'pos_rewrite_checkout_test',
    SPECIAL_PERMISSION_MYSQL_TEST_URL: 'pos_rewrite_activity_history_test',
    APPLICATION_LINK_MYSQL_TEST_URL: 'pos_rewrite_application_links_test',
    CUSTOMER_PROFILE_MYSQL_TEST_URL: 'pos_rewrite_customer_profile_test',
    CUSTOMER_CONTACT_MYSQL_TEST_URL: 'pos_rewrite_customer_contacts_test',
    CUSTOMER_OTP_MYSQL_TEST_URL: 'pos_rewrite_customer_otp_test',
    CUSTOMER_WEBSITE_HANDOFF_MYSQL_TEST_URL: 'pos_rewrite_customer_website_handoff_test',
    GLOBAL_VOUCHERS_MYSQL_TEST_URL: 'pos_rewrite_global_vouchers_test',
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
    const fixtureUrl = new URL(url);
    if (
      name === 'ADMINISTRATION_CREATOR_MYSQL_URL' ||
      name === 'STORE_DEFAULT_OPERATORS_MYSQL_URL'
    ) {
      if (fixtureUrl.hostname === 'localhost') fixtureUrl.hostname = '127.0.0.1';
      fixtureUrl.port ||= '3306';
    }
    childEnvironment[name] = fixtureUrl.href;
  }
  childEnvironment.ORDER_SEARCH_SOURCE_ROOT = resolve(workspace, '../backend-pos-web');
}

const directories = [
  'backend/src',
  'backend/tests',
  'backend/tools',
  'backend/resources',
  'backend/parity',
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
] as const)
  checks.push({
    id,
    directory,
    args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', config],
  });
if (flags.has('--browser')) {
  if (flags.has('--mysql')) {
    checks.push({
      id: 'online-order-detail-native-app-browser-tests',
      directory: 'backend',
      args: [
        'node_modules/vitest/vitest.mjs',
        'run',
        'tests/order-history/online-detail.mysql.test.ts',
        '-t',
        'loads actual routed App with native cookie',
        '--maxWorkers=1',
      ],
      environment: { ORDER_DETAIL_BROWSER_TEST: 'true' },
    });
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
    id: 'counter-barcode-browser-tests',
    directory: 'frontend',
    args: [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/counter-catalog/browser.test.ts',
      '--maxWorkers=1',
    ],
    environment: { COUNTER_BARCODE_BROWSER_TESTS: 'true' },
  });
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
    id: 'product-feedback-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/product-feedback/browser.test.ts'],
    environment: { PRODUCT_FEEDBACK_BROWSER_TESTS: 'true' },
  });
  checks.push({
    id: 'customer-profile-browser-tests',
    directory: 'frontend',
    args: ['node_modules/vitest/vitest.mjs', 'run', 'tests/customer-profile/browser.test.ts'],
    environment: { CUSTOMER_PROFILE_BROWSER_TESTS: 'true' },
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
