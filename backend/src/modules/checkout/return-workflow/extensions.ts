import { and, asc, eq } from 'drizzle-orm';
import { Temporal } from '@js-temporal/polyfill';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { ExtendApplicabilityForReturnExchange as Extension } from '../../../db/legacy-schema.js';
import type { Principal } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { fingerprint } from './state.js';
import type { ReturnRepository } from './repository.js';
import {
  returnWindowInputSchema,
  returnWindowScopeSchema,
  type ReturnWindowInput,
  type ReturnWindowScope,
} from './contracts.js';

/** Desired native resource state, not a financial command or refund receipt. */
export function returnWindowExtensions(
  db: Databases,
  config: Pick<Config, 'BUSINESS_TIMEZONE'>,
  options: { repository: Pick<ReturnRepository, 'extensionScope'> },
) {
  const now = () => Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE).toPlainDateTime();
  async function state(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    orderId: string,
    lineId: string,
    input: ReturnWindowScope,
    authority: { deliveredAt: string; periodDays: number },
  ) {
    const rows = await tx
      .select()
      .from(Extension)
      .where(
        and(
          eq(Extension.order_id, BigInt(orderId)),
          eq(Extension.prod_id, BigInt(input.productId)),
          eq(Extension.has_product_id, BigInt(lineId)),
        ),
      )
      .orderBy(asc(Extension.id))
      .limit(2)
      .for('update');
    if (rows.length > 1)
      throw new AppError(
        409,
        'RETURN_EXTENSION_AMBIGUOUS',
        'The existing line extensions need reconciliation.',
      );
    const row = rows[0];
    if (row) {
      try {
        if (!/^[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.extended_date))
          throw new Error();
        Temporal.PlainDateTime.from(row.extended_date.replace(' ', 'T'));
      } catch {
        throw new AppError(
          409,
          'RETURN_EXTENSION_INVALID',
          'The existing extension date needs reconciliation.',
        );
      }
    }
    const revision = fingerprint('return-window.snapshot.v1', {
      operatorId: user.id,
      storeId,
      orderId,
      lineId,
      ...input,
      native: row
        ? {
            id: String(row.id),
            date: row.extended_date,
            active: row.is_active,
            createdBy: String(row.created_by),
            updatedBy: String(row.updated_by),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        : null,
    });
    return {
      row,
      view: {
        orderId,
        lineId,
        productId: input.productId,
        date: row?.extended_date.slice(0, 10) ?? null,
        active: row?.is_active ?? false,
        revision,
        today: now().toPlainDate().toString(),
        windowClosed:
          Math.floor(
            Temporal.PlainDateTime.from(authority.deliveredAt.replace(' ', 'T'))
              .until(now())
              .total('days'),
          ) > authority.periodDays &&
          !(
            row?.is_active &&
            Temporal.PlainDateTime.compare(
              Temporal.PlainDateTime.from(row.extended_date.replace(' ', 'T')),
              now(),
            ) >= 0
          ),
      },
    };
  }
  return {
    async read(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      supplied: ReturnWindowScope,
    ) {
      const input = returnWindowScopeSchema.parse(supplied);
      return db.get('writer').transaction(
        async (tx) => {
          const authority = await options.repository.extensionScope(
            tx,
            user,
            storeId,
            orderId,
            lineId,
            input,
          );
          return (await state(tx, user, storeId, orderId, lineId, input, authority)).view;
        },
        { isolationLevel: 'read committed' },
      );
    },
    async set(
      user: Principal,
      storeId: string,
      orderId: string,
      lineId: string,
      supplied: ReturnWindowInput,
    ) {
      const input = returnWindowInputSchema.parse(supplied),
        scope = returnWindowScopeSchema.parse({
          counterId: input.counterId,
          productId: input.productId,
        });
      return db.get('writer').transaction(
        async (tx) => {
          const actor = await options.repository.extensionScope(
            tx,
            user,
            storeId,
            orderId,
            lineId,
            scope,
          );
          let date: Temporal.PlainDate;
          try {
            date = Temporal.PlainDate.from(input.date);
          } catch {
            throw new AppError(
              422,
              'RETURN_EXTENSION_DATE_INVALID',
              'Select a valid calendar date.',
            );
          }
          if (
            date.year < 1000 ||
            date.year > 9999 ||
            Temporal.PlainDate.compare(date, now().toPlainDate()) < 0
          )
            throw new AppError(
              422,
              'RETURN_EXTENSION_DATE_INVALID',
              'Select today or a future date.',
            );
          const target = date.toString() + ' 23:59:59',
            current = await state(tx, user, storeId, orderId, lineId, scope, actor);
          // Exact replay sets no additional state, even after a lost reply.
          if (current.row?.is_active && current.row.extended_date === target) return current.view;
          if (current.view.revision !== input.expectedRevision)
            throw new AppError(
              409,
              'RETURN_EXTENSION_CHANGED',
              'The extension changed. Read its current date before saving again.',
            );
          const timestamp = now().toString({ smallestUnit: 'second' }).replace('T', ' ');
          if (current.row)
            await tx
              .update(Extension)
              .set({
                extended_date: target,
                is_active: true,
                updated_by: actor.nativeActorId,
                updated_at: timestamp,
              })
              .where(eq(Extension.id, current.row.id));
          else
            await tx.insert(Extension).values({
              order_id: BigInt(orderId),
              prod_id: BigInt(input.productId),
              has_product_id: BigInt(lineId),
              extended_date: target,
              is_active: true,
              created_by: actor.nativeActorId,
              updated_by: actor.nativeActorId,
              created_at: timestamp,
              updated_at: timestamp,
            });
          return (await state(tx, user, storeId, orderId, lineId, scope, actor)).view;
        },
        { isolationLevel: 'read committed' },
      );
    },
  };
}
