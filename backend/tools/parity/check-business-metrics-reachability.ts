/**
 * Inspect pinned source text only; never import the POS application or its settings.
 *
 * TypeScript port of the former tools/parity/check_business_metrics_reachability.py.
 * Usage (from backend/): `node --import tsx tools/parity/check-business-metrics-reachability.ts`
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPython, stringConstants } from './python-source.js';

const PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a';
const BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = resolve(BACKEND, '../../backend-pos-web');
const NAMES = new Set(['DailyRetailMetricsReport', 'AjaxDailyRetailMetricsReport']);
const ROUTES = ['daily_retail_metrics_report', 'ajax_daily_retail_metrics_report'];
const TEMPLATES = [
  'report/templates/bd_report/daily_report_matric_upload.html',
  'report/templates/bd_report/daily_report_matric_report_datatable.html',
];

function source(path: string) {
  try {
    return execFileSync('git', ['show', PIN + ':' + path], {
      cwd: SOURCE,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).toString('utf8');
  } catch {
    throw new Error('Pinned source is unavailable.');
  }
}
/** A class definition at any nesting depth that is real code, not a comment. */
function definesClass(text: string) {
  const scan = scanPython(text);
  return scan.lines.some((line, index) => {
    const match = /^\s*class\s+([A-Za-z_]\w*)\b/.exec(line);
    return scan.info[index]!.statementStart && !!match && NAMES.has(match[1]!);
  });
}
function constants(text: string) {
  const scan = scanPython(text);
  return stringConstants(scan, 1, scan.lines.length);
}

function audit() {
  const views = source('report/views.py'),
    datatable = source('report/datatables/bd_report.py');
  for (const text of [views, datatable])
    if (definesClass(text)) throw new Error('A prototype view became executable.');
  if (
    !views.includes('# class DailyRetailMetricsReport(') ||
    !datatable.includes('# class AjaxDailyRetailMetricsReport(')
  )
    throw new Error('The expected source prototype changed.');

  const inventory = JSON.parse(
    readFileSync(resolve(BACKEND, 'parity/legacy-inventory.json'), 'utf8'),
  ) as {
    source_commit: string;
    routes: unknown[];
  };
  if (inventory.source_commit !== PIN) throw new Error('The source inventory baseline changed.');
  if (inventory.routes.some((route) => ROUTES.some((name) => JSON.stringify(route).includes(name))))
    throw new Error('A source route for the prototype is registered.');
  const urls = source('report/urls.py');
  if (constants(urls).some((value) => ROUTES.includes(value)))
    throw new Error('The report URL module registers a prototype route.');
  if (ROUTES.some((name) => !urls.includes(name)))
    throw new Error('The commented route evidence changed.');

  // Django ignores this complete block, including its missing reverse name.
  const sidebar = source('users/templates/admin/includes/sidebar.html');
  const blocks = [...sidebar.matchAll(/{%\s*comment\s*%}[\s\S]*?{%\s*endcomment\s*%}/g)].map(
    (match) => match[0],
  );
  const token = "{% url 'daily_retail_metrics_report' %}";
  if (sidebar.split(token).length - 1 !== 1 || !blocks.some((block) => block.includes(token)))
    throw new Error('The prototype navigation is no longer fully commented.');

  const executable = [...constants(views), ...constants(datatable)];
  const templateHashes: Record<string, string> = {};
  for (const path of TEMPLATES) {
    const text = source(path);
    templateHashes[path] = createHash('sha256').update(text).digest('hex');
    if (executable.includes(path.replace(/^report\/templates\//, '')))
      throw new Error('An executable report view now references the prototype template.');
  }
  return {
    activeTemplateReferences: 0,
    activeViewDefinitions: 0,
    applicationImported: false,
    externalRequests: 0,
    registeredRoutes: 0,
    sidebarLink: 'inside-django-comment',
    sourceCommit: PIN,
    templatesRetained: Object.fromEntries(
      Object.entries(templateHashes).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
}

try {
  // Key order matches the former `json.dumps(..., sort_keys=True)` single-line output.
  process.stdout.write(
    JSON.stringify(audit()).replaceAll('":', '": ').replaceAll(',"', ', "') + '\n',
  );
} catch {
  // Static failure only: never echo source contents, settings or exceptions.
  process.stderr.write('BUSINESS_METRICS_SOURCE_AUDIT_FAILED\n');
  process.exitCode = 1;
}
