import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError, unavailable } from '../domain/errors.js';
import { Temporal } from '@js-temporal/polyfill';
import { normalizeWarehouseParameters } from './warehouse-parameters.js';
import {
  dailyWarehouseOptions,
  readDailyWarehouseRollups,
  type DailyWarehouseOptions,
} from './daily-report-warehouse.js';

const records = z.array(z.record(z.string(), z.unknown()));
export function warehouseService(
  config: Config,
  dailyOptions?: DailyWarehouseOptions,
  clock = () => Temporal.Now.instant(),
) {
  let client: BigQuery | undefined;
  async function query(
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string | string[]>,
    resource = 'report',
  ) {
    if (!config.BIGQUERY_PROJECT_ID) return unavailable('BigQuery project');
    client ??= new BigQuery({
      projectId: config.BIGQUERY_PROJECT_ID,
      location: config.BIGQUERY_LOCATION,
    });
    try {
      const response: unknown = await client.query({
        query: statement,
        params: normalizeWarehouseParameters(params, types),
        types,
        useLegacySql: false,
        maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
        jobTimeoutMs: 10000,
        labels: { application: 'pos-rewrite', resource },
      });
      const tuple = z.array(z.unknown()).parse(response);
      return records.parse(tuple[0]);
    } catch {
      throw new AppError(
        503,
        'WAREHOUSE_UNAVAILABLE',
        'Historical reports are temporarily unavailable.',
      );
    }
  }
  async function dimensions(
    table: string | undefined,
    column: 'Footfall' | 'Target',
    names: string[],
    from: string,
    to: string,
  ) {
    if (!table || !names.length) return {};
    const rows = await query(
      `SELECT \`Store Name\` AS store_name, \`Date\` AS date,SUM(\`${column}\`) AS value FROM \`${table}\` WHERE \`Store Name\` IN UNNEST(@storeNames) AND \`Date\` BETWEEN @start AND @end GROUP BY store_name,date`,
      { storeNames: [...new Set(names)].sort(), start: from, end: to },
      { storeNames: ['STRING'], start: 'DATE', end: 'DATE' },
    );
    const result: Record<string, number> = {};
    for (const row of rows) {
      const name = z.string().parse(row.store_name);
      const date = warehouseScalar(row.date);
      const value = Number(warehouseScalar(row.value));
      if (name && Number.isFinite(value)) result[`${name.trim()}\0${date}`] = value;
    }
    return result;
  }
  async function queryReport(
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string | string[]>,
    resource = 'report',
  ) {
    if (!/^\s*(SELECT|WITH)\b/i.test(statement) || !/^[a-z][a-z0-9_-]{0,62}$/.test(resource))
      throw new AppError(
        500,
        'INVALID_REPORT_DEFINITION',
        'Report definition and resource must be read-only and valid.',
      );
    const rows = await query(statement, params, types, resource);
    if (rows.length > 70000)
      throw new AppError(422, 'REPORT_TOO_LARGE', 'Select fewer stores or dates.');
    return rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([key, value]) => [key, warehouseScalar(value)])),
    );
  }
  return {
    queryReport,
    async dailyRollups(storeIds: string[], from: string, to: string) {
      return readDailyWarehouseRollups(
        config,
        dailyOptions || dailyWarehouseOptions(),
        queryReport,
        storeIds,
        from,
        to,
        clock(),
      );
    },
    async auxiliary(names: string[], from: string, to: string) {
      const [footfall, target] = await Promise.all([
        dimensions(config.BIGQUERY_FOOTFALL_TABLE, 'Footfall', names, from, to),
        dimensions(config.BIGQUERY_TARGETS_TABLE, 'Target', names, from, to),
      ]);
      return { footfall, target };
    },
  };
}
export function warehouseScalar(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'value' in value) return value.value;
  return value;
}
