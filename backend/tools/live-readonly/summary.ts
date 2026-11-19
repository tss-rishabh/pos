/**
 * Aggregate, non-PII summary of a live read-only run. Only counts, table/column names, column
 * types, statuses, error codes and timings are recorded; never a row value, credential, host or
 * server error message.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { backendRoot, type PlanRejection } from './connection.js';

export type PathStatus = 'pass' | 'fail' | 'skip';
export interface ColumnDrift {
  column: string;
  /** Which INFORMATION_SCHEMA attributes differ, e.g. COLUMN_TYPE, or `missing`/`extra`. */
  attributes: string[];
  snapshotType?: string;
  liveType?: string;
}
export interface TableDrift {
  table: string;
  missing: boolean;
  columns: ColumnDrift[];
  createTableDiffers: boolean;
}
export interface PathResult {
  path: string;
  status: PathStatus;
  /** Error code or skip reason code; never a message. */
  reason?: string;
  rows: number;
  checks: string[];
  statements: number;
  explains: number;
  downgradedLocks: number;
  /** Of `downgradedLocks`, trailing FOR UPDATE clauses (authorization confirmation reads). */
  downgradedUpdateLocks: number;
  refused: number;
  planRejected: PlanRejection[];
  durationMs: number;
}
export interface LiveSummary {
  suite: 'pos-live-readonly-v1';
  startedAt: string;
  finishedAt?: string;
  serverVersion?: string;
  settings: {
    sessionReadOnly: boolean;
    maxExecutionMs: number;
    planRowLimit: number;
    lockingReads: 'downgrade' | 'refuse';
    multipleStatements: false;
  };
  schema?: {
    /** `exact`, or `cross-version` when the live server version differs from the snapshot's. */
    ddlComparison: 'exact' | 'cross-version';
    snapshotServerVersion: string;
    tablesChecked: number;
    tablesMatching: number;
    drift: TableDrift[];
  };
  paths: PathResult[];
  totals: {
    pass: number;
    fail: number;
    skip: number;
    statements: number;
    explains: number;
    downgradedLocks: number;
    downgradedUpdateLocks: number;
    refused: number;
    planRejected: number;
  };
}

export function newSummary(
  maxExecutionMs: number,
  planRowLimit: number,
  lockingReads: 'downgrade' | 'refuse' = 'downgrade',
): LiveSummary {
  return {
    suite: 'pos-live-readonly-v1',
    startedAt: new Date().toISOString(),
    settings: {
      sessionReadOnly: false,
      maxExecutionMs,
      planRowLimit,
      lockingReads,
      multipleStatements: false,
    },
    paths: [],
    totals: {
      pass: 0,
      fail: 0,
      skip: 0,
      statements: 0,
      explains: 0,
      downgradedLocks: 0,
      downgradedUpdateLocks: 0,
      refused: 0,
      planRejected: 0,
    },
  };
}

export function finishSummary(summary: LiveSummary): LiveSummary {
  summary.finishedAt = new Date().toISOString();
  const totals = summary.totals;
  for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = 0;
  for (const path of summary.paths) {
    totals[path.status] += 1;
    totals.statements += path.statements;
    totals.explains += path.explains;
    totals.downgradedLocks += path.downgradedLocks;
    totals.downgradedUpdateLocks += path.downgradedUpdateLocks;
    totals.refused += path.refused;
    totals.planRejected += path.planRejected.length;
  }
  return summary;
}

/** Only these characters may appear in a free-text summary field (codes, names, types). */
const safeText = /^[A-Za-z0-9_ .:,()'<>/=+-]*$/;
/** Rejects any string field that is not a code, name, type or timestamp, before it is printed. */
export function assertAggregateOnly(summary: LiveSummary): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value.length > 200 || !safeText.test(value))
        throw new Error(`Summary field ${path} is not an aggregate value.`);
      return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  };
  visit(summary, 'summary');
}

/**
 * Writes `live-readonly-<date>.json` (or `-2`, `-3`, … when that exists) with exclusive create, so
 * an existing evidence file is never overwritten. Returns the path written.
 */
export function writeEvidence(summary: LiveSummary, directory?: string): string {
  assertAggregateOnly(summary);
  const target = resolve(directory ?? join(backendRoot, 'evidence'));
  mkdirSync(target, { recursive: true });
  const date = summary.startedAt.slice(0, 10);
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const path = join(target, `live-readonly-${date}${attempt === 1 ? '' : `-${attempt}`}.json`);
    try {
      writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx' });
      return path;
    } catch (error) {
      if (z.object({ code: z.literal('EEXIST') }).safeParse(error).success) continue;
      throw error;
    }
  }
  throw new Error('Too many evidence files for this date.');
}
