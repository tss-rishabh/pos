import { describe, expect, it } from 'vitest';
import {
  failedStatement,
  isValueFreeTemplate,
  statementTemplate,
  templateFingerprint,
} from '../../tools/live-readonly/fingerprint.js';
import { assertAggregateOnly, newSummary } from '../../tools/live-readonly/summary.js';

const statement =
  "select /*+ JOIN_ORDER(products, product_store) */ `products`.`id`, case when `products`.`parent_prod_id`=0 then 'x' end from `products` where `products`.`product` like '%Secret tee%' and `products`.`id` > 9007199254740993 and `product_store`.`store_id` = ? order by `products`.`id` asc limit ?";

describe('value-free statement fingerprints', () => {
  it('replaces every string and number literal with ? and drops comments and hints', () => {
    const template = statementTemplate(statement);
    expect(template).toBe(
      'SELECT `products`.`id`, CASE WHEN `products`.`parent_prod_id` = ? THEN ? END FROM `products` WHERE `products`.`product` LIKE ? AND `products`.`id` > ? AND `product_store`.`store_id` = ? ORDER BY `products`.`id` ASC LIMIT ?',
    );
    expect(template).not.toMatch(/Secret|9007199254740993|JOIN_ORDER|'/);
    expect(isValueFreeTemplate(template)).toBe(true);
    // Idempotent: a template is its own template.
    expect(statementTemplate(template)).toBe(template);
  });

  it('gives the same fingerprint for the same shape with different values', () => {
    const other = statement.replace('%Secret tee%', '%other%').replace('9007199254740993', '5');
    expect(templateFingerprint(statementTemplate(other))).toBe(
      templateFingerprint(statementTemplate(statement)),
    );
    expect(templateFingerprint('a')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects anything that still carries a literal or a quote', () => {
    expect(isValueFreeTemplate("SELECT ? FROM `t` WHERE `a` = 'x'")).toBe(false);
    expect(isValueFreeTemplate('SELECT ? FROM `t` WHERE `a` = 5')).toBe(false);
    expect(isValueFreeTemplate('SELECT ? FROM `t` WHERE `a` = "x"')).toBe(false);
    expect(isValueFreeTemplate('SELECT ? FROM `t` WHERE `a` = ?')).toBe(true);
    expect(isValueFreeTemplate('x'.repeat(9000))).toBe(false);
  });

  it('records code, template and plan for a failed statement', () => {
    const failed = failedStatement(statement, 'ER_QUERY_TIMEOUT', {
      accesses: [
        {
          table: 'products',
          access: 'range',
          key: 'PRIMARY',
          rows: 181_046,
          outermost: true,
          driving: true,
        },
      ],
      outermostSortsOrTemporary: false,
    });
    expect(failed.code).toBe('ER_QUERY_TIMEOUT');
    expect(failed.template).toBe(statementTemplate(statement));
    expect(failed.fingerprint).toBe(templateFingerprint(failed.template!));
    expect(JSON.stringify(failed)).not.toMatch(/Secret|9007199254740993/);
  });

  it('lets the evidence carry a template but nothing with a value', () => {
    const summary = newSummary(10_000, 100_000, 'refuse');
    summary.paths.push({
      path: 'catalog-product-barcode',
      status: 'fail',
      reason: 'ER_QUERY_TIMEOUT',
      rows: 0,
      checks: [],
      statements: 1,
      explains: 1,
      downgradedLocks: 0,
      downgradedUpdateLocks: 0,
      refused: 0,
      planRejected: [],
      failedStatements: [failedStatement(statement, 'ER_QUERY_TIMEOUT')],
      durationMs: 10_000,
    });
    expect(() => assertAggregateOnly(summary)).not.toThrow();
    summary.paths[0]!.failedStatements![0]!.template = "SELECT ? FROM `t` WHERE `a` = 'leak'";
    expect(() => assertAggregateOnly(summary)).toThrow(/value-free template/);
    // A template is only exempt from the 200-character rule at that exact field.
    summary.paths[0]!.failedStatements![0]!.template = statementTemplate(statement);
    summary.paths[0]!.reason = statementTemplate(statement);
    expect(() => assertAggregateOnly(summary)).toThrow(/not an aggregate value/);
  });
});
