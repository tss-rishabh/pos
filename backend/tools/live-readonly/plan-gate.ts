/**
 * Plan-gate rule for the live read-only suite (W16), as a pure function over
 * `EXPLAIN FORMAT=JSON` so it can be unit-tested without a server.
 *
 * A statement is refused when:
 * - any access is a full table scan (`ALL`) of a table with more than `planRowLimit` rows
 *   (`RO_PLAN_FULL_SCAN`); or
 * - any access estimates more than `planRowLimit` rows per scan (`RO_PLAN_ROWS`), unless that
 *   access is **bounded by LIMIT**. Bounded means all of these hold:
 *   - it is the driving (first) table of the outermost query block, not a subquery, derived
 *     table or UNION member;
 *   - its access type is `range` or `ref`, so rows arrive from an index in index order;
 *   - the outermost block has no filesort and no temporary table anywhere (ordering, grouping,
 *     DISTINCT or semijoin duplicate removal), so rows stream to the client in that order;
 *   - the statement ends with a top-level `LIMIT n` (no OFFSET) where n is at most
 *     `boundedLimit` (50).
 *
 * The server then stops after n result rows, and EXPLAIN's estimate (which ignores LIMIT) is
 * not the cost. A selective filter can still make it read many index entries before n rows
 * match; the session's `MAX_EXECUTION_TIME` bounds that. Filesorts and temporary tables over
 * more than `planRowLimit` rows are always refused.
 */
import { z } from 'zod';

export interface PlanAccess {
  table: string;
  access: string;
  /** `rows_examined_per_scan`. */
  rows: number;
  /** In the outermost query block, outside every subquery, derived table and UNION member. */
  outermost: boolean;
  /** The first table of the outermost block's join order. */
  driving: boolean;
}
export interface PlanShape {
  accesses: PlanAccess[];
  /** A filesort or temporary table in the outermost block. */
  outermostSortsOrTemporary: boolean;
}
export type PlanVerdict =
  | { kind: 'accept' }
  | { kind: 'bounded'; table: string; access: string; estimate: number }
  | {
      kind: 'reject';
      code: 'RO_PLAN_FULL_SCAN' | 'RO_PLAN_ROWS';
      table: string;
      access: string;
      estimate: number;
    };

/** Keys whose value is a nested query block: never part of the outermost block. */
const nestedBlockKeys = new Set([
  'attached_subqueries',
  'select_list_subqueries',
  'optimized_away_subqueries',
  'having_subqueries',
  'order_by_subqueries',
  'group_by_subqueries',
  'update_value_subqueries',
  'materialized_from_subquery',
  'union_result',
  'query_specifications',
]);
const tableNode = z
  .object({
    table_name: z.string(),
    access_type: z.string().optional(),
    rows_examined_per_scan: z.coerce.number().optional(),
  })
  .loose();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the table accesses and the outermost block's sort/temporary flags. */
export function planShape(explainJson: unknown): PlanShape {
  const accesses: PlanAccess[] = [];
  let outermostSortsOrTemporary = false,
    drivingSeen = false;
  const visit = (value: unknown, outermost: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, outermost);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (nestedBlockKeys.has(key)) visit(child, false);
      else if (key === 'table' && isRecord(child)) {
        const parsed = tableNode.safeParse(child);
        if (parsed.success) {
          const driving = outermost && !drivingSeen;
          if (outermost) drivingSeen = true;
          accesses.push({
            table: parsed.data.table_name,
            access: parsed.data.access_type ?? 'NULL',
            rows: parsed.data.rows_examined_per_scan ?? 0,
            outermost,
            driving,
          });
        }
        visit(child, outermost);
      } else if (
        (key === 'using_filesort' || key === 'using_temporary_table') &&
        child === true &&
        outermost
      )
        outermostSortsOrTemporary = true;
      else visit(child, outermost);
    }
  };
  const root = isRecord(explainJson) ? explainJson['query_block'] : undefined;
  if (!isRecord(root)) throw new Error('EXPLAIN FORMAT=JSON has no query_block.');
  visit(root, true);
  return { accesses, outermostSortsOrTemporary };
}

/**
 * The statement's top-level row limit: a trailing `LIMIT n` or `LIMIT ?` (bound to the last
 * value). Anything else (no LIMIT, OFFSET, `LIMIT a, b`, a LIMIT inside trailing parentheses)
 * is `null`.
 */
export function trailingLimit(sql: string, values: unknown): number | null {
  const match = /\blimit\s+(\d+|\?)\s*$/i.exec(sql);
  if (!match) return null;
  if (match[1] !== '?') return Number(match[1]);
  if (!Array.isArray(values) || !values.length) return null;
  const last: unknown = values[values.length - 1];
  const value =
    typeof last === 'number' || typeof last === 'bigint'
      ? Number(last)
      : typeof last === 'string' && /^\d+$/.test(last)
        ? Number(last)
        : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function planVerdict(
  shape: PlanShape,
  limit: number | null,
  physicalRows: (table: string) => number | undefined,
  planRowLimit: number,
  boundedLimit = 50,
): PlanVerdict {
  let bounded: PlanVerdict | undefined;
  for (const access of shape.accesses) {
    if (access.access === 'ALL') {
      const physical = physicalRows(access.table) ?? access.rows;
      if (physical > planRowLimit)
        return {
          kind: 'reject',
          code: 'RO_PLAN_FULL_SCAN',
          table: access.table,
          access: access.access,
          estimate: physical,
        };
    }
    if (access.rows <= planRowLimit) continue;
    if (
      access.outermost &&
      access.driving &&
      (access.access === 'range' || access.access === 'ref') &&
      !shape.outermostSortsOrTemporary &&
      limit !== null &&
      limit <= boundedLimit
    ) {
      bounded = {
        kind: 'bounded',
        table: access.table,
        access: access.access,
        estimate: access.rows,
      };
      continue;
    }
    return {
      kind: 'reject',
      code: 'RO_PLAN_ROWS',
      table: access.table,
      access: access.access,
      estimate: access.rows,
    };
  }
  return bounded ?? { kind: 'accept' };
}
