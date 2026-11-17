import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { amount, minorUnits } from '../../domain/money.js';
import { authorizeLegacyOrderImport, authorizeLegacyOrderImportActor } from './authorization.js';
import { offlineOrderColumns, shopifyOrderColumns } from './csv.js';
import {
  importCapabilitiesSchema,
  importJobSchema,
  importPreviewSchema,
  importResultSchema,
  importResumptionSchema,
} from './domain.js';
import type { ImportFinancialAdapter } from './financial-contracts.js';
import { legacyOrderImportHistory, readLegacyOrderImportHistoryOptions } from './history.js';
import {
  legacyOrderImportContract,
  readLegacyOrderImportOptions,
  type LegacyOrderImportOptions,
} from './options.js';
import { prepareLegacyOrderImport } from './preparation.js';
import { legacyOrderImportRepository } from './repository.js';

export interface LegacyOrderImportRegistrationOptions {
  runtime?: LegacyOrderImportOptions;
  adapter?: ImportFinancialAdapter;
  history?: Pick<ReturnType<typeof legacyOrderImportHistory>, 'detail' | 'results'>;
}
export function legacyOrderImportService(
  config: Config,
  db: Databases,
  options: LegacyOrderImportRegistrationOptions = {},
) {
  const runtime = options.runtime ?? readLegacyOrderImportOptions(),
    key = runtime.LEGACY_ORDER_IMPORT_ENCRYPTION_KEY_V1,
    ready =
      runtime.LEGACY_ORDER_IMPORT_CONTRACT === legacyOrderImportContract &&
      Boolean(key && options.adapter),
    history =
      options.history ?? legacyOrderImportHistory(config, readLegacyOrderImportHistoryOptions()),
    repository = key ? legacyOrderImportRepository(db, { secret: key, history }) : null;
  function permitted(user: Principal) {
    if (![1, 2, 3].includes(user.role) || user.userType !== 1)
      throw new AppError(
        403,
        'ORDER_IMPORT_ACCESS_DENIED',
        'Historical order imports require internal administration access.',
      );
    return user.id;
  }
  async function authorize(user: Principal) {
    const actor = permitted(user);
    await db.get('writer').transaction((tx) => authorizeLegacyOrderImportActor(tx, actor));
    return actor;
  }
  function configuredRepository() {
    if (!repository)
      throw new AppError(
        503,
        'ORDER_IMPORT_KEY_UNAVAILABLE',
        'Order import recovery is not configured.',
      );
    return repository;
  }
  return {
    ready,
    runtime,
    async capabilities(user: Principal) {
      await authorize(user);
      return importCapabilitiesSchema.parse({
        ready,
        canPreview: true,
        kinds: ['offline', 'shopify'],
        maximumFileBytes: 5242880,
        maximumRows: 50000,
        maximumStores: 100,
      });
    },
    async template(user: Principal, kind: 'offline' | 'shopify') {
      await authorize(user);
      return (
        '\uFEFF' +
        (kind === 'offline' ? offlineOrderColumns : shopifyOrderColumns).join(',') +
        '\r\n'
      );
    },
    async preview(user: Principal, value: unknown) {
      const actor = permitted(user),
        prepared = prepareLegacyOrderImport(value);
      await db
        .get('writer')
        .transaction((tx) => authorizeLegacyOrderImport(tx, actor, prepared.scopes));
      const dates = prepared.plans.map((plan) => plan.createdAt.slice(0, 10)).sort(),
        tender = prepared.plans.reduce(
          (sum, plan) => sum + minorUnits(plan.originalTenderAmount),
          0n,
        ),
        units = prepared.plans.reduce(
          (sum, plan) => sum + plan.lines.reduce((total, line) => total + line.quantity, 0),
          0,
        );
      return importPreviewSchema.parse({
        id: prepared.input.id,
        kind: prepared.input.kind,
        totalOrders: prepared.plans.length,
        totalUnits: units,
        lineValue: amount(tender),
        scopes: prepared.scopes,
        earliestBusinessDate: dates[0],
        latestBusinessDate: dates.at(-1),
      });
    },
    async stage(user: Principal, requestId: string, value: unknown) {
      const actor = permitted(user);
      if (!ready)
        throw new AppError(
          503,
          'ORDER_IMPORT_CONTRACT_UNVERIFIED',
          'Historical order processing is not enabled. The file has not been queued.',
        );
      return importJobSchema.parse(await configuredRepository().stage(actor, requestId, value));
    },
    async detail(user: Principal, jobId: string) {
      return importJobSchema.parse(
        await configuredRepository().detail(permitted(user), z.uuid().parse(jobId)),
      );
    },
    async results(user: Principal, jobId: string, after: number, limit: number) {
      const data = z
        .array(importResultSchema)
        .parse(
          await configuredRepository().results(
            permitted(user),
            z.uuid().parse(jobId),
            after,
            limit,
          ),
        );
      return { data, nextAfter: data.length === limit ? data.at(-1)!.sequence : null };
    },
    async cancel(user: Principal, jobId: string) {
      return importJobSchema.parse(
        await configuredRepository().cancel(permitted(user), z.uuid().parse(jobId)),
      );
    },
    async resume(user: Principal, jobId: string, operationId: string, requestId: string) {
      const actor = permitted(user);
      if (!ready)
        throw new AppError(
          503,
          'ORDER_IMPORT_CONTRACT_UNVERIFIED',
          'Historical order processing is not enabled. The import has not been resumed.',
        );
      return importResumptionSchema.parse(
        await configuredRepository().resume(actor, jobId, operationId, requestId),
      );
    },
    async readResumption(user: Principal, jobId: string, operationId: string) {
      return importResumptionSchema.parse(
        await configuredRepository().readResumption(permitted(user), jobId, operationId),
      );
    },
    async runOne() {
      if (!ready || !options.adapter) return null;
      return configuredRepository().runOne(options.adapter);
    },
  };
}
export type LegacyOrderImportService = ReturnType<typeof legacyOrderImportService>;
