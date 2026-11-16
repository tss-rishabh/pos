import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

interface ReferenceCandidate {
  file: string;
  line: number;
  table: string;
  property: string;
  column: string;
  storage: string;
  status: 'unclassified-reference-candidate' | 'json-payload-requires-owner-review';
}
const backend = resolve(import.meta.dirname, '../..'),
  sourceRoot = resolve(backend, 'src');
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? sourceFiles(resolve(directory, entry.name))
        : entry.isFile() && entry.name.endsWith('.ts')
          ? [resolve(directory, entry.name)]
          : [],
    )
    .sort();
}
function columnCall(value: ts.Expression): ts.CallExpression | undefined {
  if (
    ts.isAsExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isParenthesizedExpression(value)
  )
    return columnCall(value.expression);
  if (!ts.isCallExpression(value)) return undefined;
  if (ts.isIdentifier(value.expression)) return value;
  if (ts.isPropertyAccessExpression(value.expression))
    return columnCall(value.expression.expression);
  return undefined;
}
const candidates: ReferenceCandidate[] = [],
  hashes: Record<string, string> = {};
const semanticName =
  /(?:^|_)(?:actor|operator|user|store|owner|admin|author|initiator|principal|subject|recipient)(?:_|$)|^(?:created_by|updated_by|closed_by_id|export_requested_by)$/;
for (const file of sourceFiles(sourceRoot)) {
  const raw = readFileSync(file, 'utf8'),
    parsed = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    name = relative(backend, file);
  let used = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'mysqlTable' &&
      node.arguments.length >= 2
    ) {
      const [table, columns] = node.arguments;
      if (table && ts.isStringLiteral(table) && columns && ts.isObjectLiteralExpression(columns)) {
        for (const property of columns.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          )
            continue;
          const call = columnCall(property.initializer),
            column = call?.arguments[0];
          if (!call || !column || !ts.isStringLiteral(column) || !ts.isIdentifier(call.expression))
            continue;
          const storage = call.expression.text,
            isJson = storage === 'json';
          if (!semanticName.test(column.text) && !isJson) continue;
          candidates.push({
            file: name,
            line: parsed.getLineAndCharacterOfPosition(property.getStart(parsed)).line + 1,
            table: table.text,
            property: property.name.text,
            column: column.text,
            storage,
            status: isJson
              ? 'json-payload-requires-owner-review'
              : 'unclassified-reference-candidate',
          });
          used = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  if (used) hashes[name] = createHash('sha256').update(raw).digest('hex');
}
process.stdout.write(
  JSON.stringify(
    {
      scope:
        'Static declared ORM columns only; names do not prove operator/store ownership or an exhaustive runtime JSON/external-writer reference graph.',
      destructiveEndpointsImplemented: false,
      sourceHashes: hashes,
      candidates,
    },
    null,
    2,
  ) + '\n',
);
