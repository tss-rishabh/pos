/**
 * @deprecated Temporary compatibility for W8-owned administration MySQL tests only.
 *
 * The schema freeze deleted the rewrite migration runner, its journal and every non-administration
 * migration file. Nothing in `src` imports this module and nothing applies these files at runtime.
 * `tests/administration/{collections,creator-authority,store-default-operators}.mysql.test.ts`
 * still import these two names. Delete this file when W8 removes those imports and the
 * administration SQL files listed below.
 */
export const migrationPaths: readonly string[] = [
  'src/modules/administration/migration.sql',
  'src/modules/administration/media-migration.sql',
  'src/modules/administration/settings-migration.sql',
  'src/modules/administration/ecommerce-sync/migration.sql',
  'src/modules/administration/import-migration.sql',
  'src/modules/administration/parent-store-imports/migration.sql',
  'src/modules/administration/mfa-migration.sql',
  'src/modules/administration/store-image-migration.sql',
  'src/modules/administration/access-migration.sql',
  'src/modules/administration/slack-migration.sql',
  'src/modules/administration/barcodes/migration.sql',
];

/** Splits an SQL script into statements (no DELIMITER or stored routines). */
export function splitMigration(source: string): string[] {
  const statements: string[] = [];
  let current = '',
    quote = '',
    lineComment = false,
    blockComment = false;
  for (let i = 0; i < source.length; i++) {
    const character = source[i]!,
      next = source[i + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        current += '\n';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        i++;
        current += ' ';
      }
      continue;
    }
    if (quote) {
      current += character;
      if (character === '\\' && next !== undefined) {
        current += next;
        i++;
        continue;
      }
      if (character === quote) {
        if (next === quote) {
          current += next;
          i++;
        } else quote = '';
      }
      continue;
    }
    if (character === '-' && next === '-' && /\s/.test(source[i + 2] || ' ')) {
      lineComment = true;
      i++;
      continue;
    }
    if (character === '#') {
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else current += character;
  }
  if (quote || blockComment) throw new Error('INVALID_MIGRATION_SQL');
  if (current.trim()) statements.push(current.trim());
  return statements;
}
