import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
    CHECKOUT_MYSQL_TEST_URL: 'pos_rewrite_checkout_test',
    MIGRATION_MYSQL_TEST_URL: 'pos_rewrite_migrations_test',
    SPECIAL_PERMISSION_MYSQL_TEST_URL: 'pos_rewrite_activity_history_test',
    APPLICATION_LINK_MYSQL_TEST_URL: 'pos_rewrite_application_links_test',
    CUSTOMER_PROFILE_MYSQL_TEST_URL: 'pos_rewrite_customer_profile_test',
    CUSTOMER_CONTACT_MYSQL_TEST_URL: 'pos_rewrite_customer_contacts_test',
    CUSTOMER_OTP_MYSQL_TEST_URL: 'pos_rewrite_customer_otp_test',
    CUSTOMER_WEBSITE_HANDOFF_MYSQL_TEST_URL: 'pos_rewrite_customer_website_handoff_test',
    GLOBAL_VOUCHERS_MYSQL_TEST_URL: 'pos_rewrite_global_vouchers_test',
    LEGACY_ORDER_IMPORT_MYSQL_TEST_URL: 'pos_rewrite_legacy_order_imports_test',
    INVENTORY_WORKBOOK_MYSQL_TEST_URL: 'pos_rewrite_inventory_workbooks_test',
    DASHBOARD_MYSQL_TEST_URL: 'pos_rewrite_dashboard_test',
    BARCODE_ASSIGNMENTS_MYSQL_TEST_URL: 'pos_rewrite_barcodes_test',
    ORDER_HISTORY_MYSQL_TEST_URL: 'pos_rewrite_order_history_test',
    PARENT_STORE_IMPORTS_MYSQL_TEST_URL: 'pos_rewrite_parent_store_test',
    MODEL_ACCOUNTS_MYSQL_TEST_URL: 'pos_rewrite_model_accounts_test',
    GIFT_CARD_BATCH_MYSQL_TEST_URL: 'pos_rewrite_gift_card_batches_test',
    ADMINISTRATION_HISTORY_MYSQL_TEST_URL: 'pos_rewrite_administration_history_test',
  })) {
    url.pathname = '/' + schema;
    childEnvironment[name] = url.href;
  }
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

type Check = {
  id: string;
  directory: 'backend' | 'frontend';
  command?: 'sh';
  args: string[];
  environment?: NodeJS.ProcessEnv;
};
type CheckResult = { id: string; exitCode: number; durationMs: number; log: string };
const checks: Check[] = [
  {
    id: 'backend-build',
    directory: 'backend',
    args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
  },
  {
    id: 'backend-lint',
    directory: 'backend',
    args: ['node_modules/eslint/bin/eslint.js', 'src', 'tests', 'tools'],
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
  { id: 'backend-tests', directory: 'backend', args: ['node_modules/vitest/vitest.mjs', 'run'] },
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
  { id: 'frontend-tests', directory: 'frontend', args: ['node_modules/vitest/vitest.mjs', 'run'] },
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
if (flags.has('--mysql')) {
  checks.push(
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
  checks.push(
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
let activeProcess: ReturnType<typeof spawn> | undefined,
  stopped = false;
function stopActive(signal: NodeJS.Signals) {
  if (!activeProcess?.pid) return;
  try {
    if (process.platform === 'win32') activeProcess.kill(signal);
    else process.kill(-activeProcess.pid, signal);
  } catch {
    /* The child can finish between checking its PID and signalling it. */
  }
}
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    stopped = true;
    stopActive(signal);
  });
async function run(check: Check): Promise<CheckResult> {
  const started = performance.now(),
    output: Buffer[] = [];
  let bytes = 0,
    exceeded = false;
  const child = spawn(check.command ?? process.execPath, check.args, {
    cwd: resolve(workspace, check.directory),
    env: { ...childEnvironment, ...check.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  activeProcess = child;
  const collect = (value: Buffer) => {
    bytes += value.length;
    if (bytes <= 4 * 1024 * 1024) output.push(value);
    else if (!exceeded) {
      exceeded = true;
      stopActive('SIGTERM');
    }
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const timeout = setTimeout(() => stopActive('SIGKILL'), 10 * 60 * 1000);
  const code = await new Promise<number>((done) => {
    child.once('error', () => done(1));
    child.once('close', (exitCode) => done(exitCode ?? 1));
  });
  clearTimeout(timeout);
  activeProcess = undefined;
  const log = `backend/evidence/private/verification-${check.id}.log`;
  writeFileSync(resolve(workspace, log), Buffer.concat(output));
  const result = {
    id: check.id,
    exitCode: exceeded ? 1 : code,
    durationMs: Math.round(performance.now() - started),
    log,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  return result;
}
const results: CheckResult[] = [];
for (const check of checks) {
  if (stopped) break;
  if (check.id === 'browser-tests' && results.some((result) => result.exitCode !== 0)) break;
  results.push(await run(check));
}
const gate = await run({
  id: 'release-gate',
  directory: 'backend',
  args: ['--import', 'tsx', 'tools/parity-gate.ts'],
});
const after = inputChecksums();
const sourceAfter = sourceBaseline();
const sourceChanged = sourceAfter.commit !== sourceBefore.commit || !sourceAfter.clean;
const changedInputs = [...new Set([...Object.keys(checksums), ...Object.keys(after)])].filter(
  (name) => checksums[name] !== after[name],
);
const exitCode =
  stopped ||
  results.length !== checks.length ||
  results.some((check) => check.exitCode !== 0) ||
  sourceChanged ||
  changedInputs.length ||
  (flags.has('--release') && gate.exitCode !== 0)
    ? 1
    : 0;
const report = {
  version: 1,
  sourceCommit: inventory.source_commit,
  sourceBaseline: { before: sourceBefore, after: sourceAfter, changed: sourceChanged },
  recordedAt: new Date().toISOString(),
  command: `node --import tsx tools/verify-project.ts${[...flags].map((flag) => ' ' + flag).join('')}`,
  exitCode,
  nodeVersion: process.versions.node,
  scope: { localMySql: flags.has('--mysql'), browser: flags.has('--browser') },
  productionReady: gate.exitCode === 0 && exitCode === 0,
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
    changedInputs: changedInputs.length,
    evidence: 'backend/evidence/verification.json',
  }) + '\n',
);
process.exitCode = exitCode;
