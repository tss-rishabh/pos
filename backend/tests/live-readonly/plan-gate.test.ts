import { describe, expect, it } from 'vitest';
import { planShape, planVerdict, trailingLimit } from '../../tools/live-readonly/plan-gate.js';

/**
 * W16 plan-gate rule. Fixtures keep the MySQL 8 `EXPLAIN FORMAT=JSON` structure (captured on the
 * loopback volume fixture and trimmed to the keys the gate reads).
 */
const limit = 100_000;
const table = (name: string, access: string, rows: number, extra: object = {}) => ({
  table: { table_name: name, access_type: access, rows_examined_per_scan: rows, ...extra },
});
const ordered = (filesort: boolean, loop: object[], extra: object = {}) => ({
  query_block: {
    select_id: 1,
    ordering_operation: { using_filesort: filesort, nested_loop: loop, ...extra },
  },
});
const physical = new Map([
  ['products', 362_092],
  ['product_store', 27_594_003],
  ['stores', 150],
]);
const verdict = (plan: object, rowLimit: number | null) =>
  planVerdict(planShape(plan), rowLimit, (name) => physical.get(name), limit);

// New inventory list / catalog page: products PRIMARY in id order, uq_product_store point reads.
const indexOrdered = ordered(
  false,
  [
    table('products', 'range', 175_895, { key: 'PRIMARY' }),
    table('product_store', 'eq_ref', 1, { key: 'uq_product_store' }),
  ],
  {
    select_list_subqueries: [
      {
        dependent: true,
        query_block: {
          select_id: 2,
          ordering_operation: {
            using_filesort: true,
            table: { table_name: 'products_gs1', access_type: 'ref', rows_examined_per_scan: 1 },
          },
        },
      },
    ],
  },
);
// Store-wide read: product_store ref on store_id, temporary table + filesort over the store.
const storeWide = {
  query_block: {
    select_id: 1,
    ordering_operation: {
      using_temporary_table: true,
      using_filesort: true,
      nested_loop: [
        table('product_store', 'ref', 318_880, { key: 'store_id' }),
        table('products', 'eq_ref', 1),
      ],
    },
  },
};

describe('plan gate: LIMIT-bounded index-ordered scans', () => {
  it('accepts a driving range/ref scan in index order with LIMIT <= 50, and reports it', () => {
    expect(verdict(indexOrdered, 21)).toEqual({
      kind: 'bounded',
      table: 'products',
      access: 'range',
      estimate: 175_895,
    });
    const ref = ordered(false, [
      table('product_store', 'ref', 318_880),
      table('products', 'eq_ref', 1),
    ]);
    expect(verdict(ref, 50).kind).toBe('bounded');
    // A filesort in a dependent subquery over ~1 row does not affect the outer stream.
    expect(planShape(indexOrdered).outermostSortsOrTemporary).toBe(false);
  });

  it('refuses the same scan without a LIMIT, or with LIMIT above 50', () => {
    for (const rowLimit of [null, 51, 1000])
      expect(verdict(indexOrdered, rowLimit)).toMatchObject({
        kind: 'reject',
        code: 'RO_PLAN_ROWS',
        table: 'products',
        estimate: 175_895,
      });
  });

  it('refuses filesorts and temporary tables over more than the row limit', () => {
    expect(verdict(storeWide, 21)).toMatchObject({
      kind: 'reject',
      code: 'RO_PLAN_ROWS',
      table: 'product_store',
      access: 'ref',
    });
    const grouped = {
      query_block: {
        select_id: 1,
        grouping_operation: {
          using_temporary_table: true,
          using_filesort: false,
          nested_loop: [table('product_store', 'ref', 318_880)],
        },
      },
    };
    expect(verdict(grouped, 10).kind).toBe('reject');
    const semijoin = ordered(
      false,
      [
        table('product_store', 'range', 200_000),
        { table: { table_name: 'products_gs1', access_type: 'ref', rows_examined_per_scan: 1 } },
      ],
      { duplicates_removal: { using_temporary_table: true } },
    );
    expect(verdict(semijoin, 10).kind).toBe('reject');
  });

  it('refuses large estimates that are not the driving table of the outermost block', () => {
    const inner = ordered(false, [
      table('stores', 'const', 1),
      table('product_store', 'ref', 318_880),
    ]);
    expect(verdict(inner, 10)).toMatchObject({ kind: 'reject', table: 'product_store' });
    const derived = {
      query_block: {
        select_id: 1,
        nested_loop: [
          {
            table: {
              table_name: '<derived2>',
              access_type: 'ALL',
              rows_examined_per_scan: 21,
              materialized_from_subquery: {
                query_block: {
                  select_id: 2,
                  ordering_operation: {
                    using_filesort: false,
                    nested_loop: [table('product_store', 'ref', 318_880)],
                  },
                },
              },
            },
          },
        ],
      },
    };
    expect(verdict(derived, 21)).toMatchObject({ kind: 'reject', table: 'product_store' });
    const subquery = {
      query_block: {
        select_id: 1,
        ...table('stores', 'const', 1),
        select_list_subqueries: [
          { query_block: { select_id: 2, ...table('product_store', 'ref', 318_880) } },
        ],
      },
    };
    expect(verdict(subquery, 1)).toMatchObject({ kind: 'reject', table: 'product_store' });
    const union = {
      query_block: {
        union_result: {
          using_temporary_table: false,
          query_specifications: [
            { query_block: { select_id: 1, ...table('products', 'range', 175_895) } },
          ],
        },
      },
    };
    expect(verdict(union, 5).kind).toBe('reject');
  });

  it('refuses full table scans and full index scans of large tables even with a LIMIT', () => {
    expect(verdict(ordered(false, [table('products', 'ALL', 362_092)]), 5)).toMatchObject({
      kind: 'reject',
      code: 'RO_PLAN_FULL_SCAN',
      estimate: 362_092,
    });
    // An ALL estimate below the limit still uses the physical table size.
    expect(verdict(ordered(false, [table('products', 'ALL', 10)]), 5)).toMatchObject({
      code: 'RO_PLAN_FULL_SCAN',
      estimate: 362_092,
    });
    expect(verdict(ordered(false, [table('products', 'index', 362_092)]), 5)).toMatchObject({
      code: 'RO_PLAN_ROWS',
    });
    expect(verdict(ordered(false, [table('stores', 'ALL', 150)]), null)).toEqual({
      kind: 'accept',
    });
  });

  it('accepts small plans unchanged', () => {
    expect(
      verdict(
        ordered(true, [table('product_store', 'range', 50_000), table('products', 'eq_ref', 1)]),
        null,
      ),
    ).toEqual({ kind: 'accept' });
  });

  it('rejects EXPLAIN output without a query block', () => {
    expect(() => planShape({})).toThrow();
  });
});

describe('plan gate: trailing LIMIT', () => {
  it('reads a literal or bound trailing LIMIT only', () => {
    expect(trailingLimit('select 1 from t order by id limit 21', [])).toBe(21);
    expect(trailingLimit('select 1 from t where a = ? order by id limit ?', [7, 21])).toBe(21);
    expect(trailingLimit('select 1 from t limit ?', ['11'])).toBe(11);
    expect(trailingLimit('select 1 from t limit ?', [11n])).toBe(11);
    expect(trailingLimit('SELECT 1 FROM t LIMIT 5  ', undefined)).toBe(5);
  });

  it('returns null for OFFSET, two-argument LIMIT, nested LIMIT or a missing value', () => {
    expect(trailingLimit('select 1 from t', [])).toBeNull();
    expect(trailingLimit('select 1 from t limit ? offset ?', [10, 5])).toBeNull();
    expect(trailingLimit('select 1 from t limit 5, 10', [])).toBeNull();
    expect(trailingLimit('select 1 from t where id in (select id from u limit 5)', [])).toBeNull();
    expect(trailingLimit('(select 1 from t) union all (select 2 from u limit 5)', [])).toBeNull();
    expect(trailingLimit('select 1 from t limit ?', [])).toBeNull();
    expect(trailingLimit('select 1 from t limit ?', ['x'])).toBeNull();
    expect(trailingLimit('select 1 from t limit ?', undefined)).toBeNull();
  });
});
