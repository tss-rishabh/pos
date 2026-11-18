/** Allowlist comes from pinned production builders/AST, never observed traffic. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { qualifiedSearchViews, type OrderSearchOptions } from '../../../src/modules/order-history/search/options.js';
import type { OrderHistoryOptions } from '../../../src/modules/order-history/options.js';
import { historyListSql, historyOrderSql, historyCopySql, historyPointPublicationSql } from '../../../src/modules/order-history/sql.js';

export function allowedOrderStatements(search: OrderSearchOptions, history: OrderHistoryOptions) {
  const url = new URL('../../../src/modules/order-history/search/warehouse.ts', import.meta.url);
  const text = readFileSync(url, 'utf8');
  const source = ts.createSourceFile(url.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const views = qualifiedSearchViews(search);
  const constants = new Map<string, ts.Expression>();
  const partitions: string[] = [];
  const templates: ts.TemplateExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ['fields', 'publicationFields'].includes(node.name.text)) {
      if (constants.has(node.name.text)) throw new Error('AMBIGUOUS_PRODUCTION_SQL_CONSTANT');
      constants.set(node.name.text, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === 'partition' && ts.isStringLiteral(node.right)) partitions.push(node.right.text);
    if (ts.isTemplateExpression(node) && /^SELECT\b/.test(node.head.text)) templates.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (constants.size !== 2 || partitions.length !== 2 || templates.length !== 3) throw new Error('PRODUCTION_SQL_SHAPE_CHANGED');
  function evaluate(node: ts.Expression, partition: string): string {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      if (node.text === 'partition') return partition;
      const expression = constants.get(node.text);
      if (!expression) throw new Error('UNREVIEWED_PRODUCTION_SQL_IDENTIFIER');
      return evaluate(expression, partition);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'views') {
      const key = node.name.text;
      if (key !== 'index' && key !== 'facts' && key !== 'publications') throw new Error('UNREVIEWED_PRODUCTION_SQL_VIEW');
      return views[key];
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'replaceAll' && node.arguments.length === 2)
      return evaluate(node.expression.expression, partition).replaceAll(evaluate(node.arguments[0]!, partition), evaluate(node.arguments[1]!, partition));
    throw new Error('UNREVIEWED_PRODUCTION_SQL_EXPRESSION');
  }
  const statements = new Set<string>();
  for (const template of templates) for (const partition of partitions) {
    let statement = template.head.text;
    for (const span of template.templateSpans) statement += evaluate(span.expression, partition) + span.literal.text;
    statements.add(statement);
  }
  if (statements.size !== 4) throw new Error('PRODUCTION_SEARCH_QUERY_SET_CHANGED');
  for (const builder of [historyListSql, historyOrderSql, historyCopySql, historyPointPublicationSql]) statements.add(builder(history));
  return {
    statements: [...statements],
    source: { path: 'backend/src/modules/order-history/search/warehouse.ts', sha256: createHash('sha256').update(text).digest('hex') },
  };
}
