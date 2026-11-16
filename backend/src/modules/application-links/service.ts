import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { generatedId } from '../../db/generated-id.js';
import { PosUser, Store, UserStore } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { qrDataUrl } from '../../domain/qr.js';
import { currentRequestTrace } from '../../observability/context.js';
import { currentAuthenticationVersion } from '../../auth/revocation.js';
import { checkInService, type AdministrationTransaction } from '../administration/checkins.js';
import type { ApplicationPackage, ApplicationPackageMetadata } from './artifact.js';
import type { CustomerApplicationProvider } from './provider.js';
import {
  operation,
  staffActivation,
  staffContent,
  customerScan,
  type ApplicationLinkOptions,
} from './contracts.js';
import {
  applicationDigest,
  applicationToken,
  packageQrExpiry,
  sameToken,
  scanWallTime,
} from './domain.js';
import {
  applicationScanReceipts as scans,
  customerApplicationLinks as links,
  staffDownloadGrants as grants,
  sourceApplicationScans,
} from './schema.js';
import { customerApplicationCacheService } from './customer-cache.js';

export interface ApplicationLinkDependencies {
  artifact?: ApplicationPackage;
  customerLink?: CustomerApplicationProvider;
}
const expired = () =>
  new AppError(
    410,
    'APPLICATION_LINK_EXPIRED',
    'This application link expired or was already used. Request a new QR code.',
  );
const unavailable = () =>
  new AppError(503, 'APPLICATION_LINK_UNAVAILABLE', 'This application link is not configured.');
type Grant = typeof grants.$inferSelect;
export function applicationLinkService(
  config: Config,
  db: Databases,
  options: ApplicationLinkOptions,
  dependencies: ApplicationLinkDependencies,
  now: () => number = Date.now,
) {
  const digest = (purpose: string, value: string) =>
      applicationDigest(config.SESSION_SECRET, purpose, value),
    token = (purpose: string, values: readonly string[]) =>
      applicationToken(config.SESSION_SECRET, purpose, values),
    checkIns = checkInService(db, config),
    cachedDestination = dependencies.customerLink
      ? customerApplicationCacheService(db, dependencies.customerLink, now)
      : undefined;
  async function account(tx: AdministrationTransaction, id: string, internal = false) {
    const [row] = await tx
      .select()
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(id)))
      .limit(1)
      .for('update');
    if (!row?.is_active || ![1, 2, 3, 4, 5].includes(row.role) || (internal && row.user_type !== 1))
      throw new AppError(
        403,
        'APPLICATION_LINK_DENIED',
        'This application link requires a current permitted operator.',
      );
    return row;
  }
  const version = async (tx: AdministrationTransaction, row: typeof PosUser.$inferSelect) =>
    digest('operator-version', await currentAuthenticationVersion(tx, row));
  const artifactVersion = (metadata: ApplicationPackageMetadata) =>
    digest('artifact-version', JSON.stringify([metadata.filename, metadata.bytes, metadata.checksum]));
  function staffReady() {
    if (config.DEMO_MODE || !options.POS_STAFF_APK_ENABLED || !dependencies.artifact)
      throw unavailable();
    return dependencies.artifact;
  }
  const qrToken = (row: Pick<Grant, 'id' | 'operatorId' | 'authVersion' | 'artifactVersion'>) =>
    token('staff-qr', [row.id, String(row.operatorId), row.authVersion, row.artifactVersion]);
  const activationToken = (row: Grant) =>
    token('staff-activation', [
      row.id,
      row.activationOperationId || '',
      String(row.activationExpiresAt),
      row.authVersion,
      row.artifactVersion,
    ]);
  const customerToken = (row: Pick<typeof links.$inferSelect, 'id' | 'storeId'>) =>
    token('customer-qr', [row.id, String(row.storeId)]);
  async function validGrant(
    tx: AdministrationTransaction,
    row: Grant | undefined,
    metadata: ApplicationPackageMetadata,
    rowAccount: typeof PosUser.$inferSelect,
  ) {
    if (
      !row ||
      row.state === 'REVOKED' ||
      row.artifactVersion !== artifactVersion(metadata) ||
      row.authVersion !== (await version(tx, rowAccount))
    )
      throw expired();
    return row;
  }
  async function lookupGrant(value: string, kind: 'qr' | 'activation') {
    const field = kind === 'qr' ? grants.qrDigest : grants.activationDigest;
    const [row] = await db
      .get('writer')
      .select({ id: grants.id, operatorId: grants.operatorId })
      .from(grants)
      .where(eq(field, digest(kind, value)))
      .limit(1);
    if (!row) throw expired();
    return row;
  }
  async function publicCustomer(tx: AdministrationTransaction, value: string) {
    const [row] = await tx
      .select()
      .from(links)
      .where(eq(links.tokenDigest, digest('customer', value)))
      .limit(1)
      .for('share');
    if (!row || !sameToken(value, customerToken(row))) throw expired();
    const [store] = await tx
      .select({ id: Store.id })
      .from(Store)
      .where(and(eq(Store.id, row.storeId), eq(Store.is_active, true)))
      .limit(1)
      .for('share');
    if (!store || row.storeId < 1n || row.storeId > 2147483647n) throw expired();
    return row;
  }
  return {
    async capabilities(user: Principal) {
      if (config.DEMO_MODE)
        return {
          staffAvailable: false,
          customerAvailable: false,
          checkedInStore: null,
          qrPeriodSeconds: options.MPOS_DOWNLOAD_QR_EXP_SEC,
        };
      const current = await db.get('writer').transaction((tx) => account(tx, user.id));
      return {
        staffAvailable: Boolean(
          current.user_type === 1 && options.POS_STAFF_APK_ENABLED && dependencies.artifact,
        ),
        customerAvailable: Boolean(dependencies.customerLink),
        checkedInStore: await checkIns.checkedInStore(user.id),
        qrPeriodSeconds: options.MPOS_DOWNLOAD_QR_EXP_SEC,
      };
    },
    async issueStaff(user: Principal, value: { operationId: string }) {
      const input = operation.parse(value),
        artifact = staffReady(),
        metadata = await artifact.describe();
      const issued = await db.get('writer').transaction(async (tx) => {
        const current = await account(tx, user.id, true),
          authVersion = await version(tx, current),
          timestamp = now(),
          artifactBinding = artifactVersion(metadata);
        const [replay] = await tx
          .select()
          .from(grants)
          .where(eq(grants.operationId, input.operationId))
          .limit(1)
          .for('update');
        if (replay) {
          if (String(replay.operatorId) !== user.id)
            throw new AppError(
              409,
              'APPLICATION_OPERATION_CONFLICT',
              'This operation belongs to another application link.',
            );
          await validGrant(tx, replay, metadata, current);
          if (replay.state !== 'ISSUED' || replay.expiresAt <= BigInt(timestamp)) throw expired();
          return replay;
        }
        const [existing] = await tx
          .select()
          .from(grants)
          .where(
            and(
              eq(grants.operatorId, BigInt(user.id)),
              eq(grants.state, 'ISSUED'),
              eq(grants.authVersion, authVersion),
              eq(grants.artifactVersion, artifactBinding),
              gt(grants.expiresAt, BigInt(timestamp)),
            ),
          )
          .orderBy(desc(grants.createdAt), desc(grants.id))
          .limit(1)
          .for('update');
        if (existing) return existing;
        const row = {
          id: randomUUID(),
          operationId: input.operationId,
          operatorId: BigInt(user.id),
          authVersion,
          artifactVersion: artifactBinding,
          requestId: currentRequestTrace()?.requestId || null,
          state: 'ISSUED' as const,
          expiresAt: BigInt(packageQrExpiry(timestamp, options.MPOS_DOWNLOAD_QR_EXP_SEC)),
          createdAt: BigInt(timestamp),
          updatedAt: BigInt(timestamp),
        };
        await tx.insert(grants).values({ ...row, qrDigest: digest('qr', qrToken(row)) });
        const [saved] = await tx.select().from(grants).where(eq(grants.id, row.id)).limit(1);
        if (!saved) throw unavailable();
        return saved;
      });
      const url = new URL('/application-links/staff', config.WEB_ORIGIN);
      url.hash = qrToken(issued);
      return {
        id: issued.id,
        url: url.href,
        qrDataUrl: await qrDataUrl(url.href),
        serverNow: now(),
        expiresAt: Number(issued.expiresAt),
        filename: metadata.filename,
        bytes: metadata.bytes,
      };
    },
    async activateStaff(value: { operationId: string; token: string }) {
      const input = staffActivation.parse(value),
        artifact = staffReady(),
        lookup = await lookupGrant(input.token, 'qr'),
        metadata = await artifact.describe();
      return db.get('writer').transaction(async (tx) => {
        const current = await account(tx, String(lookup.operatorId), true),
          [found] = await tx
            .select()
            .from(grants)
            .where(eq(grants.id, lookup.id))
            .limit(1)
            .for('update'),
          row = await validGrant(tx, found, metadata, current),
          timestamp = BigInt(now());
        if (!sameToken(input.token, qrToken(row))) throw expired();
        if (row.state === 'ACTIVATED' || row.state === 'CONSUMED') {
          if (
            row.activationOperationId !== input.operationId ||
            !row.activationExpiresAt ||
            row.activationExpiresAt <= timestamp
          )
            throw expired();
        } else {
          if (row.state !== 'ISSUED' || row.expiresAt <= timestamp) throw expired();
          row.state = 'ACTIVATED';
          row.activationOperationId = input.operationId;
          row.activationExpiresAt = timestamp + BigInt(options.MPOS_DOWNLOAD_LINK_EXP * 1000);
          row.activationDigest = digest('activation', activationToken(row));
          await tx
            .update(grants)
            .set({
              state: row.state,
              activationOperationId: row.activationOperationId,
              activationExpiresAt: row.activationExpiresAt,
              activationDigest: row.activationDigest,
              updatedAt: timestamp,
            })
            .where(eq(grants.id, row.id));
        }
        return {
          activationToken: activationToken(row),
          serverNow: now(),
          expiresAt: Number(row.activationExpiresAt),
          ...metadata,
        };
      });
    },
    async downloadStaff(
      value: { operationId: string; activationToken: string },
      signal?: AbortSignal,
    ) {
      const input = staffContent.parse(value),
        artifact = staffReady(),
        lookup = await lookupGrant(input.activationToken, 'activation'),
        metadata = await artifact.describe();
      await db.get('writer').transaction(async (tx) => {
        const current = await account(tx, String(lookup.operatorId), true),
          [found] = await tx
            .select()
            .from(grants)
            .where(eq(grants.id, lookup.id))
            .limit(1)
            .for('update'),
          row = await validGrant(tx, found, metadata, current),
          timestamp = BigInt(now());
        if (
          !sameToken(input.activationToken, activationToken(row)) ||
          !row.activationExpiresAt ||
          row.activationExpiresAt <= timestamp
        )
          throw expired();
        if (row.state === 'CONSUMED') {
          if (row.downloadOperationId !== input.operationId) throw expired();
        } else {
          if (row.state !== 'ACTIVATED') throw expired();
          await tx
            .update(grants)
            .set({
              state: 'CONSUMED',
              downloadOperationId: input.operationId,
              updatedAt: timestamp,
            })
            .where(eq(grants.id, row.id));
        }
      });
      signal?.throwIfAborted();
      const opened = await artifact.open(signal);
      if (artifactVersion(opened.metadata) !== artifactVersion(metadata)) {
        opened.stream.destroy();
        throw expired();
      }
      return opened;
    },
    async revokeStaff(user: Principal, id: string) {
      await db.get('writer').transaction(async (tx) => {
        await account(tx, user.id, true);
        await tx
          .update(grants)
          .set({ state: 'REVOKED', updatedAt: BigInt(now()) })
          .where(and(eq(grants.id, id), eq(grants.operatorId, BigInt(user.id))));
      });
      return { status: 'revoked' as const };
    },
    async issueCustomer(user: Principal) {
      if (config.DEMO_MODE || !dependencies.customerLink) throw unavailable();
      const selected = await checkIns.checkedInStore(user.id);
      if (!selected)
        throw new AppError(
          409,
          'CHECK_IN_REQUIRED',
          'Check in to a store before creating its application QR.',
        );
      const issued = await db.get('writer').transaction(async (tx) => {
        const current = await account(tx, user.id);
        await checkIns.assertCheckIn(user.id, selected, undefined, tx);
        const [store] = await tx
          .select({ id: Store.id, name: Store.store_name, category: Store.category })
          .from(Store)
          .where(and(eq(Store.id, BigInt(selected)), eq(Store.is_active, true)))
          .limit(1)
          .for('share');
        if (!store || store.id < 1n || store.id > 2147483647n)
          throw new AppError(
            409,
            'APPLICATION_STORE_UNSUPPORTED',
            'This store cannot be recorded by the application scan audit.',
          );
        if (current.user_type === 2) {
          const [assignment] = await tx
            .select({ id: UserStore.id })
            .from(UserStore)
            .where(and(eq(UserStore.django_user_id, current.id), eq(UserStore.store_id, store.id)))
            .limit(1)
            .for('share');
          if (store.category !== 'FRANCHISE' || !assignment)
            throw new AppError(
              403,
              'APPLICATION_LINK_DENIED',
              'You cannot create an application QR for this store.',
            );
        }
        const id = randomUUID(),
          timestamp = BigInt(now()),
          link = {
            id,
            storeId: store.id,
            createdBy: current.id,
            requestId: currentRequestTrace()?.requestId || null,
            createdAt: timestamp,
          };
        await tx
          .insert(links)
          .values({ ...link, tokenDigest: digest('customer', customerToken(link)) })
          .onDuplicateKeyUpdate({ set: { storeId: store.id } });
        const [saved] = await tx
          .select()
          .from(links)
          .where(eq(links.storeId, store.id))
          .limit(1)
          .for('share');
        if (!saved) throw unavailable();
        const currentDigest = digest('customer', customerToken(saved));
        if (saved.tokenDigest !== currentDigest)
          await tx.update(links).set({ tokenDigest: currentDigest }).where(eq(links.id, saved.id));
        return { ...saved, storeName: store.name };
      });
      const url = new URL('/application-links/customer', config.WEB_ORIGIN);
      url.hash = customerToken(issued);
      return {
        storeId: String(issued.storeId),
        storeName: issued.storeName,
        url: url.href,
        qrDataUrl: await qrDataUrl(url.href),
      };
    },
    async scanCustomer(value: { operationId: string; token: string }) {
      if (config.DEMO_MODE || !dependencies.customerLink || !cachedDestination) throw unavailable();
      const input = customerScan.parse(value),
        initial = await db.get('writer').transaction(async (tx) => {
          const link = await publicCustomer(tx, input.token),
            [receipt] = await tx
              .select()
              .from(scans)
              .where(eq(scans.id, input.operationId))
              .limit(1)
              .for('share');
          if (receipt && (receipt.linkId !== link.id || receipt.storeId !== link.storeId))
            throw new AppError(
              409,
              'APPLICATION_OPERATION_CONFLICT',
              'This operation belongs to another application link.',
            );
          if (receipt?.target) {
            if (!dependencies.customerLink!.accepts(receipt.target)) throw unavailable();
            return { destination: receipt.target, link };
          }
          return { link };
        });
      if (initial.destination) return { destination: initial.destination };
      const target = await cachedDestination(String(initial.link.storeId));
      return db.get('writer').transaction(async (tx) => {
        const current = await publicCustomer(tx, input.token),
          timestamp = now();
        await tx
          .insert(scans)
          .values({
            id: input.operationId,
            linkId: current.id,
            storeId: current.storeId,
            requestId: currentRequestTrace()?.requestId || null,
            createdAt: BigInt(timestamp),
          })
          .onDuplicateKeyUpdate({ set: { id: input.operationId } });
        const [receipt] = await tx
          .select()
          .from(scans)
          .where(eq(scans.id, input.operationId))
          .limit(1)
          .for('update');
        if (!receipt || receipt.linkId !== current.id || receipt.storeId !== current.storeId)
          throw new AppError(
            409,
            'APPLICATION_OPERATION_CONFLICT',
            'This operation belongs to another application link.',
          );
        if (receipt.target) {
          if (!dependencies.customerLink!.accepts(receipt.target)) throw unavailable();
          return { destination: receipt.target };
        }
        const id = generatedId(
          await tx.insert(sourceApplicationScans).values({
            storeId: Number(current.storeId),
            scannedAt: scanWallTime(timestamp, config.BUSINESS_TIMEZONE),
          }),
        );
        if (id > 2147483647n) throw unavailable();
        await tx
          .update(scans)
          .set({ target, sourceLogId: Number(id) })
          .where(eq(scans.id, input.operationId));
        return { destination: target };
      });
    },
  };
}
export async function pruneApplicationLinks(db: Databases, timestamp = Date.now()) {
  const olderThan = BigInt(timestamp - 86400000);
  await db.get('writer').delete(grants).where(lt(grants.expiresAt, olderThan)).limit(100);
  await db.get('writer').delete(scans).where(lt(scans.createdAt, olderThan)).limit(100);
}
