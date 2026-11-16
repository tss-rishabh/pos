import { generatedId } from '../../db/generated-id.js';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosMachine, PosPaytmMachine, Store, StoreCounter } from '../../db/legacy-schema.js';
import { requireRole, requireStore, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { identifier } from '../../domain/validation.js';
import { retryTransaction } from '../../db/retry.js';
import { legacyIntegerReference } from './policies.js';
import type { AdministrationTransaction } from './checkins.js';

export const terminalProvider = z.enum(['paytm', 'pine-labs']);
type TerminalProvider = z.infer<typeof terminalProvider>;
const field = (length: number) => z.string().trim().min(1).max(length);
const common = { active: z.boolean().default(true), destinationStoreId: identifier.optional() };
export const terminalInput = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('paytm'),
      ...common,
      merchantId: field(255),
      terminalId: field(255),
      deviceSerialNumber: z
        .string()
        .regex(/^\d{1,19}$/)
        .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n),
      merchantKey: z.string().min(1).max(255).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('pine-labs'),
      ...common,
      clientId: field(45),
      hardwareId: field(255),
      terminalId: field(45),
      merchantId: field(45),
      merchantStorePosCode: field(45),
      securityToken: z.string().min(1).max(255).optional(),
    })
    .strict(),
]);
type TerminalInput = z.infer<typeof terminalInput>;
export function nextTerminalName(names: string[]): string {
  let highest = 0n;
  for (const name of names) {
    const match = /^\s*machine\s*(\d+)\s*$/i.exec(name);
    if (match) {
      const number = BigInt(match[1]!);
      if (number > highest) highest = number;
    }
  }
  return `Machine ${highest + 1n}`;
}
const normalizedName = (value: string) => value.replace(/\s+/g, '').toLowerCase();
export const isTerminalNameTaken = (name: string, activeNames: string[]) =>
  activeNames.some((value) => normalizedName(value) === normalizedName(name));
const tableFor = (provider: TerminalProvider) =>
  provider === 'paytm' ? PosPaytmMachine : PosMachine;

export function terminalService(config: Config, db: Databases) {
  const now = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  function authorize(user: Principal, storeId: string) {
    requireRole(user, [1, 2, 3]);
    requireStore(user, storeId);
  }
  async function lockedStore(transaction: AdministrationTransaction, storeId: string) {
    const [store] = await transaction
      .select({ id: Store.id, name: Store.store_name })
      .from(Store)
      .where(
        and(
          eq(Store.id, BigInt(storeId)),
          eq(Store.is_active, true),
          inArray(Store.type, ['STORE', 'CORE_WAREHOUSE']),
        ),
      )
      .limit(1)
      .for('update');
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', 'An active sales store was not found.');
    return store;
  }
  async function counter(transaction: AdministrationTransaction, storeId: string) {
    // Source chooses the first counter by PK, including archived counters.
    const [row] = await transaction
      .select({ id: StoreCounter.id })
      .from(StoreCounter)
      .where(eq(StoreCounter.store, BigInt(storeId)))
      .orderBy(asc(StoreCounter.id))
      .limit(1);
    return row ? legacyIntegerReference(row.id) : 0;
  }
  async function names(
    database: AdministrationTransaction | ReturnType<Databases['get']>,
    provider: TerminalProvider,
    storeId: string,
    exclude?: string,
  ) {
    const table = tableFor(provider);
    return database
      .select({ name: table.machine_name, active: table.is_active })
      .from(table)
      .where(
        and(
          eq(table.store_id, legacyIntegerReference(storeId)),
          exclude ? ne(table.id, BigInt(exclude)) : undefined,
        ),
      );
  }
  return {
    async nextName(user: Principal, storeId: string, provider: TerminalProvider) {
      authorize(user, storeId);
      return {
        name: nextTerminalName(
          (await names(db.get('primary'), provider, storeId)).map((row) => row.name),
        ),
      };
    },
    async detail(user: Principal, storeId: string, provider: TerminalProvider, terminalId: string) {
      authorize(user, storeId);
      if (provider === 'paytm') {
        const [row] = await db
          .get('primary')
          .select({
            id: PosPaytmMachine.id,
            name: PosPaytmMachine.machine_name,
            merchantId: PosPaytmMachine.paytm_mid,
            terminalId: PosPaytmMachine.paytm_tid,
            deviceSerialNumber: PosPaytmMachine.device_serial_no,
            active: PosPaytmMachine.is_active,
          })
          .from(PosPaytmMachine)
          .where(
            and(
              eq(PosPaytmMachine.id, BigInt(terminalId)),
              eq(PosPaytmMachine.store_id, legacyIntegerReference(storeId)),
            ),
          )
          .limit(1);
        if (!row) throw new AppError(404, 'TERMINAL_NOT_FOUND', 'Payment terminal was not found.');
        return {
          ...row,
          provider,
          active: row.active === 1,
          deviceSerialNumber: String(row.deviceSerialNumber),
        };
      }
      const [row] = await db
        .get('primary')
        .select({
          id: PosMachine.id,
          name: PosMachine.machine_name,
          clientId: PosMachine.client_id,
          hardwareId: PosMachine.hardware_id,
          terminalId: PosMachine.tid,
          merchantId: PosMachine.merchant_id,
          merchantStorePosCode: PosMachine.merchant_store_pos_code,
          active: PosMachine.is_active,
        })
        .from(PosMachine)
        .where(
          and(
            eq(PosMachine.id, BigInt(terminalId)),
            eq(PosMachine.store_id, legacyIntegerReference(storeId)),
          ),
        )
        .limit(1);
      if (!row) throw new AppError(404, 'TERMINAL_NOT_FOUND', 'Payment terminal was not found.');
      return { ...row, provider, active: row.active === 1 };
    },
    async create(user: Principal, storeId: string, input: TerminalInput) {
      authorize(user, storeId);
      if (input.destinationStoreId && input.destinationStoreId !== storeId)
        throw new AppError(
          400,
          'TERMINAL_STORE_MISMATCH',
          'Choose the store before creating a terminal.',
        );
      if (
        (input.provider === 'paytm' && !input.merchantKey) ||
        (input.provider === 'pine-labs' && !input.securityToken)
      )
        throw new AppError(
          400,
          'TERMINAL_CREDENTIAL_REQUIRED',
          'Provider credentials are required for a new terminal.',
        );
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          const store = await lockedStore(transaction, storeId);
          const name = nextTerminalName(
            (await names(transaction, input.provider, storeId)).map((row) => row.name),
          );
          if (name.length > 255)
            throw new AppError(
              409,
              'TERMINAL_NAME_CAPACITY',
              'Terminal naming capacity has been reached.',
            );
          const counterId = await counter(transaction, storeId),
            timestamp = now(),
            base = {
              store_id: legacyIntegerReference(storeId),
              counter_id: counterId,
              machine_name: name,
              store_name: store.name || storeId,
              is_active: input.active ? 1 : 0,
              created_at: timestamp,
              updated_at: timestamp,
            };
          const inserted =
            input.provider === 'paytm'
              ? await transaction.insert(PosPaytmMachine).values({
                  ...base,
                  merchant_name: 'The Souled Store',
                  merchant_key: input.merchantKey!,
                  paytm_mid: input.merchantId,
                  paytm_tid: input.terminalId,
                  device_serial_no: BigInt(input.deviceSerialNumber),
                  channel_id: '5248589',
                })
              : await transaction.insert(PosMachine).values({
                  ...base,
                  merchant_name: 'The Souled Store Pvt Ltd',
                  client_id: input.clientId,
                  hardware_id: input.hardwareId,
                  imei_no: '0',
                  tid: input.terminalId,
                  merchant_id: input.merchantId,
                  merchant_store_pos_code: input.merchantStorePosCode,
                  security_token: input.securityToken!,
                });
          const id = generatedId(inserted);
          if (!id)
            throw new AppError(
              500,
              'TERMINAL_CREATE_FAILED',
              'Could not create the payment terminal.',
            );
          return {
            id: String(id),
            name,
            status: 'success',
            message:
              input.provider === 'paytm'
                ? 'Paytm Machine added successfully!'
                : 'Pinelab Machine added successfully!',
          };
        }),
      );
    },
    async update(user: Principal, storeId: string, terminalId: string, input: TerminalInput) {
      authorize(user, storeId);
      const target = input.destinationStoreId || storeId;
      authorize(user, target);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          let destinationName = target;
          for (const id of [...new Set([storeId, target])].sort((left, right) =>
            BigInt(left) < BigInt(right) ? -1 : 1,
          )) {
            const store = await lockedStore(transaction, id);
            if (id === target) destinationName = store.name || target;
          }
          const table = tableFor(input.provider);
          const [current] = await transaction
            .select({ id: table.id, name: table.machine_name })
            .from(table)
            .where(
              and(
                eq(table.id, BigInt(terminalId)),
                eq(table.store_id, legacyIntegerReference(storeId)),
              ),
            )
            .limit(1)
            .for('update');
          if (!current)
            throw new AppError(404, 'TERMINAL_NOT_FOUND', 'Payment terminal was not found.');
          const others = await names(transaction, input.provider, target, terminalId);
          const clash =
            input.active &&
            isTerminalNameTaken(
              current.name,
              others.filter((row) => row.active === 1).map((row) => row.name),
            );
          const name =
            target !== storeId || clash
              ? nextTerminalName(others.map((row) => row.name))
              : current.name;
          const base = {
            machine_name: name,
            store_id: legacyIntegerReference(target),
            is_active: input.active ? 1 : 0,
            updated_at: now(),
            ...(target !== storeId
              ? { store_name: destinationName, counter_id: await counter(transaction, target) }
              : {}),
          };
          if (input.provider === 'paytm')
            await transaction
              .update(PosPaytmMachine)
              .set({
                ...base,
                paytm_mid: input.merchantId,
                paytm_tid: input.terminalId,
                device_serial_no: BigInt(input.deviceSerialNumber),
                ...(input.merchantKey ? { merchant_key: input.merchantKey } : {}),
              })
              .where(eq(PosPaytmMachine.id, BigInt(terminalId)));
          else
            await transaction
              .update(PosMachine)
              .set({
                ...base,
                client_id: input.clientId,
                hardware_id: input.hardwareId,
                tid: input.terminalId,
                merchant_id: input.merchantId,
                merchant_store_pos_code: input.merchantStorePosCode,
                ...(input.securityToken ? { security_token: input.securityToken } : {}),
              })
              .where(eq(PosMachine.id, BigInt(terminalId)));
          return {
            id: terminalId,
            name,
            status: 'success',
            message:
              input.provider === 'paytm'
                ? 'Paytm Machine Edited successfully!'
                : 'Pinlab Machine Edited successfully!',
          };
        }),
      );
    },
    async remove(user: Principal, storeId: string, provider: TerminalProvider, terminalId: string) {
      authorize(user, storeId);
      return db.get('writer').transaction(async (transaction) => {
        await lockedStore(transaction, storeId);
        const table = tableFor(provider);
        const [current] = await transaction
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              eq(table.id, BigInt(terminalId)),
              eq(table.store_id, legacyIntegerReference(storeId)),
            ),
          )
          .limit(1)
          .for('update');
        if (!current)
          throw new AppError(404, 'TERMINAL_NOT_FOUND', 'Payment terminal was not found.');
        await transaction.delete(table).where(eq(table.id, BigInt(terminalId)));
        return {
          status: 'success',
          message: provider === 'paytm' ? 'Paytm Machine deleted' : 'Pinelab Machine deleted',
        };
      });
    },
  };
}
