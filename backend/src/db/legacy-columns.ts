import { entityKind, type ColumnBaseConfig, type ColumnBuilderBaseConfig } from 'drizzle-orm';
import {
  customType,
  MySqlColumnBuilderWithAutoIncrement,
  MySqlColumnWithAutoIncrement,
  type MySqlTable,
} from 'drizzle-orm/mysql-core';

// Column builders whose physical production type differs from the JavaScript
// representation the rewrite has always read and serialised. Each one keeps the
// exact runtime mapping of the Drizzle builder it replaces, so API output is
// unchanged while the declared SQL type matches production DDL
// (tests/orm-metadata.test.ts). See backend/parity/w7-report.md.

type IntBigintBuilderConfig<TName extends string> = {
  name: TName;
  dataType: 'bigint';
  columnType: 'MySqlIntBigint';
  data: bigint;
  driverParam: number | string;
  enumValues: undefined;
};
class MySqlIntBigintBuilder<
  T extends ColumnBuilderBaseConfig<'bigint', 'MySqlIntBigint'>,
> extends MySqlColumnBuilderWithAutoIncrement<T> {
  static override readonly [entityKind]: string = 'MySqlIntBigintBuilder';
  constructor(name: T['name']) {
    super(name, 'bigint', 'MySqlIntBigint');
  }
  /** Called by mysqlTable() at table construction, like every Drizzle builder. */
  build(table: MySqlTable) {
    return new MySqlIntBigint<ColumnBaseConfig<'bigint', 'MySqlIntBigint'>>(table, this.config);
  }
}
class MySqlIntBigint<
  T extends ColumnBaseConfig<'bigint', 'MySqlIntBigint'>,
> extends MySqlColumnWithAutoIncrement<T> {
  static override readonly [entityKind]: string = 'MySqlIntBigint';
  getSQLType() {
    return 'int';
  }
  override mapFromDriverValue(value: number | string): bigint {
    return BigInt(value);
  }
}
/**
 * Physical `int` read as `bigint`, exactly as `bigint({ mode: 'bigint' })` does
 * (`BigInt(driverValue)`). Used for legacy `int` IDs/foreign keys that the rewrite
 * compares with `bigint` IDs. Supports `.autoincrement()` like `int()`.
 */
export function intBigint<TName extends string>(name: TName) {
  return new MySqlIntBigintBuilder<IntBigintBuilderConfig<TName>>(name);
}

/**
 * Physical `tinyint` (display width other than 1) read as `boolean`, exactly as
 * `boolean()` does: a driver boolean is kept and only the number 1 is `true`.
 */
export const tinyintBoolean = customType<{ data: boolean; driverData: number | boolean }>({
  dataType: () => 'tinyint',
  fromDriver: (value) => (typeof value === 'boolean' ? value : value === 1),
});

/**
 * Physical `double` read as a string, exactly as `decimal()` in string mode does
 * (`String(driverValue)` for a driver number). Used for legacy money columns that
 * the rewrite has always handled as strings.
 */
export const doubleString = customType<{ data: string; driverData: number | string }>({
  dataType: () => 'double',
  fromDriver: (value) => (typeof value === 'string' ? value : String(value)),
});

/** Physical `float` read as a string, with the same mapping as {@link doubleString}. */
export const floatString = customType<{ data: string; driverData: number | string }>({
  dataType: () => 'float',
  fromDriver: (value) => (typeof value === 'string' ? value : String(value)),
});

/**
 * Physical `varchar` read and written as an integer, exactly as `int()` does
 * (`Number(driverValue)` for a driver string). Legacy Django declares
 * `store_salesperson.is_active` as `IntegerField` over a `varchar(45)` column
 * (core/models.py:450), so it filters and writes integers.
 */
export const varcharInt = customType<{
  data: number;
  driverData: number | string;
  config: { length: number };
}>({
  dataType: (config) => `varchar(${config?.length ?? 255})`,
  fromDriver: (value) => (typeof value === 'string' ? Number(value) : value),
});

/**
 * Value MySQL stores for an ENUM write under the production empty `sql_mode`: the member
 * the value matches, otherwise the error value `''`. Writing this explicitly keeps rows
 * identical in any mode (AGENTS.md, "Revisions, 19 November 2026").
 *
 * MySQL matches ENUM members by the column collation: the legacy columns are `_ci` and PAD
 * SPACE, so case and trailing spaces are ignored and the member's own spelling is stored.
 * Legacy writes `order_status.order_status` names such as `'Delivered'` into
 * `has_products.status` (helpers/helpers.py:689), which MySQL stores as `'DELIVERED'`; an
 * exact match wrote `''` instead and made every paid line unreturnable (W26, UAT).
 */
export function storedEnumValue<const T extends readonly [string, ...string[]]>(
  values: T,
  value: string,
): T[number] | '' {
  const key = value.replace(/ +$/, '').toLowerCase();
  return (values as readonly string[]).find((member) => member.toLowerCase() === key) ?? '';
}

/**
 * Value MySQL stores for an omitted NOT NULL DATETIME without a default under the
 * production empty `sql_mode`. Legacy raw inserts that omit such a column produce it.
 */
export const legacyZeroDateTime = '0000-00-00 00:00:00';
