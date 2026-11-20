/**
 * Captures the verbatim legacy source excerpts that tests execute (see
 * tests/golden/source-excerpts.ts). Run outside CI, against files exported from the pinned
 * legacy repositories, e.g.:
 *
 *   git --git-dir=<backend-pos-web>/.git show 78d5b63d…:order/templates/order/index.html > index.html
 *   git --git-dir=<backend-sync-api>/.git show 70b80159…:new-src/api/models/inventoryModel.ts > inventoryModel.ts
 *   git show b90b4be7…:backend/src/modules/orders.ts > orders.ts   (this repository's history)
 *   node --import tsx tools/golden/capture-source-excerpts.ts \
 *     --pos-web-order-index index.html --sync-api-inventory-model inventoryModel.ts \
 *     --rewrite-prior-orders orders.ts
 *
 * Each input must match the recorded whole-file SHA-256 of the pinned commit, so an excerpt can
 * only come from the pinned source. Excerpt boundaries are the rules the tests used when they
 * read the sibling checkouts directly.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import ts from 'typescript';
import { goldenPath } from '../../tests/golden/load.js';
import { sourceExcerptFileSchema } from '../../tests/golden/source-excerpts.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

interface Capture {
  sourceRepository: string;
  sourceCommit: string;
  path: string;
  fileSha256: string;
  test: string;
  excerpts: Record<string, { rule: string; text: string }>;
}

function write(area: string, name: string, value: Capture) {
  const file = sourceExcerptFileSchema.parse({
    schemaVersion: 1,
    kind: 'source-excerpt',
    ...value,
    capturedAt,
    capture: 'tools/golden/capture-source-excerpts.ts',
    excerpts: Object.fromEntries(
      Object.entries(value.excerpts).map(([key, { rule, text }]) => [
        key,
        { rule, sha256: hash(text), text },
      ]),
    ),
  });
  const path = goldenPath(area, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  process.stdout.write(`wrote ${area}/${name}.json\n`);
}

function read(path: string, expected: string) {
  const text = readFileSync(path, 'utf8');
  if (hash(text) !== expected)
    throw new Error(`${path} is not the pinned file (expected SHA-256 ${expected}).`);
  return { text, sha256: expected };
}

/** backend-pos-web order list template: the `.filter-class` submit handler. */
function orderIndexHandler(path: string) {
  const { text, sha256 } = read(
    path,
    'cf59e63984df4e6d1db6b020d41077ee95b0dfdace3145d7ec5d31e38aba4826',
  );
  const startMarker = "$(document).on('submit', '.filter-class'";
  const endMarker = '\n    {% with request.path as path %}';
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Pinned original form handler not found.');
  write('order-search', 'he-submit-handler', {
    sourceRepository: 'backend-pos-web',
    sourceCommit: '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a',
    path: 'order/templates/order/index.html',
    fileSha256: sha256,
    test: 'backend/tests/order-search/he-store-validation.test.ts',
    excerpts: {
      submitHandler: {
        rule: `from the first ${JSON.stringify(startMarker)} up to the next ${JSON.stringify(endMarker)}`,
        text: text.slice(start, end),
      },
    },
  });
}

/** backend-sync-api inventory model: `getProductInventory` and the online-stock arithmetic. */
function inventoryModel(path: string) {
  const { text, sha256 } = read(
    path,
    '07246982120d152e54f897e10d6407e2fa4d49726638376e489c4ff9319d1d3e',
  );
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const inventory = tree.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'getProductInventory',
  );
  if (!inventory) throw new Error('Pinned source inventory function unavailable.');
  const arithmetic: string[] = [];
  const inspect = (node: ts.Node) => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.expression.left.getText(tree) === 'onlineStock' &&
      /\+\s*storeOnlineStock$/.test(node.expression.right.getText(tree)) &&
      ts.isBlock(node.parent)
    ) {
      const index = node.parent.statements.indexOf(node);
      arithmetic.push(
        node.parent.statements
          .slice(index, index + 3)
          .map((statement) => statement.getText(tree))
          .join('\n'),
      );
    }
    ts.forEachChild(node, inspect);
  };
  inspect(tree);
  if (arithmetic.length !== 1) throw new Error('Pinned source stock arithmetic changed.');
  write('stock-projection', 'inventory-model-source', {
    sourceRepository: 'backend-sync-api',
    sourceCommit: '70b80159016db39a73572f80bfa87c47201c0a9f',
    path: 'new-src/api/models/inventoryModel.ts',
    fileSha256: sha256,
    test: 'backend/tests/stock-projection.mysql.integration.test.ts',
    excerpts: {
      getProductInventory: {
        rule: 'the top-level `function getProductInventory` declaration (TypeScript AST getText)',
        text: inventory.getText(tree),
      },
      onlineStockArithmetic: {
        rule:
          'the only `onlineStock = … + storeOnlineStock` statement in a block and the two ' +
          'statements after it (TypeScript AST getText, joined with newlines)',
        text: arithmetic[0]!,
      },
    },
  });
}

/**
 * This repository's own earlier orders projection (b90b4be), the pinned comparison for
 * tests/order-history/orders.mysql.test.ts; captured so the test needs no git history (CI
 * checkouts are shallow).
 */
function priorOrders(path: string) {
  const { text, sha256 } = read(
    path,
    '68f8a10724a4d20f4e506b2e073134021c76bb9a00d68c60a18d3616eb9ac181',
  );
  write('order-history', 'orders-b90b4be-source', {
    sourceRepository: 'pos-rewrite',
    sourceCommit: 'b90b4be7dfd2a4c67f4e6fe336f7013afa7067c2',
    path: 'backend/src/modules/orders.ts',
    fileSha256: sha256,
    test: 'backend/tests/order-history/orders.mysql.test.ts',
    excerpts: { ordersModule: { rule: 'the whole file', text } },
  });
}

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const orderIndex = option('--pos-web-order-index');
const inventory = option('--sync-api-inventory-model');
const orders = option('--rewrite-prior-orders');
if (!orderIndex && !inventory && !orders)
  throw new Error(
    'Pass --pos-web-order-index, --sync-api-inventory-model and/or --rewrite-prior-orders <file>.',
  );
if (orderIndex) orderIndexHandler(orderIndex);
if (inventory) inventoryModel(inventory);
if (orders) priorOrders(orders);
