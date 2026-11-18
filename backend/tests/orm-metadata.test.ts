import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import { format, resolveConfig } from 'prettier';
import { expect, it } from 'vitest';
import { z } from 'zod';
import * as legacy from '../src/db/legacy-schema.js';
import { goldenStdout } from './golden/load.js';

it('keeps verified BIGINT identifiers lossless and preserves fractional/string physical values', () => {
  const metadata = z
    .object({
      tables: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    })
    .parse(JSON.parse(readFileSync('evidence/mysql-schema.json', 'utf8')) as unknown);
  const failures: string[] = [];
  // A source IntegerField intentionally decodes this physical VARCHAR binary
  // assignment flag to its numeric API representation.
  const numericStatusFields = new Set(['store_salesperson.is_active']);
  for (const table of Object.values(legacy)) {
    const config = getTableConfig(table),
      observed = metadata.tables[config.name];
    if (!observed) {
      failures.push(`${config.name}: missing verified table`);
      continue;
    }
    for (const column of config.columns) {
      const actual = observed.find((value) => value.name === column.name);
      if (!actual) {
        failures.push(`${config.name}.${column.name}: missing verified column`);
        continue;
      }
      if (/^bigint\b/.test(actual.type) && !['bigint', 'boolean'].includes(column.dataType))
        failures.push(`${config.name}.${column.name}: unsafe integer decoder`);
      if (/^(?:float|double|decimal)\b/.test(actual.type) && column.dataType === 'bigint')
        failures.push(
          `${config.name}.${column.name}: fractional values would be coerced to integers`,
        );
      if (
        /^(?:varchar|text)\b/.test(actual.type) &&
        ['bigint', 'number'].includes(column.dataType) &&
        !numericStatusFields.has(`${config.name}.${column.name}`)
      )
        failures.push(`${config.name}.${column.name}: textual values would be coerced to numbers`);
    }
  }
  expect(failures).toEqual([]);
  expect(legacy.StoreSalesPerson.is_active.mapFromDriverValue('1')).toBe(1);
  expect(legacy.StoreSalesPerson.is_active.mapFromDriverValue('0')).toBe(0);
  expect(
    getTableConfig(legacy.Order).columns.find((column) => column.name === 'voucher_amt_used')
      ?.dataType,
  ).toBe('number');
  expect(
    getTableConfig(legacy.PosOnlineOrder).columns.find((column) => column.name === 'created_by')
      ?.dataType,
  ).toBe('string');
});
it('reproduces the checked ORM mappings from pinned source and physical metadata without rewriting inputs', async () => {
  const path = 'src/db/legacy-schema.ts',
    generated = goldenStdout('core', 'orm-metadata'),
    formatted = await format(generated, { ...(await resolveConfig(path)), parser: 'typescript' });
  expect(formatted).toBe(readFileSync(path, 'utf8'));
});
