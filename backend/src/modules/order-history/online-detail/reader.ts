import { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import type { Config } from '../../../config.js';
import { AppError } from '../../../domain/errors.js';
import { warehouseService } from '../../warehouse.js';
import { normalizeWarehouseParameters } from '../../warehouse-parameters.js';
import { count } from '../contracts.js';
import { detailIdentifier as positiveId } from './contracts.js';
import { onlineOrderDetailContract } from './contracts.js';
import {
  qualifiedDetailViews,
  readOnlineDetailOptions,
  type OnlineDetailOptions,
  detailPublicationRequired,
} from './options.js';

import {
  qualifyDetailPublication,
  qualifyDetailFact,
  type HistoricalOnlineDetailInput,
  type HistoricalOnlineDetailResult,
} from './qualification.js';
export type { HistoricalOnlineDetailInput, HistoricalOnlineDetailResult } from './qualification.js';
export interface HistoricalOnlineDetailPort {
  read(input: HistoricalOnlineDetailInput): Promise<HistoricalOnlineDetailResult>;
}
export function onlineDetailStatements(options: OnlineDetailOptions) {
  const views = qualifiedDetailViews(options);
  return {
    publication: `SELECT contract_version,generation_id,order_id,customer_id,FORMAT_DATE('%F',business_date) AS business_date,business_timezone,source_complete,source_snapshot_id,source_snapshot_at,source_cdc_watermark,published_at,CAST(source_rows AS STRING) AS source_rows,CAST(warehouse_rows AS STRING) AS warehouse_rows,CAST(source_lines AS STRING) AS source_lines,CAST(warehouse_lines AS STRING) AS warehouse_lines,CAST(source_events AS STRING) AS source_events,CAST(warehouse_events AS STRING) AS warehouse_events,CAST(source_express AS STRING) AS source_express,CAST(warehouse_express AS STRING) AS warehouse_express,source_hash,warehouse_hash FROM \`${views.publications}\` WHERE contract_version=@contract AND order_id=@order AND order_shard=@shard QUALIFY DENSE_RANK() OVER(ORDER BY published_at DESC)=1 LIMIT 2`,
    facts: `SELECT generation_id,order_id,FORMAT_DATE('%F',business_date) AS business_date,IF(BYTE_LENGTH(details_json)<=4000000,details_json,NULL) AS details_json,details_hash FROM \`${views.facts}\` WHERE contract_version=@contract AND order_id=@order AND order_shard=@shard AND generation_id=@generation AND business_date=@date LIMIT 2`,
  };
}
/** Complete hash/count/checkpoint-qualified rich facts; no historical MySQL fallback. */
export function historicalOnlineDetails(
  config: Config,
  options: OnlineDetailOptions = readOnlineDetailOptions(),
  clock: () => number = Date.now,
): HistoricalOnlineDetailPort {
  const query = warehouseService(config).queryReport;
  let sdk: BigQuery | undefined;
  async function execute(
    statement: string,
    params: Record<string, unknown>,
    types: Record<string, string>,
    budget: { spent: bigint },
  ) {
    if (!config.BIGQUERY_PROJECT_ID) throw detailPublicationRequired();
    sdk ??= new BigQuery({
      projectId: config.BIGQUERY_PROJECT_ID,
      location: config.BIGQUERY_LOCATION,
    });
    let estimate: bigint;
    try {
      const [job] = await sdk.createQueryJob({
        query: statement,
        params: normalizeWarehouseParameters(params, types),
        types,
        dryRun: true,
        useLegacySql: false,
        maximumBytesBilled: String(config.BIGQUERY_MAX_BYTES_BILLED),
        jobTimeoutMs: 10000,
        labels: { application: 'pos-rewrite', resource: 'order-detail' },
      });
      estimate = BigInt(
        z
          .object({
            statistics: z.object({
              query: z.object({ totalBytesProcessed: count, statementType: z.literal('SELECT') }),
            }),
          })
          .parse(job.metadata).statistics.query.totalBytesProcessed,
      );
    } catch {
      throw new AppError(
        503,
        'ORDER_DETAIL_ESTIMATE_UNAVAILABLE',
        'The historical order detail budget could not be verified.',
      );
    }
    budget.spent += estimate;
    if (budget.spent > BigInt(config.BIGQUERY_MAX_BYTES_BILLED))
      throw new AppError(422, 'ORDER_DETAIL_TOO_LARGE', 'Select a smaller historical order.');
    return query(statement, params, types, 'order-detail');
  }
  return {
    async read(input) {
      positiveId.parse(input.orderId);
      positiveId.parse(input.customerId);
      const sql = onlineDetailStatements(options),
        budget = { spent: 0n };
      const params = {
          contract: onlineOrderDetailContract,
          order: input.orderId,
          shard: Number(BigInt(input.orderId) % 8192n),
        },
        types = { contract: 'STRING', order: 'STRING', shard: 'INT64' };
      const publication = qualifyDetailPublication(
        await execute(sql.publication, params, types, budget),
        input,
        options,
        clock(),
      );
      const fact = qualifyDetailFact(
        await execute(
          sql.facts,
          { ...params, generation: publication.generation_id, date: publication.business_date },
          { ...types, generation: 'STRING', date: 'DATE' },
          budget,
        ),
        publication,
        input,
      );
      return {
        fact,
        publication: {
          generationId: publication.generation_id,
          sourceSnapshotId: publication.source_snapshot_id,
          sourceSnapshotAt: publication.source_snapshot_at,
          sourceCdcWatermark: publication.source_cdc_watermark,
          publishedAt: publication.published_at,
        },
      };
    },
  };
}
