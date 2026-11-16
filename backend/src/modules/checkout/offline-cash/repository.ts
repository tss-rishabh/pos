import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, or, sql, sum } from 'drizzle-orm';
import type { Config } from '../../../config.js';
import type { Databases } from '../../../db/pools.js';
import { retryTransaction } from '../../../db/retry.js';
import { MUser, PosUser, ProductStore, Store, StoreDayClose } from '../../../db/legacy-schema.js';
import { currentAuthenticationVersion } from '../../../auth/revocation.js';
import { requireRole, requireStore, type Principal, type Role } from '../../../domain/access.js';
import { AppError } from '../../../domain/errors.js';
import { activeCheckoutCustomer } from '../customer-access.js';
import { checkInService, type AdministrationTransaction } from '../../administration/checkins.js';
import {
  assertCurrentOperatorRole,
  assertCurrentStoreAccess,
} from '../../administration/authorization.js';
import { currentRequestTrace } from '../../../observability/context.js';
import { cashDigest, verifyCashAuthorizationWithKey, verifyDeviceCashReceipt } from './crypto.js';
import { assertCashReceipt, assertCashSnapshot } from './domain.js';
import {
  cashImportApprovalDetailsSchema,
  cashImportApprovalInputSchema,
  cashOrderImportInputSchema,
  offlineCashOrderTimestamp,
  type CashImportApprovalInput,
  type CashOrderImportInput,
} from './attribution.js';
import { writeCashOrder, type CashImportWriterOptions } from './writer.js';
import { assertOfflineCashImportProofs } from './import-proof.js';
import { templateDecimal, type CashSourceTemplate } from './template.js';
import { retainCashSigningKey } from './signing-keys.js';
import {
  cashPriceSnapshotSchema,
  cashReceiptAcceptanceSchema,
  devicePublicKeySchema,
  signedCashAuthorizationSchema,
  signedCashReceiptSchema,
  cashConflictSchema,
  type CashConflict,
  type CashPriceSnapshot,
  type DevicePublicKey,
  type SignedCashAuthorization,
  type SignedCashReceipt,
} from './contracts.js';
import {
  offlineCashAuthorizations,
  offlineCashCloseImpacts,
  offlineCashDevices,
  offlineCashEvents,
  offlineCashReceipts,
  offlineCashReceiptLines,
  offlineCashSigningKeys,
} from './schema.js';

type ReceiptRecord = typeof offlineCashReceipts.$inferSelect;
export function publicOfflineCashReceipt(row: ReceiptRecord, importedAt: number | null = null) {
  if (row.status === 'imported' && importedAt === null)
    throw new AppError(
      503,
      'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
      'The imported cash receipt requires verified order evidence.',
    );
  return cashReceiptAcceptanceSchema.parse({
    receiptId: row.id,
    receiptNumber: row.receiptNumber,
    operatorId: row.operatorId,
    storeId: row.storeId,
    counterId: row.counterId,
    businessDate: row.businessDate,
    completedAt: row.completedAt,
    acceptedAt: row.acceptedAt,
    importedAt,
    payableCents: row.payableCents,
    cashReceivedCents: row.cashReceivedCents,
    changeCents: row.changeCents,
    status: row.status,
    conflicts: JSON.parse(row.conflicts) as unknown,
    orderId: row.orderId,
    version: row.version,
  });
}
export interface OfflineCashRepositoryOptions {
  verifyAuthorization: (envelope: SignedCashAuthorization) => boolean;
  authorizationPublicKey?: () => DevicePublicKey;
  assertCheckIn?: (
    operatorId: string,
    storeId: string,
    counterId: string | undefined,
    tx: AdministrationTransaction,
  ) => Promise<void>;
  currentRole?: (tx: AdministrationTransaction, user: Principal) => Promise<Role>;
  assertStoreAccess?: (
    tx: AdministrationTransaction,
    operatorId: string,
    storeId: string,
  ) => Promise<void>;
  sourceImportReady?: boolean;
  authenticationVersion?: (
    tx: AdministrationTransaction,
    operatorId: string,
  ) => Promise<string | null>;
  operatorCustomer?: (tx: AdministrationTransaction, operatorId: string) => Promise<string | null>;
  clock?: () => number;
}

export function offlineCashRepository(
  db: Databases,
  config: Config,
  options: OfflineCashRepositoryOptions,
) {
  const clock = options.clock || Date.now,
    checkins = checkInService(db, config);
  const checkIn =
    options.assertCheckIn ||
    ((operatorId, storeId, counterId, tx) =>
      checkins.assertCheckIn(operatorId, storeId, counterId, tx));
  const role =
    options.currentRole || ((tx, user) => assertCurrentOperatorRole(tx, user.id, [1, 2, 3, 4, 5]));
  const authenticationVersion =
    options.authenticationVersion ||
    (async (tx, operatorId) => {
      const [account] = await tx
        .select()
        .from(PosUser)
        .where(eq(PosUser.id, BigInt(operatorId)))
        .limit(1);
      return account?.is_active ? currentAuthenticationVersion(tx, account) : null;
    });
  const operatorCustomer =
    options.operatorCustomer ||
    (async (tx, operatorId) => {
      const [account] = await tx
        .select({
          id: MUser.id,
          active: MUser.status,
          blocked: MUser.is_block,
          disabled: MUser.is_disabled,
        })
        .from(MUser)
        .where(eq(MUser.pos_admin_id, BigInt(operatorId)))
        .orderBy(asc(MUser.id))
        .limit(1);
      return account && activeCheckoutCustomer(account) ? String(account.id) : null;
    });
  const notFound = () =>
    new AppError(
      404,
      'OFFLINE_CASH_REFERENCE_NOT_FOUND',
      'The offline cash reference was not found.',
    );
  async function rememberSigningKey(
    tx: AdministrationTransaction,
    envelope: SignedCashAuthorization,
  ) {
    if (!options.authorizationPublicKey) return;
    const publicKey = devicePublicKeySchema.parse(options.authorizationPublicKey()),
      keyId = cashDigest(publicKey);
    if (keyId !== envelope.keyId || !verifyCashAuthorizationWithKey(publicKey, envelope))
      throw new AppError(
        409,
        'OFFLINE_CASH_AUTHORIZATION_INVALID',
        'The signing key does not match the offline authorization.',
      );
    await retainCashSigningKey(tx, keyId, publicKey, clock());
  }
  async function verifyStoredGrant(
    tx: AdministrationTransaction,
    envelope: SignedCashAuthorization,
  ) {
    const [saved] = await tx
      .select()
      .from(offlineCashSigningKeys)
      .where(eq(offlineCashSigningKeys.keyId, envelope.keyId));
    if (saved)
      return verifyCashAuthorizationWithKey(
        devicePublicKeySchema.parse(JSON.parse(saved.publicKey) as unknown),
        envelope,
      );
    if (!options.verifyAuthorization(envelope)) return false;
    await rememberSigningKey(tx, envelope);
    return true;
  }
  async function lockScope(
    tx: AdministrationTransaction,
    user: Principal,
    storeId: string,
    counterId?: string,
  ) {
    requireStore(user, storeId);
    // Same lock order as day-close: current check-in/operator, then Store.
    await checkIn(user.id, storeId, counterId, tx);
    const currentRole = await role(tx, user);
    await (options.assertStoreAccess || assertCurrentStoreAccess)(tx, user.id, storeId);
    const [store] = await tx
      .select({ id: Store.id })
      .from(Store)
      .where(eq(Store.id, BigInt(storeId)))
      .for('update');
    if (!store) throw notFound();
    return currentRole;
  }
  async function importEvidence(tx: AdministrationTransaction, row: ReceiptRecord) {
    const envelope = signedCashReceiptSchema.parse(JSON.parse(row.envelope) as unknown);
    const [grantRow] = await tx
      .select()
      .from(offlineCashAuthorizations)
      .where(eq(offlineCashAuthorizations.id, row.authorizationId))
      .for('update');
    if (!grantRow) throw notFound();
    const grant = signedCashAuthorizationSchema.parse(JSON.parse(grantRow.envelope) as unknown);
    const snapshot = cashPriceSnapshotSchema.parse(JSON.parse(grantRow.snapshot) as unknown);
    const [device] = await tx
      .select()
      .from(offlineCashDevices)
      .where(eq(offlineCashDevices.id, row.deviceId))
      .for('update');
    if (
      !device ||
      !(await verifyStoredGrant(tx, grant)) ||
      cashDigest(envelope) !== row.requestHash ||
      device.keyHash !== grant.authorization.deviceKeyHash ||
      !verifyDeviceCashReceipt(
        devicePublicKeySchema.parse(JSON.parse(device.publicKey) as unknown),
        envelope,
      )
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_EVIDENCE_INVALID',
        'The immutable offline cash evidence could not be verified.',
      );
    const receipt = envelope.receipt;
    if (
      receipt.id !== row.id ||
      receipt.operatorId !== row.operatorId ||
      receipt.storeId !== row.storeId ||
      receipt.counterId !== row.counterId ||
      receipt.businessDate !== row.businessDate ||
      receipt.deviceId !== device.id ||
      receipt.authorizationId !== grantRow.id ||
      receipt.payableCents !== row.payableCents ||
      receipt.cashReceivedCents !== row.cashReceivedCents ||
      receipt.changeCents !== row.changeCents ||
      receipt.receiptNumber !== row.receiptNumber ||
      grantRow.snapshotHash !== grant.authorization.snapshotHash ||
      device.operatorId !== receipt.operatorId ||
      device.storeId !== receipt.storeId ||
      device.counterId !== receipt.counterId
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_EVIDENCE_INVALID',
        'The immutable offline cash evidence could not be verified.',
      );
    assertCashReceipt(grant.authorization, snapshot, receipt);
    return { envelope, receipt, grant, grantRow, snapshot, device };
  }
  async function receiptView(
    row: ReceiptRecord,
    executor: Parameters<typeof assertOfflineCashImportProofs>[0] = db.get('writer'),
  ) {
    return (await receiptViews([row], executor))[0]!;
  }
  async function receiptViews(
    rows: ReceiptRecord[],
    executor: Parameters<typeof assertOfflineCashImportProofs>[0] = db.get('writer'),
  ) {
    const imported = rows.filter((row) => row.status === 'imported'),
      proofs = new Map<string, { orderId: string; finalizedAt: number }>();
    // Bound full 1000-unit receipts to20k structural rows per proof-reader batch.
    for (let index = 0; index < imported.length; index += 20) {
      const batch = imported.slice(index, index + 20),
        dates = batch.map((row) => row.businessDate).sort();
      const verified = await assertOfflineCashImportProofs(executor, {
        storeIds: [...new Set(batch.map((row) => row.storeId))],
        from: dates[0]!,
        to: dates.at(-1)!,
        receiptIds: batch.map((row) => row.id),
      });
      for (const proof of verified) proofs.set(proof.receiptId, proof);
    }
    return rows.map((row) => {
      if (row.status !== 'imported') return publicOfflineCashReceipt(row);
      const proof = proofs.get(row.id);
      if (!proof || proof.orderId !== row.orderId)
        throw new AppError(
          503,
          'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
          'The imported cash receipt requires verified order evidence.',
        );
      return publicOfflineCashReceipt(row, proof.finalizedAt);
    });
  }
  async function activeAuthorization(
    tx: AdministrationTransaction,
    scope: {
      deviceId: string;
      operatorId: string;
      storeId: string;
      counterId: string;
      deviceKeyHash: string;
      operatorAuthVersion: string;
      operatorCustomerId: string;
    },
  ) {
    const rows = await tx
      .select()
      .from(offlineCashAuthorizations)
      .where(
        and(
          eq(offlineCashAuthorizations.deviceId, scope.deviceId),
          isNull(offlineCashAuthorizations.revokedAt),
          gte(offlineCashAuthorizations.createdAt, clock() - 86_400_000),
          sql`CAST(JSON_UNQUOTE(JSON_EXTRACT(${offlineCashAuthorizations.envelope},'$.authorization.expiresAt')) AS UNSIGNED)>${clock()}`,
        ),
      )
      .orderBy(desc(offlineCashAuthorizations.createdAt), desc(offlineCashAuthorizations.id))
      .limit(2)
      .for('update');
    if (rows.length > 1)
      throw new AppError(
        409,
        'OFFLINE_CASH_MULTIPLE_AUTHORIZATIONS',
        'This device has conflicting active cash authorizations. A manager must reconcile them before issuing another.',
      );
    const row = rows[0];
    if (!row) return null;
    const envelope = signedCashAuthorizationSchema.parse(JSON.parse(row.envelope) as unknown),
      grant = envelope.authorization;
    if (
      !(await verifyStoredGrant(tx, envelope)) ||
      grant.deviceId !== scope.deviceId ||
      grant.operatorId !== scope.operatorId ||
      grant.storeId !== scope.storeId ||
      grant.counterId !== scope.counterId ||
      grant.deviceKeyHash !== scope.deviceKeyHash ||
      row.storeId !== scope.storeId ||
      row.counterId !== scope.counterId ||
      row.operatorId !== scope.operatorId
    )
      throw new AppError(
        503,
        'OFFLINE_CASH_AUTHORIZATION_INVALID',
        'The existing device authorization could not be verified.',
      );
    if (
      grant.operatorAuthVersion !== scope.operatorAuthVersion ||
      grant.operatorCustomerId !== scope.operatorCustomerId
    ) {
      await tx
        .update(offlineCashAuthorizations)
        .set({ revokedAt: clock() })
        .where(eq(offlineCashAuthorizations.id, row.id));
      return null;
    }
    const snapshot = cashPriceSnapshotSchema.parse(JSON.parse(row.snapshot) as unknown);
    assertCashSnapshot(grant, snapshot);
    const [key] = await tx
      .select()
      .from(offlineCashSigningKeys)
      .where(eq(offlineCashSigningKeys.keyId, envelope.keyId))
      .limit(1);
    if (!key)
      throw new AppError(
        503,
        'OFFLINE_CASH_SIGNING_KEY_INVALID',
        'The original device authorization signing key could not be verified.',
      );
    return {
      envelope,
      snapshot,
      serverKey: devicePublicKeySchema.parse(JSON.parse(key.publicKey) as unknown),
    };
  }
  async function staleLatestClose(
    tx: AdministrationTransaction,
    receipt: typeof offlineCashReceipts.$inferInsert,
    now: number,
  ) {
    const [close] = await tx
      .select()
      .from(StoreDayClose)
      .where(
        and(
          eq(StoreDayClose.store_id, Number(receipt.storeId)),
          eq(StoreDayClose.close_date, receipt.businessDate),
        ),
      )
      .orderBy(desc(StoreDayClose.version))
      .limit(1)
      .for('update');
    if (!close || !['CLOSED', 'STALE'].includes(close.status)) return;
    await tx.insert(offlineCashCloseImpacts).values({
      receiptId: receipt.id,
      closeId: close.id,
      priorStatus: close.status,
      priorReason: close.stale_reason,
      createdAt: now,
    });
    const timestamp = Temporal.Instant.fromEpochMilliseconds(now)
      .toZonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
    await tx
      .update(StoreDayClose)
      .set({
        status: 'STALE',
        stale_at: timestamp,
        stale_reason: 'OFFLINE_CASH',
        stale_trigger_ref: receipt.id,
        updated_at: timestamp,
      })
      .where(eq(StoreDayClose.id, close.id));
  }
  return {
    async authorizationContext(
      user: Principal,
      storeId: string,
      counterId: string,
      deviceId: string,
    ) {
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockScope(tx, user, storeId, counterId);
          const [device] = await tx
            .select()
            .from(offlineCashDevices)
            .where(eq(offlineCashDevices.id, deviceId))
            .for('update');
          const operatorAuthVersion = await authenticationVersion(tx, user.id),
            operatorCustomerId = await operatorCustomer(tx, user.id);
          if (
            !device ||
            device.operatorId !== user.id ||
            device.storeId !== storeId ||
            device.counterId !== counterId ||
            device.revokedAt !== null ||
            !operatorAuthVersion ||
            !operatorCustomerId
          )
            throw new AppError(
              409,
              'OFFLINE_CASH_AUTHORIZATION_UNAVAILABLE',
              'A current checked-in operator, protected device and source guest account are required.',
            );
          return {
            deviceKeyHash: device.keyHash,
            operatorAuthVersion,
            operatorCustomerId,
            active: await activeAuthorization(tx, {
              deviceId,
              operatorId: user.id,
              storeId,
              counterId,
              deviceKeyHash: device.keyHash,
              operatorAuthVersion,
              operatorCustomerId,
            }),
          };
        }),
      );
    },
    async registerDevice(
      user: Principal,
      storeId: string,
      counterId: string,
      deviceId: string,
      supplied: DevicePublicKey,
    ) {
      const publicKey = devicePublicKeySchema.parse(supplied),
        keyHash = cashDigest(publicKey);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockScope(tx, user, storeId, counterId);
          const [existing] = await tx
            .select()
            .from(offlineCashDevices)
            .where(eq(offlineCashDevices.id, deviceId))
            .for('update');
          if (existing) {
            if (
              existing.operatorId !== user.id ||
              existing.storeId !== storeId ||
              existing.counterId !== counterId ||
              existing.keyHash !== keyHash ||
              existing.revokedAt !== null
            )
              throw new AppError(
                409,
                'OFFLINE_CASH_DEVICE_CONFLICT',
                'This device reference is bound to different or revoked authorization.',
              );
            return { deviceId, keyHash };
          }
          await tx.insert(offlineCashDevices).values({
            id: deviceId,
            operatorId: user.id,
            storeId,
            counterId,
            publicKey: JSON.stringify(publicKey),
            keyHash,
            createdAt: clock(),
          });
          return { deviceId, keyHash };
        }),
      );
    },
    async saveAuthorization(
      user: Principal,
      supplied: SignedCashAuthorization,
      suppliedSnapshot: CashPriceSnapshot,
    ) {
      const envelope = signedCashAuthorizationSchema.parse(supplied),
        { authorization } = envelope,
        snapshot = cashPriceSnapshotSchema.parse(suppliedSnapshot);
      if (!options.verifyAuthorization(envelope) || authorization.operatorId !== user.id)
        throw new AppError(
          403,
          'OFFLINE_CASH_AUTHORIZATION_INVALID',
          'Offline cash authorization could not be verified.',
        );
      assertCashSnapshot(authorization, snapshot);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          await lockScope(tx, user, authorization.storeId, authorization.counterId);
          await rememberSigningKey(tx, envelope);
          if ((await authenticationVersion(tx, user.id)) !== authorization.operatorAuthVersion)
            throw new AppError(
              409,
              'OFFLINE_CASH_AUTHORIZATION_CHANGED',
              'The operator authorization changed. Refresh before enabling offline cash.',
            );
          if ((await operatorCustomer(tx, user.id)) !== authorization.operatorCustomerId)
            throw new AppError(
              409,
              'OFFLINE_CASH_AUTHORIZATION_CHANGED',
              'The source guest account changed. Refresh before enabling offline cash.',
            );
          const [device] = await tx
            .select()
            .from(offlineCashDevices)
            .where(eq(offlineCashDevices.id, authorization.deviceId))
            .for('update');
          if (
            !device ||
            device.operatorId !== user.id ||
            device.storeId !== authorization.storeId ||
            device.counterId !== authorization.counterId ||
            device.keyHash !== authorization.deviceKeyHash ||
            device.revokedAt !== null
          )
            throw notFound();
          const [existing] = await tx
            .select()
            .from(offlineCashAuthorizations)
            .where(eq(offlineCashAuthorizations.id, authorization.id))
            .for('update');
          if (existing) {
            if (
              existing.envelope !== JSON.stringify(envelope) ||
              existing.snapshotHash !== authorization.snapshotHash
            )
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This offline authorization ID is already bound.',
              );
            const bundle = await activeAuthorization(tx, {
              deviceId: device.id,
              operatorId: user.id,
              storeId: authorization.storeId,
              counterId: authorization.counterId,
              deviceKeyHash: authorization.deviceKeyHash,
              operatorAuthVersion: authorization.operatorAuthVersion,
              operatorCustomerId: authorization.operatorCustomerId,
            });
            if (!bundle || bundle.envelope.authorization.id !== authorization.id)
              throw new AppError(
                409,
                'OFFLINE_CASH_AUTHORIZATION_UNAVAILABLE',
                'This authorization is revoked or expired.',
              );
            return bundle;
          }
          const active = await activeAuthorization(tx, {
            deviceId: device.id,
            operatorId: user.id,
            storeId: authorization.storeId,
            counterId: authorization.counterId,
            deviceKeyHash: authorization.deviceKeyHash,
            operatorAuthVersion: authorization.operatorAuthVersion,
            operatorCustomerId: authorization.operatorCustomerId,
          });
          if (active) return active;
          await tx.insert(offlineCashAuthorizations).values({
            id: authorization.id,
            deviceId: device.id,
            operatorId: user.id,
            storeId: authorization.storeId,
            counterId: authorization.counterId,
            businessDate: authorization.businessDate,
            envelope: JSON.stringify(envelope),
            snapshot: JSON.stringify(snapshot),
            snapshotHash: authorization.snapshotHash,
            acceptedReceipts: 0,
            acceptedCents: 0,
            createdAt: clock(),
          });
          return activeAuthorization(tx, {
            deviceId: device.id,
            operatorId: user.id,
            storeId: authorization.storeId,
            counterId: authorization.counterId,
            deviceKeyHash: authorization.deviceKeyHash,
            operatorAuthVersion: authorization.operatorAuthVersion,
            operatorCustomerId: authorization.operatorCustomerId,
          });
        }),
      );
    },
    async get(user: Principal, storeId: string, receiptId: string) {
      requireStore(user, storeId);
      const [row] = await db
        .get('writer')
        .select()
        .from(offlineCashReceipts)
        .where(and(eq(offlineCashReceipts.id, receiptId), eq(offlineCashReceipts.storeId, storeId)))
        .limit(1);
      if (!row || (row.operatorId !== user.id && ![1, 2, 3, 4].includes(user.role)))
        throw notFound();
      const [authorizationRow] = await db
        .get('writer')
        .select({ envelope: offlineCashAuthorizations.envelope })
        .from(offlineCashAuthorizations)
        .where(eq(offlineCashAuthorizations.id, row.authorizationId))
        .limit(1);
      if (!authorizationRow) throw notFound();
      const authorization = signedCashAuthorizationSchema.parse(
        JSON.parse(authorizationRow.envelope) as unknown,
      ).authorization;
      const events = await db
        .get('writer')
        .select()
        .from(offlineCashEvents)
        .where(eq(offlineCashEvents.receiptId, row.id))
        .orderBy(desc(offlineCashEvents.createdAt), desc(offlineCashEvents.id))
        .limit(100);
      const auditEvents = events.map((event) => {
        const details: unknown = JSON.parse(event.details);
        const expectedVersion =
          details &&
          typeof details === 'object' &&
          'expectedVersion' in details &&
          typeof details.expectedVersion === 'number' &&
          Number.isInteger(details.expectedVersion) &&
          details.expectedVersion > 0
            ? details.expectedVersion
            : null;
        return {
          operationId: event.id,
          kind: event.kind,
          actorId: event.actorId,
          receiptVersion:
            event.kind === 'accepted' ? 1 : expectedVersion === null ? null : expectedVersion + 1,
          createdAt: event.createdAt,
        };
      });
      const approval = events.find((event) => {
        if (event.kind !== 'import-approved' || row.status === 'imported') return false;
        const details = cashImportApprovalDetailsSchema.safeParse(
          JSON.parse(event.details) as unknown,
        );
        return (
          details.success &&
          details.data.receiptHash === row.requestHash &&
          details.data.authorizationId === row.authorizationId &&
          details.data.expectedVersion + 1 === row.version
        );
      });
      return {
        ...(await receiptView(row)),
        envelope: signedCashReceiptSchema.parse(JSON.parse(row.envelope) as unknown),
        authorizationWindow: {
          issuedAt: authorization.issuedAt,
          expiresAt: authorization.expiresAt,
          businessDate: authorization.businessDate,
          timeZone: config.BUSINESS_TIMEZONE,
        },
        auditEvents,
        activeApproval: approval
          ? { operationId: approval.id, actorId: approval.actorId, receiptVersion: row.version }
          : null,
      };
    },
    async list(
      user: Principal,
      storeId: string,
      status: 'accepted' | 'conflicted' | 'importing' | 'imported',
      cursor: { acceptedAt: number; receiptId: string } | null,
      limit: number,
    ) {
      requireStore(user, storeId);
      const rows = await db
        .get('primary')
        .select()
        .from(offlineCashReceipts)
        .where(
          and(
            eq(offlineCashReceipts.storeId, storeId),
            eq(offlineCashReceipts.status, status),
            user.role === 5 ? eq(offlineCashReceipts.operatorId, user.id) : undefined,
            cursor
              ? or(
                  gt(offlineCashReceipts.acceptedAt, cursor.acceptedAt),
                  and(
                    eq(offlineCashReceipts.acceptedAt, cursor.acceptedAt),
                    gt(offlineCashReceipts.id, cursor.receiptId),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(asc(offlineCashReceipts.acceptedAt), asc(offlineCashReceipts.id))
        .limit(Math.min(100, Math.max(1, limit)) + 1);
      const data = rows.slice(0, limit),
        last = data.at(-1);
      return {
        data: await receiptViews(data),
        nextCursor:
          rows.length > limit && last ? { acceptedAt: last.acceptedAt, receiptId: last.id } : null,
      };
    },
    async acknowledge(
      user: Principal,
      storeId: string,
      receiptId: string,
      input: { operationId: string; expectedVersion: number; reason: string },
    ) {
      const hash = cashDigest({ receiptId, ...input });
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const currentRole = await lockScope(tx, user, storeId);
          requireRole({ ...user, role: currentRole }, [1, 2, 3, 4]);
          const [row] = await tx
            .select()
            .from(offlineCashReceipts)
            .where(
              and(eq(offlineCashReceipts.id, receiptId), eq(offlineCashReceipts.storeId, storeId)),
            )
            .for('update');
          if (!row) throw notFound();
          const [existing] = await tx
            .select()
            .from(offlineCashEvents)
            .where(eq(offlineCashEvents.id, input.operationId))
            .for('update');
          if (existing) {
            if (
              existing.receiptId !== receiptId ||
              existing.actorId !== user.id ||
              existing.details !==
                JSON.stringify({
                  requestHash: hash,
                  reason: input.reason,
                  expectedVersion: input.expectedVersion,
                })
            )
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This review reference is bound to different evidence.',
              );
            return receiptView(row, tx);
          }
          if (row.version !== input.expectedVersion)
            throw new AppError(
              409,
              'OFFLINE_CASH_VERSION_CONFLICT',
              'This cash receipt changed. Refresh it before reviewing.',
            );
          await tx.insert(offlineCashEvents).values({
            id: input.operationId,
            receiptId,
            kind: 'manager-reviewed',
            actorId: user.id,
            requestId: currentRequestTrace()?.requestId || null,
            details: JSON.stringify({
              requestHash: hash,
              reason: input.reason,
              expectedVersion: input.expectedVersion,
            }),
            createdAt: clock(),
          });
          await tx
            .update(offlineCashReceipts)
            .set({ version: row.version + 1 })
            .where(eq(offlineCashReceipts.id, receiptId));
          return receiptView({ ...row, version: row.version + 1 }, tx);
        }),
      );
    },
    async approveImport(
      user: Principal,
      storeId: string,
      receiptId: string,
      supplied: CashImportApprovalInput,
    ) {
      const input = cashImportApprovalInputSchema.parse(supplied);
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const currentRole = await lockScope(tx, user, storeId);
          requireRole({ ...user, role: currentRole }, [1, 2, 3, 4]);
          const [row] = await tx
            .select()
            .from(offlineCashReceipts)
            .where(
              and(eq(offlineCashReceipts.id, receiptId), eq(offlineCashReceipts.storeId, storeId)),
            )
            .for('update');
          if (!row) throw notFound();
          const evidence = await importEvidence(tx, row);
          let originalTimestamp: string | undefined;
          try {
            originalTimestamp = offlineCashOrderTimestamp(
              evidence.grant.authorization,
              evidence.receipt,
              config.BUSINESS_TIMEZONE,
            );
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              error.code !== 'OFFLINE_CASH_CLOCK_ATTRIBUTION_REQUIRED'
            )
              throw error;
          }
          if (
            originalTimestamp &&
            input.orderCreatedAt &&
            input.orderCreatedAt !== originalTimestamp
          )
            throw new AppError(
              409,
              'OFFLINE_CASH_TIMESTAMP_IMMUTABLE',
              'A valid signed receipt time cannot be changed during reconciliation.',
            );
          const orderCreatedAt =
            originalTimestamp ||
            offlineCashOrderTimestamp(
              evidence.grant.authorization,
              evidence.receipt,
              config.BUSINESS_TIMEZONE,
              input.orderCreatedAt,
            );
          const details = cashImportApprovalDetailsSchema.parse({
            version: 1,
            receiptHash: row.requestHash,
            authorizationId: row.authorizationId,
            expectedVersion: input.expectedVersion,
            orderCreatedAt,
            acknowledgedConflicts: JSON.parse(row.conflicts) as unknown,
            reason: input.reason,
          });
          const [existing] = await tx
            .select()
            .from(offlineCashEvents)
            .where(eq(offlineCashEvents.id, input.operationId))
            .for('update');
          if (existing) {
            if (
              existing.receiptId !== row.id ||
              existing.kind !== 'import-approved' ||
              existing.actorId !== user.id ||
              (() => {
                const saved = cashImportApprovalDetailsSchema.parse(
                  JSON.parse(existing.details) as unknown,
                );
                return (
                  saved.receiptHash !== details.receiptHash ||
                  saved.authorizationId !== details.authorizationId ||
                  saved.expectedVersion !== details.expectedVersion ||
                  saved.reason !== details.reason ||
                  saved.orderCreatedAt !== details.orderCreatedAt
                );
              })()
            )
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This approval reference is bound to different receipt evidence.',
              );
            return receiptView(row, tx);
          }
          if (row.status === 'imported')
            throw new AppError(
              409,
              'OFFLINE_CASH_ALREADY_IMPORTED',
              'This receipt is already linked to its authoritative order.',
            );
          if (row.version !== input.expectedVersion)
            throw new AppError(
              409,
              'OFFLINE_CASH_VERSION_CONFLICT',
              'This cash receipt changed. Refresh it before approving import.',
            );
          await tx.insert(offlineCashEvents).values({
            id: input.operationId,
            receiptId,
            kind: 'import-approved',
            actorId: user.id,
            requestId: currentRequestTrace()?.requestId || null,
            details: JSON.stringify(details),
            createdAt: clock(),
          });
          await tx
            .update(offlineCashReceipts)
            .set({ version: row.version + 1 })
            .where(eq(offlineCashReceipts.id, receiptId));
          return receiptView({ ...row, version: row.version + 1 }, tx);
        }),
      );
    },
    async importOrder(
      user: Principal,
      storeId: string,
      receiptId: string,
      supplied: CashOrderImportInput,
      template: CashSourceTemplate | null,
      writer: CashImportWriterOptions | null,
    ) {
      const input = cashOrderImportInputSchema.parse(supplied),
        requestHash = cashDigest({ receiptId, ...input });
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const currentRole = await lockScope(tx, user, storeId);
          const [row] = await tx
            .select()
            .from(offlineCashReceipts)
            .where(
              and(eq(offlineCashReceipts.id, receiptId), eq(offlineCashReceipts.storeId, storeId)),
            )
            .for('update');
          if (!row || (row.operatorId !== user.id && ![1, 2, 3, 4].includes(currentRole)))
            throw notFound();
          const [operation] = await tx
            .select()
            .from(offlineCashEvents)
            .where(eq(offlineCashEvents.id, input.operationId))
            .for('update');
          if (
            operation &&
            (operation.kind !== 'order-imported' ||
              operation.receiptId !== receiptId ||
              operation.actorId !== user.id ||
              (JSON.parse(operation.details) as { requestHash?: unknown }).requestHash !==
                requestHash)
          )
            throw new AppError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This import reference is bound to different receipt evidence.',
            );
          if (row.status === 'imported') return receiptView(row, tx);
          if (row.orderId !== null || operation)
            throw new AppError(
              503,
              'OFFLINE_CASH_IMPORT_PROOF_REQUIRED',
              'The receipt import evidence requires reconciliation before another order can be created.',
            );
          if (row.version !== input.expectedVersion)
            throw new AppError(
              409,
              'OFFLINE_CASH_VERSION_CONFLICT',
              'This cash receipt changed. Refresh it before importing.',
            );
          if (!template || !writer)
            throw new AppError(
              503,
              'OFFLINE_CASH_IMPORT_NOT_CONFIGURED',
              'The verified source and stock import contracts are required.',
            );
          const evidence = await importEvidence(tx, row),
            conflicts: CashConflict[] = cashConflictSchema
              .array()
              .parse(JSON.parse(row.conflicts) as unknown)
              .filter(
                (conflict) =>
                  !['source-import-unavailable', 'import-outcome-unknown'].includes(conflict),
              );
          if (evidence.device.revokedAt !== null || evidence.grantRow.revokedAt !== null)
            conflicts.push('authorization-revoked');
          if (clock() >= evidence.grant.authorization.expiresAt)
            conflicts.push('authorization-expired');
          if (
            (await authenticationVersion(tx, row.operatorId)) !==
              evidence.grant.authorization.operatorAuthVersion ||
            (await operatorCustomer(tx, row.operatorId)) !==
              evidence.grant.authorization.operatorCustomerId
          )
            conflicts.push('operator-access-changed');
          const available = await tx
            .select({
              productId: ProductStore.product,
              stock: ProductStore.stock,
              active: ProductStore.is_avail,
              deleted: ProductStore.is_del,
            })
            .from(ProductStore)
            .where(
              and(
                eq(ProductStore.store, BigInt(storeId)),
                inArray(
                  ProductStore.product,
                  evidence.receipt.lines.map((line) => BigInt(line.productId)),
                ),
              ),
            )
            .orderBy(asc(ProductStore.product), asc(ProductStore.id))
            .for('update');
          const hasStockConflict = evidence.receipt.lines.some((line) => {
            const matches = available.filter((item) => String(item.productId) === line.productId),
              stock = matches[0];
            return (
              matches.length !== 1 ||
              !stock ||
              !stock.active ||
              stock.deleted ||
              stock.stock < line.quantity
            );
          });
          if (hasStockConflict) conflicts.push('stock-shortage');
          const originalPrices = new Map(
            evidence.receipt.lines.map((line) => [line.productId, line]),
          );
          if (
            template.lines.some((line) => {
              const original = originalPrices.get(String(line.prod_id));
              if (!original) return true;
              const special = templateDecimal(line.special_price),
                normal = templateDecimal(line.normal_price),
                current = special.gt(0) ? special : normal;
              const expected = templateDecimal(original.unitPrice).times(
                evidence.snapshot.lineItemsEnabled ? 1 : original.quantity,
              );
              return current.minus(expected).abs().gt('0.0000001');
            })
          )
            conflicts.push('price-changed');
          const unique = [...new Set(conflicts)].sort(),
            old = JSON.stringify(
              cashConflictSchema
                .array()
                .parse(JSON.parse(row.conflicts) as unknown)
                .sort(),
            );
          let approved: ReturnType<typeof cashImportApprovalDetailsSchema.parse> | undefined;
          if (input.approvalId) {
            requireRole({ ...user, role: currentRole }, [1, 2, 3, 4]);
            const [event] = await tx
              .select()
              .from(offlineCashEvents)
              .where(eq(offlineCashEvents.id, input.approvalId))
              .for('share');
            if (
              !event ||
              event.kind !== 'import-approved' ||
              event.receiptId !== receiptId ||
              event.actorId !== user.id
            )
              throw new AppError(
                403,
                'OFFLINE_CASH_IMPORT_APPROVAL_INVALID',
                'A matching approval from the current store manager is required.',
              );
            approved = cashImportApprovalDetailsSchema.parse(JSON.parse(event.details) as unknown);
            if (
              approved.receiptHash !== row.requestHash ||
              approved.authorizationId !== row.authorizationId ||
              approved.expectedVersion + 1 !== row.version
            )
              throw new AppError(
                403,
                'OFFLINE_CASH_IMPORT_APPROVAL_INVALID',
                'The manager approval does not match the current cash evidence.',
              );
          }
          if (
            (unique.length &&
              (!approved ||
                unique.some((conflict) => !approved.acknowledgedConflicts.includes(conflict)))) ||
            hasStockConflict
          ) {
            if (old !== JSON.stringify(unique) || row.status !== 'conflicted') {
              await tx
                .update(offlineCashReceipts)
                .set({
                  status: 'conflicted',
                  conflicts: JSON.stringify(unique),
                  version: row.version + 1,
                })
                .where(eq(offlineCashReceipts.id, receiptId));
              await tx.insert(offlineCashEvents).values({
                id: randomUUID(),
                receiptId,
                kind: 'import-conflicted',
                actorId: user.id,
                requestId: currentRequestTrace()?.requestId || null,
                details: JSON.stringify({
                  receiptHash: row.requestHash,
                  conflicts: unique,
                  expectedVersion: row.version,
                }),
                createdAt: clock(),
              });
              return receiptView(
                {
                  ...row,
                  status: 'conflicted',
                  conflicts: JSON.stringify(unique),
                  version: row.version + 1,
                },
                tx,
              );
            }
            return receiptView(row, tx);
          }
          let orderCreatedAt: string;
          try {
            orderCreatedAt = offlineCashOrderTimestamp(
              evidence.grant.authorization,
              evidence.receipt,
              config.BUSINESS_TIMEZONE,
            );
          } catch (error) {
            if (!approved) throw error;
            orderCreatedAt = offlineCashOrderTimestamp(
              evidence.grant.authorization,
              evidence.receipt,
              config.BUSINESS_TIMEZONE,
              approved.orderCreatedAt,
            );
          }
          if (approved && approved.orderCreatedAt !== orderCreatedAt)
            throw new AppError(
              409,
              'OFFLINE_CASH_TIMESTAMP_IMMUTABLE',
              'The manager attribution does not match the receipt import timestamp.',
            );
          const result = await writeCashOrder(
            tx,
            config,
            {
              receipt: evidence.receipt,
              authorization: evidence.grant.authorization,
              snapshot: evidence.snapshot,
              receiptHash: row.requestHash,
              template,
              orderCreatedAt,
            },
            writer,
          );
          const next = {
            ...row,
            status: 'imported',
            orderId: result.orderId,
            conflicts: '[]',
            version: row.version + 1,
          };
          await tx
            .update(offlineCashReceipts)
            .set({
              status: next.status,
              orderId: next.orderId,
              conflicts: next.conflicts,
              version: next.version,
            })
            .where(eq(offlineCashReceipts.id, receiptId));
          await tx.insert(offlineCashEvents).values({
            id: input.operationId,
            receiptId,
            kind: 'order-imported',
            actorId: user.id,
            requestId: currentRequestTrace()?.requestId || null,
            details: JSON.stringify({
              requestHash,
              expectedVersion: input.expectedVersion,
              receiptHash: row.requestHash,
              orderId: result.orderId,
              approvalId: input.approvalId || null,
            }),
            createdAt: writer.finalizedAt,
          });
          return receiptView(next, tx);
        }),
      );
    },
    async accept(user: Principal, storeId: string, supplied: SignedCashReceipt) {
      const envelope = signedCashReceiptSchema.parse(supplied),
        receipt = envelope.receipt,
        requestHash = cashDigest(envelope);
      if (receipt.storeId !== storeId) throw notFound();
      return retryTransaction(() =>
        db.get('writer').transaction(async (tx) => {
          const currentRole = await lockScope(tx, user, storeId);
          if (receipt.operatorId !== user.id && ![1, 2, 3, 4].includes(currentRole))
            throw new AppError(
              403,
              'OFFLINE_CASH_OWNER_REQUIRED',
              'Only the original operator or a store manager can reconcile this receipt.',
            );
          const [existing] = await tx
            .select()
            .from(offlineCashReceipts)
            .where(eq(offlineCashReceipts.id, receipt.id))
            .for('update');
          if (existing) {
            if (existing.storeId !== storeId || existing.requestHash !== requestHash)
              throw new AppError(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This receipt ID is bound to different cash evidence.',
              );
            return { ...(await receiptView(existing, tx)), replayed: true };
          }
          const [grantRow] = await tx
            .select()
            .from(offlineCashAuthorizations)
            .where(eq(offlineCashAuthorizations.id, receipt.authorizationId))
            .for('update');
          if (
            !grantRow ||
            grantRow.storeId !== storeId ||
            grantRow.operatorId !== receipt.operatorId ||
            grantRow.deviceId !== receipt.deviceId
          )
            throw notFound();
          const grant = signedCashAuthorizationSchema.parse(
              JSON.parse(grantRow.envelope) as unknown,
            ),
            snapshot = cashPriceSnapshotSchema.parse(JSON.parse(grantRow.snapshot) as unknown);
          if (!(await verifyStoredGrant(tx, grant)))
            throw new AppError(
              409,
              'OFFLINE_CASH_AUTHORIZATION_INVALID',
              'The original offline authorization could not be verified.',
            );
          const [device] = await tx
            .select()
            .from(offlineCashDevices)
            .where(eq(offlineCashDevices.id, receipt.deviceId))
            .for('update');
          if (
            !device ||
            device.operatorId !== receipt.operatorId ||
            device.keyHash !== grant.authorization.deviceKeyHash ||
            !verifyDeviceCashReceipt(
              devicePublicKeySchema.parse(JSON.parse(device.publicKey) as unknown),
              envelope,
            )
          )
            throw new AppError(
              403,
              'OFFLINE_CASH_SIGNATURE_INVALID',
              'The original device signature could not be verified.',
            );
          const conflicts = assertCashReceipt(grant.authorization, snapshot, receipt);
          const [collision] = await tx
            .select({ id: offlineCashReceipts.id })
            .from(offlineCashReceipts)
            .where(
              or(
                and(
                  eq(offlineCashReceipts.authorizationId, receipt.authorizationId),
                  eq(offlineCashReceipts.sequence, receipt.sequence),
                ),
                and(
                  eq(offlineCashReceipts.operatorId, receipt.operatorId),
                  eq(offlineCashReceipts.draftId, receipt.draftId),
                ),
              ),
            )
            .limit(1);
          if (collision)
            throw new AppError(
              409,
              'OFFLINE_CASH_RECEIPT_CONFLICT',
              'This sale or receipt sequence already has different immutable cash evidence.',
            );
          if (
            grantRow.acceptedReceipts >= grant.authorization.receiptCount ||
            grantRow.acceptedCents + receipt.payableCents > grant.authorization.maxTotalCents
          )
            throw new AppError(
              409,
              'OFFLINE_CASH_LIMIT_EXCEEDED',
              'The signed offline cash limit is exceeded. Keep the device receipt for manager review.',
            );
          if (device.revokedAt !== null || grantRow.revokedAt !== null)
            conflicts.push('authorization-revoked');
          if (
            (await authenticationVersion(tx, receipt.operatorId)) !==
            grant.authorization.operatorAuthVersion
          )
            conflicts.push('operator-access-changed');
          if (
            (await operatorCustomer(tx, receipt.operatorId)) !==
            grant.authorization.operatorCustomerId
          )
            conflicts.push('operator-access-changed');
          const stock = await tx
            .select({
              productId: ProductStore.product,
              stock: ProductStore.stock,
              available: ProductStore.is_avail,
              deleted: ProductStore.is_del,
            })
            .from(ProductStore)
            .where(
              and(
                eq(ProductStore.store, BigInt(storeId)),
                inArray(
                  ProductStore.product,
                  receipt.lines.map((line) => BigInt(line.productId)),
                ),
              ),
            );
          const pending = await tx
            .select({
              productId: offlineCashReceiptLines.productId,
              quantity: sum(offlineCashReceiptLines.quantity),
            })
            .from(offlineCashReceiptLines)
            .innerJoin(
              offlineCashReceipts,
              eq(offlineCashReceipts.id, offlineCashReceiptLines.receiptId),
            )
            .where(
              and(
                eq(offlineCashReceiptLines.storeId, storeId),
                eq(offlineCashReceipts.storeId, storeId),
                ne(offlineCashReceipts.status, 'imported'),
                inArray(
                  offlineCashReceiptLines.productId,
                  receipt.lines.map((line) => line.productId),
                ),
              ),
            )
            .groupBy(offlineCashReceiptLines.productId);
          if (
            receipt.lines.some((line) => {
              const matching = stock.filter((entry) => String(entry.productId) === line.productId);
              return (
                matching.length !== 1 ||
                !matching[0]!.available ||
                matching[0]!.deleted ||
                matching[0]!.stock -
                  Number(
                    pending.find((entry) => entry.productId === line.productId)?.quantity || 0,
                  ) <
                  line.quantity
              );
            })
          )
            conflicts.push('stock-shortage');
          if (!options.sourceImportReady) conflicts.push('source-import-unavailable');
          const now = clock();
          if (now >= grant.authorization.expiresAt) conflicts.push('authorization-expired');
          const values: typeof offlineCashReceipts.$inferInsert = {
            id: receipt.id,
            authorizationId: receipt.authorizationId,
            deviceId: receipt.deviceId,
            sequence: receipt.sequence,
            operatorId: receipt.operatorId,
            storeId,
            counterId: receipt.counterId,
            draftId: receipt.draftId,
            businessDate: grant.authorization.businessDate,
            completedAt: receipt.completedAt,
            acceptedAt: now,
            receiptNumber: receipt.receiptNumber,
            requestHash,
            envelope: JSON.stringify(envelope),
            payableCents: receipt.payableCents,
            cashReceivedCents: receipt.cashReceivedCents,
            changeCents: receipt.changeCents,
            status: conflicts.length ? 'conflicted' : 'accepted',
            conflicts: JSON.stringify([...new Set(conflicts)]),
            version: 1,
            requestId: currentRequestTrace()?.requestId || null,
          };
          await tx.insert(offlineCashReceipts).values(values);
          await tx.insert(offlineCashReceiptLines).values(
            receipt.lines.map((line) => ({
              receiptId: receipt.id,
              storeId,
              productId: line.productId,
              quantity: line.quantity,
            })),
          );
          await tx
            .update(offlineCashAuthorizations)
            .set({
              acceptedReceipts: grantRow.acceptedReceipts + 1,
              acceptedCents: grantRow.acceptedCents + receipt.payableCents,
            })
            .where(eq(offlineCashAuthorizations.id, grantRow.id));
          await tx.insert(offlineCashEvents).values({
            id: randomUUID(),
            receiptId: receipt.id,
            kind: 'accepted',
            actorId: user.id,
            requestId: currentRequestTrace()?.requestId || null,
            details: JSON.stringify({
              conflicts: [...new Set(conflicts)],
              businessDate: grant.authorization.businessDate,
            }),
            createdAt: now,
          });
          await staleLatestClose(tx, values, now);
          const [saved] = await tx
            .select()
            .from(offlineCashReceipts)
            .where(eq(offlineCashReceipts.id, receipt.id));
          return { ...publicOfflineCashReceipt(saved!), replayed: false };
        }),
      );
    },
  };
}
