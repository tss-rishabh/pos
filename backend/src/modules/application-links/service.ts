import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { generatedId } from '../../db/generated-id.js';
import { PosUser, Store } from '../../db/legacy-schema.js';
import type { Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { qrDataUrl } from '../../domain/qr.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { checkInService } from '../administration/checkins.js';
import type { CustomerApplicationProvider, StaffApplicationPackage } from './provider.js';
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
import { sourceApplicationScans } from './schema.js';

export interface ApplicationLinkDependencies {
  ephemeral: EphemeralStore;
  staffPackage?: StaffApplicationPackage;
  customerLink?: CustomerApplicationProvider;
}

/** Redis keys (ledger application-links/*). Values carry ids and expiry only, never tokens. */
export const applicationLinkKeys = {
  grant: (qrDigest: string) => `pos:staff_download:grant:${qrDigest}`,
  operator: (operatorId: string) => `pos:staff_download:operator:${operatorId}`,
  activation: (activationDigest: string) => `pos:staff_download:activation:${activationDigest}`,
  activated: (grantId: string) => `pos:staff_download:activated:${grantId}`,
  consumed: (grantId: string) => `pos:staff_download:consumed:${grantId}`,
  /** Legacy key shared with `UserToApp` (core/views.py:3197-3212). */
  shortLink: (storeId: string) => `dynamic_short_link_s_id_${storeId}`,
  lease: (storeId: string) => `pos:app_link_lease:${storeId}`,
  scan: (operationId: string) => `pos:idem:app_scan:${operationId}`,
};
const grantValue = z.object({ grantId: z.uuid(), operatorId: z.string(), expiresAt: z.number() });
const activationValue = grantValue.extend({ activationOperationId: z.uuid() });
const scanValue = z.object({ storeId: z.string(), target: z.string(), sourceLogId: z.string() });

const expired = () =>
  new AppError(
    410,
    'APPLICATION_LINK_EXPIRED',
    'This application link expired or was already used. Request a new QR code.',
  );
const unavailable = () =>
  new AppError(503, 'APPLICATION_LINK_UNAVAILABLE', 'This application link is not configured.');
const seconds = (milliseconds: number) => Math.max(1, Math.ceil(milliseconds / 1000));

export function applicationLinkService(
  config: Config,
  db: Databases,
  options: ApplicationLinkOptions,
  dependencies: ApplicationLinkDependencies,
  now: () => number = Date.now,
) {
  const store = dependencies.ephemeral,
    digest = (purpose: string, value: string) =>
      applicationDigest(config.SESSION_SECRET, purpose, value),
    token = (purpose: string, values: readonly string[]) =>
      applicationToken(config.SESSION_SECRET, purpose, values),
    checkIns = checkInService(db, config);
  const qrToken = (grantId: string) => token('staff-qr', [grantId]),
    activationToken = (grantId: string, operationId: string) =>
      token('staff-activation', [grantId, operationId]),
    /** Deterministic per-store token (ledger: replaces pos_rewrite_customer_application_links). */
    customerToken = (storeId: string) => `${storeId}.${token('customer-app', [storeId])}`;
  async function readJson<T>(key: string, schema: z.ZodType<T>) {
    const raw = await store.get(key);
    if (raw === null) return null;
    try {
      return schema.parse(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }
  /**
   * Staff installer: `MposDownloadQr` is `user_type_exempt("[2]")` (core/views.py:2794). The
   * activation and download re-check that the operator is still active and not franchise.
   */
  async function staffOperator(id: string) {
    const [row] = await db
      .get('writer')
      .select({ isActive: PosUser.is_active, userType: PosUser.user_type })
      .from(PosUser)
      .where(eq(PosUser.id, BigInt(id)))
      .limit(1);
    if (!row?.isActive || row.userType === 2)
      throw new AppError(
        403,
        'APPLICATION_LINK_DENIED',
        'This application link requires a current permitted operator.',
      );
  }
  function staffReady() {
    if (!dependencies.staffPackage) throw unavailable();
    return dependencies.staffPackage;
  }
  /** Legacy pos_to_app_logs INSERT (store_id, scanned_at) in BUSINESS_TIMEZONE wall time. */
  async function logScan(storeId: string) {
    return generatedId(
      await db
        .get('writer')
        .insert(sourceApplicationScans)
        .values({
          storeId: Number(storeId),
          scannedAt: scanWallTime(now(), config.BUSINESS_TIMEZONE),
        }),
    ).toString();
  }
  async function activeStore(storeId: string) {
    const [row] = await db
      .get('writer')
      .select({ id: Store.id })
      .from(Store)
      .where(and(eq(Store.id, BigInt(storeId)), eq(Store.is_active, true)))
      .limit(1);
    if (!row) throw expired();
  }
  /** `dynamic_short_link_s_id_{store}` EX 3600, one provider call per store at a time. */
  async function destination(storeId: string) {
    const provider = dependencies.customerLink;
    if (!provider) throw unavailable();
    const key = applicationLinkKeys.shortLink(storeId),
      lease = applicationLinkKeys.lease(storeId);
    for (let attempt = 0; attempt < 50; attempt++) {
      const cached = await store.get(key);
      if (cached !== null) return provider.accepts(cached) ? cached : provider.fallback;
      const owner = randomUUID();
      if (await store.set(lease, owner, { NX: true, PX: 15000 })) {
        try {
          const target = await provider.destination(storeId);
          await store.set(key, target, { EX: 3600 });
          return target;
        } finally {
          await store.delIfEquals(lease, owner).catch(() => false);
        }
      }
      await sleep(200);
    }
    throw new AppError(
      409,
      'CUSTOMER_APPLICATION_PREPARING',
      'The application link is being prepared. Try again shortly.',
    );
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
      return {
        staffAvailable: Boolean(user.userType !== 2 && dependencies.staffPackage),
        customerAvailable: Boolean(dependencies.customerLink),
        checkedInStore: await checkIns.checkedInStore(user.id),
        qrPeriodSeconds: options.MPOS_DOWNLOAD_QR_EXP_SEC,
      };
    },
    /**
     * `MposDownloadQr` / `AjaxGenMposDownloadQR` (core/views.py:2795-2897) for the signed-in
     * operator only. Within one QR period the same grant is returned (legacy shows the same TOTP).
     */
    async issueStaff(user: Principal, value: { operationId: string }) {
      operation.parse(value);
      staffReady();
      await staffOperator(user.id);
      const timestamp = now();
      let grant = await readJson(applicationLinkKeys.operator(user.id), grantValue);
      if (!grant || grant.expiresAt <= timestamp || grant.operatorId !== user.id) {
        grant = {
          grantId: randomUUID(),
          operatorId: user.id,
          expiresAt: packageQrExpiry(timestamp, options.MPOS_DOWNLOAD_QR_EXP_SEC),
        };
        const ttl = seconds(grant.expiresAt - timestamp),
          encoded = JSON.stringify(grant);
        await store.set(applicationLinkKeys.grant(digest('qr', qrToken(grant.grantId))), encoded, {
          EX: ttl,
        });
        await store.set(applicationLinkKeys.operator(user.id), encoded, { EX: ttl });
      }
      const url = new URL('/application-links/staff', config.WEB_ORIGIN);
      url.hash = qrToken(grant.grantId);
      return {
        id: grant.grantId,
        url: url.href,
        qrDataUrl: await qrDataUrl(url.href),
        serverNow: now(),
        expiresAt: grant.expiresAt,
      };
    },
    /**
     * `MposDownloadThankYou` (core/views.py:2900-2946): a valid QR activates one download for
     * `MPOS_DOWNLOAD_LINK_EXP` and is rotated (single activation per QR).
     */
    async activateStaff(value: { operationId: string; token: string }) {
      const input = staffActivation.parse(value);
      staffReady();
      const grant = await readJson(
        applicationLinkKeys.grant(digest('qr', input.token)),
        grantValue,
      );
      if (!grant || grant.expiresAt <= now() || !sameToken(input.token, qrToken(grant.grantId)))
        throw expired();
      await staffOperator(grant.operatorId);
      const linkSeconds = options.MPOS_DOWNLOAD_LINK_EXP,
        claimed = await store.set(applicationLinkKeys.activated(grant.grantId), input.operationId, {
          NX: true,
          EX: linkSeconds,
        });
      if (
        !claimed &&
        (await store.get(applicationLinkKeys.activated(grant.grantId))) !== input.operationId
      )
        throw expired();
      const activation = activationToken(grant.grantId, input.operationId),
        key = applicationLinkKeys.activation(digest('activation', activation));
      let record = await readJson(key, activationValue);
      if (!record) {
        record = {
          ...grant,
          activationOperationId: input.operationId,
          expiresAt: now() + linkSeconds * 1000,
        };
        await store.set(key, JSON.stringify(record), { EX: linkSeconds });
        // Legacy `create_secret` after a successful check: the next QR is a new one.
        const current = await readJson(applicationLinkKeys.operator(grant.operatorId), grantValue);
        if (current?.grantId === grant.grantId)
          await store.delIfEquals(
            applicationLinkKeys.operator(grant.operatorId),
            JSON.stringify(current),
          );
      }
      return { activationToken: activation, serverNow: now(), expiresAt: record.expiresAt };
    },
    /** `MposDownloadLink` (core/views.py:2949-2984): one download per activation, then the APK. */
    async downloadStaff(
      value: { operationId: string; activationToken: string },
      signal?: AbortSignal,
    ) {
      const input = staffContent.parse(value),
        source = staffReady();
      const record = await readJson(
        applicationLinkKeys.activation(digest('activation', input.activationToken)),
        activationValue,
      );
      if (
        !record ||
        record.expiresAt <= now() ||
        !sameToken(
          input.activationToken,
          activationToken(record.grantId, record.activationOperationId),
        )
      )
        throw expired();
      await staffOperator(record.operatorId);
      const consumed = applicationLinkKeys.consumed(record.grantId);
      if (
        !(await store.set(consumed, input.operationId, {
          NX: true,
          EX: options.MPOS_DOWNLOAD_LINK_EXP,
        })) &&
        (await store.get(consumed)) !== input.operationId
      )
        throw expired();
      signal?.throwIfAborted();
      return source.open(signal);
    },
    /** `MposUserDownloadApp` (core/views.py:3161-3179): QR for the operator's check-in store. */
    async issueCustomer(user: Principal) {
      if (config.DEMO_MODE || !dependencies.customerLink) throw unavailable();
      const selected = await checkIns.checkedInStore(user.id);
      if (!selected)
        throw new AppError(
          409,
          'CHECK_IN_REQUIRED',
          'Check in to a store before creating its application QR.',
        );
      const [row] = await db
        .get('writer')
        .select({ id: Store.id, name: Store.store_name })
        .from(Store)
        .where(eq(Store.id, BigInt(selected)))
        .limit(1);
      if (!row || row.id < 1n || row.id > 2147483647n)
        throw new AppError(
          409,
          'APPLICATION_STORE_UNSUPPORTED',
          'This store cannot be recorded by the application scan audit.',
        );
      const url = new URL('/application-links/customer', config.WEB_ORIGIN);
      url.hash = customerToken(String(row.id));
      return {
        storeId: String(row.id),
        storeName: row.name,
        url: url.href,
        qrDataUrl: await qrDataUrl(url.href),
      };
    },
    /**
     * Token scan from the public landing page. Same effects as legacy `UserToApp`; a retried
     * operation (Redis receipt, EX 3600) does not log a second pos_to_app_logs row.
     */
    async scanCustomer(value: { operationId: string; token: string }) {
      if (config.DEMO_MODE || !dependencies.customerLink) throw unavailable();
      const input = customerScan.parse(value),
        storeId = input.token.split('.')[0]!;
      if (!sameToken(input.token, customerToken(storeId))) throw expired();
      const receiptKey = applicationLinkKeys.scan(input.operationId),
        previous = await readJson(receiptKey, scanValue);
      if (previous) {
        if (previous.storeId !== storeId)
          throw new AppError(
            409,
            'APPLICATION_OPERATION_CONFLICT',
            'This operation belongs to another application link.',
          );
        return { destination: previous.target };
      }
      await activeStore(storeId);
      const sourceLogId = await logScan(storeId),
        target = await destination(storeId);
      await store.set(receiptKey, JSON.stringify({ storeId, target, sourceLogId }), { EX: 3600 });
      return { destination: target };
    },
    /**
     * Legacy `GET /user_to_app?store_id=` for already printed QR codes: logs the scan, then
     * redirects. Security decisions: bound INSERT (legacy formats SQL), active stores only.
     */
    async scanLegacy(storeId: string) {
      if (config.DEMO_MODE || !dependencies.customerLink) throw unavailable();
      await activeStore(storeId);
      await logScan(storeId);
      return destination(storeId);
    },
  };
}
/**
 * @deprecated The grant and receipt tables are gone; Redis TTLs expire the state. Kept so
 * `src/auth/security-worker.ts` (W3) compiles until its call is removed.
 */
export async function pruneApplicationLinks(_db: Databases, _timestamp = Date.now()) {}
