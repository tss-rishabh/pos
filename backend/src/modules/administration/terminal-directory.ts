import { and, asc, count, desc, eq, inArray, like, or, sql } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/mysql-core';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Databases } from '../../db/pools.js';
import { PosMachine, PosPaytmMachine, PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import { authenticated } from '../../auth/routes.js';
import { identifier } from '../../domain/validation.js';
import { AppError } from '../../domain/errors.js';
import { assertCurrentOperatorRole, assertCurrentStoreAccess } from './authorization.js';

export const terminalDirectoryInput = z
  .object({
    storeId: identifier.optional(),
    provider: z.enum(['all', 'paytm', 'pine-labs']).default('all'),
    search: z.string().trim().max(100).default(''),
    sort: z
      .enum(['id', 'provider', 'name', 'merchantName', 'storeName', 'terminalId', 'storeId'])
      .default('id'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    start: z.number().int().min(0).max(70000).default(0),
    length: z.number().int().min(1).max(500).default(25),
  })
  .strict();

/** Credential-free source EDC directory. Authorization locks span the primary read. */
export function registerTerminalDirectory(app: FastifyInstance, db: Databases) {
  app.post(
    '/api/v1/admin/payment-terminals/search',
    {
      config: {
        trace: { module: 'administration', resource: 'payment-terminal', action: 'search' },
      },
    },
    async (request, reply) => {
      const user = authenticated(request),
        input = terminalDirectoryInput.parse(request.body);
      z.object({}).strict().parse(request.query);
      const result = await db.get('writer').transaction(async (tx) => {
        const role = await assertCurrentOperatorRole(tx, user.id, [1, 2, 3]);
        const [actor] = await tx
          .select({ userType: PosUser.user_type })
          .from(PosUser)
          .where(eq(PosUser.id, BigInt(user.id)))
          .limit(1);
        const global = role === 1 && actor?.userType === 1;
        let storeIds: number[] | undefined;
        if (input.storeId) {
          await assertCurrentStoreAccess(tx, user.id, input.storeId, [1, 2, 3], 'share');
          storeIds = [Number(input.storeId)];
          if (!Number.isSafeInteger(storeIds[0]) || storeIds[0]! > 2147483647)
            throw new AppError(400, 'TERMINAL_STORE_INVALID', 'Choose a supported terminal store.');
        } else if (!global) {
          const assignments = await tx
            .select({ id: UserStore.store_id })
            .from(UserStore)
            .where(eq(UserStore.django_user_id, BigInt(user.id)))
            .limit(10001)
            .for('share');
          if (assignments.length > 10000)
            throw new AppError(
              503,
              'TERMINAL_SCOPE_UNAVAILABLE',
              'Refresh your store assignments.',
            );
          storeIds = [
            ...new Set(
              assignments.flatMap((row) =>
                row.id === null || row.id < 1n || row.id > 2147483647n ? [] : [Number(row.id)],
              ),
            ),
          ];
          if (actor?.userType === 2 && storeIds.length) {
            const franchises = await tx
              .select({ id: Store.id })
              .from(Store)
              .where(and(inArray(Store.id, storeIds.map(BigInt)), eq(Store.category, 'FRANCHISE')))
              .for('share');
            storeIds = franchises.map((row) => Number(row.id));
          }
          if (!storeIds.length)
            return { data: [], total: 0, start: input.start, length: input.length };
        }
        const primary = db.get('primary');
        const pine = primary
          .select({
            id: PosMachine.id,
            provider: sql<string>`'pine-labs'`.as('provider'),
            name: PosMachine.machine_name,
            merchantName: PosMachine.merchant_name,
            channelId: PosMachine.client_id,
            hardwareId: PosMachine.hardware_id,
            imei: PosMachine.imei_no,
            deviceSerialNumber: sql<string>`'-'`.as('device_serial_number'),
            terminalId: PosMachine.tid,
            merchantId: PosMachine.merchant_id,
            storeCode: PosMachine.merchant_store_pos_code,
            storeName: sql<string>`COALESCE(${Store.store_name}, '')`.as('current_store_name'),
            storeId: PosMachine.store_id,
            active: PosMachine.is_active,
          })
          .from(PosMachine)
          .leftJoin(
            Store,
            and(eq(Store.id, sql`${PosMachine.store_id}`), eq(Store.is_active, true)),
          )
          .where(
            and(
              storeIds ? inArray(PosMachine.store_id, storeIds) : undefined,
              input.provider === 'paytm' ? sql`FALSE` : undefined,
            ),
          );
        const paytm = primary
          .select({
            id: PosPaytmMachine.id,
            provider: sql<string>`'paytm'`.as('provider'),
            name: PosPaytmMachine.machine_name,
            merchantName: PosPaytmMachine.merchant_name,
            channelId: PosPaytmMachine.channel_id,
            hardwareId: PosPaytmMachine.paytm_mid,
            imei: sql<string>`'-'`.as('imei_no'),
            deviceSerialNumber: sql<string>`CAST(${PosPaytmMachine.device_serial_no} AS CHAR)`.as(
              'device_serial_number',
            ),
            terminalId: PosPaytmMachine.paytm_tid,
            // The original placed merchant_key here. Credentials are never a directory field.
            merchantId: PosPaytmMachine.paytm_mid,
            storeCode: sql<string>`'-'`.as('merchant_store_pos_code'),
            storeName: sql<string>`COALESCE(${Store.store_name}, '')`.as('current_store_name'),
            storeId: PosPaytmMachine.store_id,
            active: PosPaytmMachine.is_active,
          })
          .from(PosPaytmMachine)
          .leftJoin(
            Store,
            and(eq(Store.id, sql`${PosPaytmMachine.store_id}`), eq(Store.is_active, true)),
          )
          .where(
            and(
              storeIds ? inArray(PosPaytmMachine.store_id, storeIds) : undefined,
              input.provider === 'pine-labs' ? sql`FALSE` : undefined,
            ),
          );
        const directory = unionAll(pine, paytm).as('terminal_directory');
        const search = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
        const predicate = input.search
          ? or(
              like(directory.name, search),
              like(directory.merchantName, search),
              like(directory.storeName, search),
              like(directory.terminalId, search),
              like(directory.hardwareId, search),
            )
          : undefined;
        const order = input.direction === 'asc' ? asc : desc;
        const [rows, totals] = await Promise.all([
          primary
            .select()
            .from(directory)
            .where(predicate)
            .orderBy(order(directory[input.sort]), order(directory.provider), order(directory.id))
            .limit(input.length)
            .offset(input.start),
          primary.select({ total: count() }).from(directory).where(predicate),
        ]);
        return {
          data: rows.map((row) => ({ ...row, id: String(row.id), storeId: String(row.storeId) })),
          total: totals[0]?.total ?? 0,
          start: input.start,
          length: input.length,
        };
      });
      return reply.header('Cache-Control', 'private, no-store').send(result);
    },
  );
}
