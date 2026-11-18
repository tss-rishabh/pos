import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const scalar = z.union([z.string().max(4_000_000), z.boolean(), z.null()]);
export const fixtureManifestSchema = z.object({
  version: z.literal(1),
  project: z.literal('tssgcp2025'),
  location: z.literal('asia-south1'),
  nativeSchema: z.string().regex(/^pos_rewrite_order_ui_[a-f0-9]{12}$/),
  nativeSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  maximumBytesBilled: z.string().regex(/^[1-9]\d{0,7}$/),
  maximumRequests: z.number().int().min(1).max(1024),
  // Generated from pinned production statement builders, never learned from traffic.
  allowedStatements: z.array(z.string().min(1).max(200_000)).min(1).max(64),
  tables: z.array(z.object({
    logicalView: z.string().regex(/^tssgcp2025\.synthetic_order_ui\.[a-z][a-z0-9_]{0,62}$/),
    cte: z.string().regex(/^fixture_[a-z][a-z0-9_]{0,54}$/),
    columns: z.record(identifier, z.enum(['STRING', 'INT64', 'BOOL', 'DATE', 'TIMESTAMP', 'DATETIME', 'NUMERIC', 'BIGNUMERIC', 'BYTES', 'FLOAT64'])),
    rows: z.array(z.record(identifier, scalar)).max(2000),
  }).strict()).min(1).max(8),
}).strict();
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** No dataset objects are created. Every table reference becomes owned literals. */
export function compileFixtureStatements(raw: unknown) {
  const manifest = fixtureManifestSchema.parse(raw);
  const cteNames = new Set(manifest.tables.map(table => table.cte));
  const viewNames = new Set(manifest.tables.map(table => table.logicalView));
  if (cteNames.size !== manifest.tables.length || viewNames.size !== manifest.tables.length)
    throw new Error('DUPLICATE_SYNTHETIC_TABLE');
  function assertSelect(statement: string) {
    const syntax = statement.replaceAll('/* order-history-publication */', '');
    if (!/^\s*(?:SELECT|WITH)\b/i.test(syntax) || /;|--|\/\*|\*\//.test(syntax) ||
      /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|MERGE|EXPORT|LOAD|CALL|EXECUTE|TRUNCATE|GRANT|REVOKE|EXTERNAL_QUERY|INFORMATION_SCHEMA)\b/i.test(syntax))
      throw new Error('SELECT_ONLY_SYNTHETIC_QUERY_REQUIRED');
  }
  const allowed = new Set(manifest.allowedStatements.map(statement => {
    assertSelect(statement);
    return hash(statement);
  }));
  const literal = (value: string) => `CAST(FROM_BASE64('${Buffer.from(value).toString('base64')}') AS STRING)`;
  const tables = manifest.tables.map(table => {
    const columns = Object.entries(table.columns);
    if (!columns.length || columns.length > 80) throw new Error('INVALID_SYNTHETIC_COLUMNS');
    const row = (values: Record<string, string | boolean | null> | null) => {
      if (values && (Object.keys(values).length !== columns.length || columns.some(([key]) => !(key in values))))
        throw new Error('INVALID_SYNTHETIC_ROW');
      return 'SELECT ' + columns.map(([key, type]) => {
        const value = values?.[key] ?? null;
        const sql = value === null ? 'NULL' : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : literal(value);
        return `CAST(${sql} AS ${type}) AS \`${key}\``;
      }).join(',') + (values ? '' : ' FROM UNNEST(ARRAY<INT64>[]) AS empty_fixture');
    };
    return table.cte + ' AS (' + (table.rows.length ? table.rows.map(row).join(' UNION ALL ') : row(null)) + ')';
  }).join(',\n');
  return {
    manifest,
    rewrite(statement: string) {
      if (!allowed.has(hash(statement))) throw new Error('UNRECOGNIZED_GENERATED_QUERY');
      assertSelect(statement);
      let result = statement;
      for (const table of manifest.tables) result = result.replaceAll('`' + table.logicalView + '`', table.cte);
      // Fail closed for qualified refs and every unrecognized FROM/JOIN source.
      if (/`[^`]*\.[^`]*`/.test(result)) throw new Error('DATASET_REFERENCE_FORBIDDEN');
      const syntax = result.replaceAll('/* order-history-publication */', '');
      const localNames = new Set(cteNames);
      for (const match of syntax.matchAll(/(?:\bWITH|,)\s*([A-Za-z_]\w*)\s+AS\s*\(/gi)) localNames.add(match[1]!);
      for (const match of syntax.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z0-9_`.:-]+)/gi)) {
        const table = match[1]!.replaceAll('`', '');
        if (!localNames.has(table) && table.toUpperCase() !== 'UNNEST') throw new Error('NONFIXTURE_TABLE_FORBIDDEN');
      }
      const composed = /^\s*WITH\b/i.test(result)
        ? 'WITH ' + tables + ',\n' + result.replace(/^\s*WITH\b/i, '')
        : 'WITH ' + tables + '\n' + result;
      if (Buffer.byteLength(composed) > 1_000_000) throw new Error('SYNTHETIC_QUERY_TOO_LARGE');
      return composed;
    },
  };
}
export function equalCapability(received: string, expected: string) {
  const left = Buffer.from(received), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
