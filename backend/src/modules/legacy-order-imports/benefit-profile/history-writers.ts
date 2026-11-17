import { createHash } from 'node:crypto';
import { z } from 'zod';
import { couponPublicationError } from './history-publication.js';

/** Review-only legacy trigger installation. The application migration runner
 * must never install these triggers or seed legacy data automatically. */
const table = 'pos_rewrite_coupon_history_heads';
type Table = 'orders' | 'order_coupon_log' | 'coupons' | 'users';
type Event = 'INSERT' | 'UPDATE' | 'DELETE';
export interface CouponHistoryWriterDefinition {
  name: string;
  table: Table;
  event: Event;
  timing: 'AFTER';
  statement: string;
}

function definition(source: Table, event: Event): CouponHistoryWriterDefinition {
  const images = event === 'INSERT' ? ['NEW'] : event === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
  const selects =
    source === 'coupons'
      ? [
          "SELECT 'controls' AS kind, 0 AS scope_id",
          ...images.map((image) => `SELECT 'coupon' AS kind, ${image}.id AS scope_id`),
        ]
      : source === 'users'
        ? ["SELECT 'customer' AS kind, NEW.id AS scope_id"]
        : images.flatMap((image) =>
            source === 'orders'
              ? [
                  `SELECT 'coupon' AS kind, ${image}.coupon_used AS scope_id`,
                  `SELECT 'customer' AS kind, ${image}.user_id AS scope_id`,
                ]
              : [`SELECT 'customer' AS kind, ${image}.user_id AS scope_id`],
          );
  return {
    name: 'pos_rewrite_coupon_history_' + source + '_' + event.toLowerCase(),
    table: source,
    event,
    timing: 'AFTER',
    statement: `BEGIN
INSERT INTO ${table}(kind,scope_id,revision)
SELECT kind,CAST(scope_id AS CHAR),1 FROM (${selects.join('\nUNION\n')}) AS affected
WHERE scope_id IS NOT NULL AND (kind='controls' OR scope_id>0)
ORDER BY kind,scope_id
ON DUPLICATE KEY UPDATE revision=revision+1;
END`,
  };
}
export const couponHistoryWriterDefinitions: readonly CouponHistoryWriterDefinition[] =
  Object.freeze(
    (['orders', 'order_coupon_log', 'coupons'] as const)
      .flatMap((source) =>
        (['INSERT', 'UPDATE', 'DELETE'] as const).map((event) =>
          Object.freeze(definition(source, event)),
        ),
      )
      .concat(Object.freeze(definition('users', 'INSERT'))),
  );
function normalized(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}
export const couponHistoryWritersDefinitionHash = createHash('sha256')
  .update(
    JSON.stringify(
      couponHistoryWriterDefinitions.map((value) => ({
        ...value,
        statement: normalized(value.statement),
      })),
    ),
  )
  .digest('hex');

/** Metadata is checked against all ten actual bodies; a settings flag or a
 * manually asserted all-writers contract cannot replace installed coverage. */
export function assertCouponHistoryWriterDefinitions(input: unknown) {
  const row = z
    .object({
      name: z.string().max(100),
      table: z.string().max(100),
      event: z.string().max(10),
      timing: z.string().max(10),
      statement: z.string().max(10000),
    })
    .strict();
  if (!Array.isArray(input) || input.length !== couponHistoryWriterDefinitions.length)
    throw couponPublicationError('WRITERS_UNQUALIFIED', 503);
  const actual = z.array(row).length(10).safeParse(input);
  if (!actual.success || new Set(actual.data.map((value) => value.name)).size !== 10)
    throw couponPublicationError('WRITERS_UNQUALIFIED', 503);
  for (const expected of couponHistoryWriterDefinitions) {
    const value = actual.data.find((value) => value.name === expected.name);
    if (
      !value ||
      value.table !== expected.table ||
      value.event !== expected.event ||
      value.timing !== expected.timing ||
      normalized(value.statement) !== normalized(expected.statement)
    )
      throw couponPublicationError('WRITERS_UNQUALIFIED', 503);
  }
  return couponHistoryWritersDefinitionHash;
}

export function couponHistoryWritersReviewSql() {
  return `-- REVIEW ONLY. No application migration, live DDL or cutover is authorized here.
-- Install every trigger, seed existing keys and qualify the installed bodies
-- before selecting the producer. Historical eligibility still reads BigQuery.
CREATE TABLE IF NOT EXISTS ${table} (
 kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 scope_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision BIGINT UNSIGNED NOT NULL,
 PRIMARY KEY(kind,scope_id)
) ENGINE=InnoDB;

DELIMITER $$
${couponHistoryWriterDefinitions
  .map(
    (value) =>
      `CREATE TRIGGER ${value.name} AFTER ${value.event} ON ${value.table}\nFOR EACH ROW ${value.statement}$$`,
  )
  .join('\n\n')}
DELIMITER ;

INSERT IGNORE INTO ${table}(kind,scope_id,revision) VALUES('controls','0',0);
INSERT IGNORE INTO ${table}(kind,scope_id,revision)
 SELECT 'coupon',CAST(id AS CHAR),0 FROM coupons WHERE id>0;
INSERT IGNORE INTO ${table}(kind,scope_id,revision)
 SELECT 'customer',CAST(id AS CHAR),0 FROM users WHERE id>0;
UPDATE ${table} SET revision=revision+1 WHERE kind='controls' AND scope_id='0';
-- Seed after trigger installation. IGNORE retains any revision already
-- advanced by a concurrent mutation; it must never reset an existing head.
`;
}
