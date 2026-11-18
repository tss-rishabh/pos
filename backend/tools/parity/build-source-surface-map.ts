/**
 * Deterministic implementation inventory. Never promotes release certification.
 *
 * TypeScript port of the former tools/parity/build_source_surface_map.py. Source
 * is read at the pinned commit with `git show` and inspected as text only. Local
 * application/test files are only read; the sole outputs are the two
 * source-surface-map artifacts in backend/parity.
 *
 * Usage (from backend/): `node --import tsx tools/parity/build-source-surface-map.ts [--check]`
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  functionAt,
  routeCallArguments,
  scanPython,
  stringConstants,
  topLevelDefinition,
  topLevelImports,
  viewTarget,
  type PythonScan,
} from './python-source.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = Record<string, Json>;
interface ReviewMarker {
  $review: true;
  path: string;
  anchor: string;
  scope: string;
  source: boolean;
}
interface FamilyData {
  id: string;
  implementation_status: string;
  backend: string[];
  frontend: string[];
  tests: string[];
  parity_documents: string[];
  remaining_code: string[];
  external_acceptance: string[];
  code_task_required: boolean;
  implementation_review?: ReviewMarker[];
  [key: string]: Json | ReviewMarker[] | undefined;
}

const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = dirname(BACKEND);
const SOURCE = resolve(dirname(WORKSPACE), 'backend-pos-web');
const INVENTORY = join(BACKEND, 'parity/legacy-inventory.json');
const ADMIN_MAP = join(BACKEND, 'parity/administration-feature-map.json');
const DEFINITIONS = join(BACKEND, 'tools/parity/source-surface-families.json');
const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8')) as {
  source_commit: string;
  source_hashes: { path: string; sha256: string }[];
  routes: (Row & {
    id: string;
    file: string;
    line: number;
    include: string | null;
    route: string;
  })[];
  jobs: (Row & { id: string; file: string; line: number; name: string })[];
  templates: (Row & { id: string; path: string })[];
  websockets: (Row & { id: string })[];
  administration: (Row & { id: string; file: string })[];
};
const definitions = JSON.parse(readFileSync(DEFINITIONS, 'utf8')) as {
  families: FamilyData[];
  routeGroups: Record<string, string[]>;
  jobFamilies: Record<string, string[]>;
  expected: Record<string, number>;
};
const PIN = inventory.source_commit;
const EXPECTED = definitions.expected;
const IGNORED_INPUT_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  '.cache',
  '.pytest_cache',
  '.ruff_cache',
  'private',
]);
const HASHED_SUFFIXES = new Set([
  '.ts',
  '.tsx',
  '.sql',
  '.py',
  '.go',
  '.mjs',
  '.sh',
  '.json',
  '.html',
  '.md',
  '.css',
]);
const families = new Map<string, Row>();
const sourceCache = new Map<string, string>();
const scanCache = new Map<string, PythonScan>();
const inputHashes = new Map<string, string>();

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const posix = (path: string) => path.split(sep).join('/');

function pinned(path: string): string {
  let text = sourceCache.get(path);
  if (text === undefined) {
    const raw = execFileSync('git', ['show', `${PIN}:${path}`], {
      cwd: SOURCE,
      maxBuffer: 64 * 1024 * 1024,
    });
    const expected = inventory.source_hashes.find((row) => row.path === path)?.sha256;
    if (expected && sha(raw) !== expected)
      throw new Error(`Source inventory hash mismatch: ${path}`);
    text = raw.toString('utf8');
    sourceCache.set(path, text);
  }
  return text;
}
function pinnedScan(path: string) {
  let scan = scanCache.get(path);
  if (!scan) {
    scan = scanPython(pinned(path));
    scanCache.set(path, scan);
  }
  return scan;
}

/** Sorted workspace-relative matches of a pattern using `*` and `**` segments. */
function glob(pattern: string): string[] {
  const parts = pattern.split('/'),
    results: string[] = [];
  const segment = (value: string) =>
    new RegExp(
      '^' +
        value
          .replace(/[.+^${}()|\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]') +
        '$',
    );
  function walk(directory: string, index: number) {
    if (index === parts.length) {
      results.push(posix(relative(WORKSPACE, directory)));
      return;
    }
    const part = parts[index]!;
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return;
    if (part === '**') {
      walk(directory, index + 1);
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) walk(join(directory, entry.name), index);
      return;
    }
    const matcher = segment(part);
    for (const entry of readdirSync(directory))
      if (matcher.test(entry)) walk(join(directory, entry), index + 1);
  }
  walk(WORKSPACE, 0);
  return [...new Set(results)].sort();
}

function hashTree(directory: string) {
  const children: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_INPUT_DIRECTORIES.has(entry.name)) visit(child);
      } else children.push(child);
    }
  };
  visit(directory);
  for (const child of children.sort()) {
    const relativePath = posix(relative(WORKSPACE, child));
    if (
      lstatSync(child).isFile() &&
      !relativePath.split('/').some((part) => IGNORED_INPUT_DIRECTORIES.has(part)) &&
      HASHED_SUFFIXES.has(extname(child))
    )
      inputHashes.set(relativePath, sha(readFileSync(child)));
  }
}

function references(paths: readonly string[]): string[] {
  const output: string[] = [];
  for (const pattern of paths) {
    const matches = /[*?[]/.test(pattern)
      ? glob(pattern)
      : existsSync(join(WORKSPACE, pattern))
        ? [pattern]
        : [];
    if (!matches.length) throw new Error(`Mapping evidence path is absent: ${pattern}`);
    for (const path of matches) {
      if (!output.includes(path)) output.push(path);
      const absolute = join(WORKSPACE, path);
      if (statSync(absolute).isFile()) inputHashes.set(path, sha(readFileSync(absolute)));
      else hashTree(absolute);
    }
  }
  return output;
}

/** Bind a reviewed implementation assertion to a current unique code line. */
function reviewReference(marker: ReviewMarker): Row {
  let text: string;
  if (marker.source) text = pinned(marker.path);
  else {
    references([marker.path]);
    text = readFileSync(join(WORKSPACE, marker.path), 'utf8');
  }
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line, index) => (line.includes(marker.anchor) ? index + 1 : 0))
    .filter(Boolean);
  if (lines.length !== 1)
    throw new Error(`Implementation review anchor changed: ${marker.path}: ${marker.anchor}`);
  return {
    path: marker.path,
    line: lines[0]!,
    anchor: marker.anchor.trim(),
    scope: marker.scope,
    ...(marker.source ? { source_commit: PIN, sha256: sha(text) } : {}),
  };
}

function defineFamilies() {
  for (const data of definitions.families) {
    const row: Row = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === 'implementation_review') continue;
      if (['backend', 'frontend', 'tests', 'parity_documents'].includes(key))
        row[key] = references(value as string[]);
      else row[key] = value as Json;
    }
    if (data.implementation_review)
      row.implementation_review = data.implementation_review.map(reviewReference);
    families.set(data.id, row);
  }
}

function templateFamilies(path: string): string[] {
  const local = path.split('/templates/').slice(1).join('/templates/');
  const starts = (...prefixes: string[]) => prefixes.some((prefix) => local.startsWith(prefix));
  if (path.startsWith('users/templates/admin/')) return ['shared-shell'];
  if (local === '500.html' || local === 'order/basic_error.html') return ['system-health'];
  if (local.startsWith('auth/'))
    return local.endsWith('login.html')
      ? ['identity']
      : local.endsWith('profile.html')
        ? ['self-profile']
        : local.endsWith('auth_qr.html')
          ? ['device-signin']
          : ['operators'];
  if (local === 'dashboard/dashboard.html') return ['dashboard-summary'];
  if (local === 'dashboard/main_dashboard.html') return ['shared-shell', 'motivational-quotes'];
  if (starts('catalogue/')) return ['catalog-read'];
  if (starts('delivery_timing/')) return ['support'];
  if (starts('documentation/')) return ['documentation'];
  if (starts('ecom_delivery/')) return ['support', 'ecommerce-inventory-sync'];
  if (starts('edc_edit/')) return ['terminals'];
  if (starts('gift_card/')) return ['gift-card-batches'];
  if (starts('mpos_download/')) return ['staff-installer-handoff'];
  if (starts('user_to_app/')) return ['customer-application-handoff'];
  if (starts('offline_billing/')) return ['offline-scratch-invoice'];
  if (starts('order_punch/', 'shopify_order_punch/')) return ['legacy-order-imports'];
  if (starts('upload_logs/'))
    return [
      'inventory-imports',
      'legacy-order-imports',
      'parent-store-assignment-csv',
      'inactive-upload-logs',
    ];
  if (starts('salespersons/')) return ['salespeople'];
  if (starts('special_permission/'))
    return [
      'special-permission-history',
      'wallet-adjustments',
      'global-vouchers',
      'global-barcode-assignment',
    ];
  if (starts('settings/')) return ['support'];
  if (local === 'products/stock/inventory-sync.html') return ['catalog-maintenance'];
  if (local === 'products/stock/index.html' || local === 'products/stock/index_bak.html')
    return ['catalog-read', 'inventory', 'inventory-imports'];
  if (
    starts('products/hold_stock/', 'products/storage_stock/') ||
    local === 'products/inventory_logs.html'
  )
    return ['inventory-audit'];
  if (starts('products/store/')) return ['catalog-read', 'parent-store-assignment-csv'];
  if (local === 'products/index.html') return ['catalog-read'];
  if (local === 'order/create_order.html')
    return [
      'checkout-cart',
      'customer-workspace',
      'customer-contacts',
      'customer-verification',
      'payments',
      'fast-cash',
      'cashier-shortcuts',
      'order-to-cart-copy',
      'customer-website-handoff',
      'motivational-quotes',
    ];
  if (local === 'order/tab.html') return ['checkout-cart', 'motivational-quotes'];
  if (local === 'order/shortcuts.html') return ['cashier-shortcuts'];
  if (local === 'order/_exchange_js.html') return ['returns-exchanges'];
  if (local === 'order/_hl_banner.html') return ['express-fulfillment', 'notifications'];
  if (local === 'order/add_order_feedback.html') return ['product-feedback'];
  if (local === 'order/shipping.html') return ['shipping-labels'];
  if (local === 'order/invoice.html') return ['invoice-documents'];
  if (starts('order/hyperlocal/')) return ['express-fulfillment'];
  if (starts('order/online/')) return ['orders-read', 'returns-exchanges', 'invoice-documents'];
  if (local === 'order/index.html' || local === 'order/show.html')
    return [
      'orders-read',
      'payments',
      'returns-exchanges',
      'pending-order-cancellation',
      'local-deliveries',
      ...(local === 'order/show.html' ? ['legacy-vinculum-status'] : []),
    ];
  if (starts('bd_report/')) return ['business-metrics-upload'];
  if (starts('daily_store_report/')) return ['daily-store-report'];
  if (starts('day_close/')) return ['finance-day-close'];
  if (starts('export/')) return ['report-exports'];
  if (starts('orders/', 'performance_report/', 'sales/')) return ['operational-reports'];
  if (starts('product/')) return ['inventory-workbooks', 'catalog-read'];
  if (starts('counters/')) return ['counters'];
  if (local === 'stores/slack_callback.html') return ['store-slack-oauth'];
  if (starts('stores/storage/')) return ['storage'];
  if (starts('stores/')) return ['stores', 'store-images', 'location-codes', 'country-search'];
  throw new Error(`Unmapped template: ${path}`);
}

function sourceDefinition(route: { file: string; line: number }): Row | null {
  const scan = pinnedScan(route.file),
    args = routeCallArguments(scan, route.line);
  if (!args || args.length < 2) return null;
  const parts = viewTarget(args[1]!).split('.');
  const imports = topLevelImports(scan);
  const absolute =
    (imports[parts[0]!] ?? parts[0]!) + (parts.length > 1 ? '.' + parts.slice(1).join('.') : '');
  const name = parts[parts.length - 1]!;
  const dot = absolute.lastIndexOf('.');
  const module = (dot < 0 ? absolute : absolute.slice(0, dot)).replaceAll('.', '/') + '.py';
  if (!inventory.source_hashes.some((item) => item.path === module))
    return { symbol: name, import: absolute, framework: true };
  const target = pinnedScan(module),
    definition = topLevelDefinition(target, name);
  if (definition) {
    const segment = target.lines.slice(definition.line - 1, definition.end).join('\n');
    const templates = [
      ...new Set(
        stringConstants(target, definition.line, definition.end).filter((value) =>
          value.endsWith('.html'),
        ),
      ),
    ].sort();
    return {
      symbol: name,
      file: module,
      line: definition.line,
      end_line: definition.end,
      sha256: sha(segment),
      templates,
    };
  }
  return { symbol: name, import: absolute, definition_unresolved: true };
}

function surfaceStatus(keys: string[]) {
  // This retained template has only commented routes/classes. Shared task-family
  // associations preserve lineage; they do not make the inactive page partial.
  if (keys.includes('inactive-upload-logs')) return 'missing';
  const states = keys.map((key) => families.get(key)!.implementation_status);
  if (states.every((state) => state === 'missing')) return 'missing';
  if (states.some((state) => state === 'partial' || state === 'missing')) return 'partial';
  if (keys.some((key) => (families.get(key)!.external_acceptance as string[]).length))
    return 'external_acceptance';
  return 'implementation_present';
}

function mapped(source: Row & { id: string }, keys: string[] | undefined): Row {
  if (!keys?.length || keys.some((key) => !families.has(key)))
    throw new Error(
      `Surface lacks an explicit mapped family: ${source.id}: ${JSON.stringify(keys)}`,
    );
  return {
    source,
    families: [...new Set(keys)],
    status: surfaceStatus(keys),
    workflow_certified: false,
    inventory_status_unchanged: (source.status as string | undefined) ?? 'unverified',
  };
}

function testFiles(references: string[]) {
  const names = new Set<string>();
  for (const reference of references) {
    const absolute = join(WORKSPACE, reference);
    if (statSync(absolute).isFile()) {
      names.add(reference);
      continue;
    }
    const visit = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && /\.(test|spec)\.ts$/.test(entry.name))
          names.add(posix(relative(WORKSPACE, child)));
      }
    };
    visit(absolute);
  }
  return [...names].sort();
}

function count(values: string[]) {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function build() {
  defineFamilies();
  const output: Record<string, Row[]> = Object.fromEntries(
    Object.keys(EXPECTED).map((key) => [key, []]),
  );
  const mounts = new Map<string, string[]>();
  for (const route of inventory.routes)
    if (route.include) {
      const file = route.include.replaceAll('.', '/') + '.py';
      mounts.set(file, [...(mounts.get(file) ?? []), route.route]);
    }
  for (const route of inventory.routes) {
    if (route.include) continue;
    const row = mapped(route, definitions.routeGroups[route.id]);
    row.source_definition = sourceDefinition(route);
    row.effective_paths = (mounts.get(route.file) ?? ['']).map(
      (prefix) => '/' + prefix + route.route,
    );
    output.routes!.push(row);
  }
  for (const job of inventory.jobs) {
    const row = mapped(job, definitions.jobFamilies[job.id]);
    const definition = functionAt(pinnedScan(job.file), job.line);
    if (!definition) throw new Error(`Source job definition not found: ${job.id}`);
    row.source_definition = {
      file: job.file,
      line: definition.line,
      end_line: definition.end,
      symbol: job.name,
    };
    row.reachability =
      [
        'core/tasks.py:51',
        'core/tasks.py:62',
        'order/views.py:3839',
        'report/datatables/inventory_datatable.py:60',
      ].includes(job.id) || job.file === 'report/tasks.py'
        ? 'latent-commented-http-caller'
        : 'registered-task-or-caller';
    if (job.id === 'stores/tasks.py:11') row.reachability = 'diagnostic-only-no-account-write';
    output.jobs!.push(row);
  }
  const referencedTemplates = new Set<string>();
  for (const route of output.routes!)
    for (const template of ((route.source_definition as Row | null)?.templates as string[]) ?? [])
      referencedTemplates.add(template);
  for (const template of inventory.templates) {
    const row = mapped(template, templateFamilies(template.path));
    const local = template.path.split('/templates/').slice(1).join('/templates/');
    row.reachability = referencedTemplates.has(local)
      ? 'referenced-by-active-view'
      : 'shared-include-or-latent-template';
    row.source_template_sha256 = sha(pinned(template.path));
    row.original_template_flow_certified = false;
    output.templates!.push(row);
  }
  for (const socket of inventory.websockets)
    output.websockets!.push(mapped(socket, ['notifications']));
  for (const admin of inventory.administration) {
    const keys =
      admin.file === 'stores/admin.py'
        ? [
            'stores',
            'store-images',
            'support',
            'ecommerce-inventory-sync',
            'inherited-administration-history',
            'inherited-model-add-forms',
          ]
        : [
            'operators',
            'operator-administrative-profile',
            'operator-mfa',
            'model-administration-access',
            'inherited-administration-history',
            'inherited-model-add-forms',
          ];
    const row = mapped(admin, keys);
    row.source_framework_capabilities = [
      'add/change/list/search/history',
      'source model permissions',
      'default selected-object action collector',
    ];
    row.lifecycle_clarification =
      'User clarified Store/PosUser use reversible archive/deleted flags, not physical deletion. IDs/history/offline collected cash recognition must survive; generic hard delete is not a required active business flow.';
    row.compatibility_limits = [
      'Inherited username/password-only add is implemented separately with actual form defaults/blank-email uniqueness evidence. Actual Store.save always overwrites submitted url_key with the generated URL. Source nullable Store/physical NOT NULL conflicts remain diagnosed failures, and operational grants/actor lineage/full workflows are not certified.',
    ];
    output.administration!.push(row);
  }
  for (const [key, item] of families)
    if ('implementation_review' in item)
      item.reviewed_source_surfaces = Object.entries(output).flatMap(([kind, rows]) =>
        rows
          .filter((row) => (row.families as string[]).includes(key))
          .map((row) => ({
            kind,
            id: (row.source as Row).id as string,
            disposition: row.status as string,
          })),
      );
  const actual = Object.fromEntries(
    Object.entries(output).map(([key, rows]) => [key, rows.length]),
  );
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED))
    throw new Error(`Coverage mismatch: ${JSON.stringify(actual)} != ${JSON.stringify(EXPECTED)}`);
  for (const [key, rows] of Object.entries(output)) {
    const ids = rows.map((row) => (row.source as Row).id);
    if (ids.length !== new Set(ids).size) throw new Error(`Duplicate source IDs: ${key}`);
  }
  for (const item of families.values()) item.test_files = testFiles(item.tests as string[]);
  inputHashes.set('backend/parity/legacy-inventory.json', sha(readFileSync(INVENTORY)));
  inputHashes.set('backend/parity/administration-feature-map.json', sha(readFileSync(ADMIN_MAP)));
  for (const [path, digest] of inputHashes)
    if (sha(readFileSync(join(WORKSPACE, path))) !== digest)
      throw new Error(`Input changed during coverage pass: ${path}`);
  const gaps = [...families.entries()]
    .filter(([, value]) => (value.remaining_code as string[]).length && value.code_task_required)
    .map(([key, value]) => ({
      family: key,
      state: value.implementation_status,
      tasks: value.remaining_code,
    }));
  const rows = Object.values(output).flat();
  const summary = {
    surfaces: actual,
    total: Object.values(actual).reduce((sum, value) => sum + value, 0),
    by_status: count(rows.map((row) => row.status as string)),
    by_kind: Object.fromEntries(
      Object.entries(output).map(([key, values]) => [
        key,
        count(values.map((row) => row.status as string)),
      ]),
    ),
    families: families.size,
    code_task_groups: gaps.length,
    workflow_certifications_added: 0,
    unmapped: 0,
  };
  return {
    schema_version: 1,
    source_commit: PIN,
    meaning:
      'Implementation map only. Existing release-coverage statuses remain unchanged. Test file presence/component checks never imply source workflow or production certification. Known defects and policy corrections retain separate decision records. The user-approved payment-failure calendar-date correction was implemented in Go producers that were deleted on 19 November 2026; native acceptance remains separate. Zero feature gap groups does not select unrelated policies or pass their gates.',
    status_definitions: {
      implementation_present:
        'Mapped behavior is implemented at component/code level; no full source workflow certification.',
      partial: 'An identified source behavior or binding is incomplete; see family remaining_code.',
      missing:
        'No matching implementation of this behavior was established; adjacent features do not substitute.',
      external_acceptance:
        'Implementation is present but a named real provider/data/publication/shared-writer acceptance remains.',
    },
    summary,
    input_sha256: Object.fromEntries(
      [...inputHashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    families: [...families.values()],
    remaining_code_tasks: gaps,
    ...output,
  };
}

type Result = ReturnType<typeof build>;

function markdown(result: Result) {
  const counts = result.summary;
  const lines = [
    '# Exact source-surface implementation map',
    '',
    `Baseline \`${PIN}\`. **${counts.total} surfaces mapped; zero unmapped; zero release certifications added.**`,
    '',
    'This is the implementation inventory requested for the full rewrite, not a replacement for `release-coverage.json`. Existing component/source/native/browser tests remain bounded evidence. No original-template or complete production workflow is certified by this file.',
    '',
    '| Source kind | Count |',
    '| --- | ---: |',
  ];
  for (const [key, value] of Object.entries(counts.surfaces)) lines.push(`| ${key} | ${value} |`);
  lines.push(
    '',
    'The 263 route declarations contain eight include mounts; all 255 leaves remain individually mapped, including aliases/duplicates and the framework-admin mount. Order routes retain both `/api/v1/orders/` and `/orders/` mount paths. All 32 named tasks and all 106 templates remain visible, including latent/commented callers and diagnostics.',
    '',
    '## Concrete remaining code, by feature group',
    '',
  );
  if (!result.remaining_code_tasks.length)
    lines.push(
      'No additional missing source-feature implementation is currently identified by this map. The named external acceptance gates, default-disabled selections and explicit inactive/diagnostic exclusions remain. Known defects and inactive policy candidates retain their separate decision records; the wallet calendar-date decision remains pending. No release, default-gate or full-workflow certification is added.',
    );
  for (const gap of result.remaining_code_tasks)
    lines.push(`- **${gap.family} (${String(gap.state)})**: ` + (gap.tasks as string[]).join(' '));
  lines.push(
    '',
    '## Line-bound implementation review',
    '',
    'These reviewed code paths bind actual import/manager/table controls and preserve the explicitly excluded source diagnostics/prototype and inactive upload-log/download. Line anchors are regenerated from current implementation or pinned source; test presence does not establish these claims.',
    '',
  );
  for (const item of result.families) {
    const reviews = item.implementation_review as Row[] | undefined;
    if (!reviews?.length) continue;
    lines.push(
      `### ${String(item.id)}`,
      '',
      'Mapped surfaces: ' +
        (item.reviewed_source_surfaces as Row[])
          .map((row) => '`' + String(row.id) + '` (' + String(row.disposition) + ')')
          .join(', ') +
        '.',
      '',
      '| Code/source reference | Reviewed scope |',
      '| --- | --- |',
    );
    for (const reference of reviews)
      lines.push(
        `| \`${String(reference.path)}:${String(reference.line)}\` | ${String(reference.scope)} |`,
      );
    lines.push('');
  }
  lines.push(
    '',
    'Any remaining code gaps are distinct from configured provider acceptance. Parent/store archive/reactivation retains stable financial identities per the user clarification; generic physical Store/PosUser deletion is not a missing active feature. `create_random_user_accounts_new` only prints generated credentials with its actual account insert commented out: its missing replacement is a diagnostic-only inventory item, not a newly required credential-logging or mass-account product feature.',
    '',
    '## Implementation/acceptance counts',
    '',
    '| Kind | Present | Partial | Missing | External acceptance |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const [kind, values] of Object.entries(counts.by_kind))
    lines.push(
      '| ' +
        kind +
        ' | ' +
        ['implementation_present', 'partial', 'missing', 'external_acceptance']
          .map((state) => String(values[state] ?? 0))
          .join(' | ') +
        ' |',
    );
  lines.push(
    '',
    '“External acceptance” means code exists and the named real dependency remains unaccepted. It does not turn a missing callback/financial adapter into a deployed feature. Warehouse absence, source collation/generation proofs, shared writer patches, physical printers, real OAuth/SMS/mail and SDD/legal rendering are carried at their specific family boundaries in the JSON; they are not hundreds of invented code tasks.',
    '',
    '## Source-to-replacement ledger',
    '',
    'Each row below links to family IDs in `source-surface-map.json`; those families list current backend/frontend modules, test files/directories, source evidence and exact code/external gaps. Original IDs and unverified status are retained unchanged. A mapped template means the corresponding React feature is accounted for, not that every original DOM transition has been certified.',
    '',
  );
  for (const kind of Object.keys(EXPECTED)) {
    lines.push(
      `### ${kind}`,
      '',
      '| Source | Surface | Families | Implementation disposition |',
      '| --- | --- | --- | --- |',
    );
    for (const row of result[kind as keyof typeof EXPECTED & keyof Result] as Row[]) {
      const source = row.source as Row;
      const label = String(
        source.route ||
          source.path ||
          source.name ||
          ((source.models as string[] | undefined) ?? []).join(', ') ||
          '(root)',
      ).replaceAll('|', '&#124;');
      lines.push(
        `| \`${String(source.id)}\` | \`${label}\` | ${(row.families as string[]).join(', ')} | ${String(row.status)} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Reproducibility and limits',
    '',
    'Regenerate with `node --import tsx tools/parity/build-source-surface-map.ts`; validate saved outputs without writing using `--check`. The generator verifies pinned source hashes, exact source ID/count coverage, explicit family membership, evidence-path existence and stable file inputs during generation. It only writes the two new map artifacts. It does not run tests, builds, servers, providers, DDL or source jobs and never modifies application code, source siblings or the release coverage ledger.',
    '',
    'Source definitions/rendered templates are resolved by static reading of the pinned Python text (statement boundaries, top-level imports and string constants); no legacy code is imported or executed. Framework/dynamic imports remain labeled explicitly. Test references identify evidence scope; they are not fresh test receipts. Family definitions are frozen in `tools/parity/source-surface-families.json`; edit them there and regenerate.',
  );
  return lines.join('\n') + '\n';
}

/** `json.dumps(value, indent=2)` byte compatibility: non-ASCII is `\uXXXX`-escaped. */
function pythonJson(value: unknown) {
  return JSON.stringify(value, null, 2).replace(
    /[\u0080-￿]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((value) => value !== '--check')) throw new Error('Only --check is supported.');
  const check = args.includes('--check');
  const result = build();
  const outputs: [string, string][] = [
    [join(BACKEND, 'parity/source-surface-map.json'), pythonJson(result) + '\n'],
    [join(BACKEND, 'parity/source-surface-map.md'), markdown(result)],
  ];
  for (const [path, text] of outputs) {
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text)
        throw new Error(`Source-surface map is stale: ${path.split('/').pop()}`);
    } else writeFileSync(path, text);
  }
  process.stdout.write(
    `Mapped ${result.summary.total} source surfaces; remaining code groups=${result.summary.code_task_groups}; unmapped=0; release certifications added=0\n`,
  );
}

main();
