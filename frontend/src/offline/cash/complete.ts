import Dexie from 'dexie';
import { db, type LocalDraft, type PosDatabase } from '../database';
import { checkedSnapshot, draftContents } from '../review-snapshot';
import { canonicalCashJson } from './canonical';
import {
  cashReceiptSchema,
  MAX_CASH_CENTS,
  type CashPriceSnapshot,
  type DevicePublicKey,
  type SignedCashAuthorization,
} from './contracts';
import { cashLines, cashTotals } from './evidence';
import {
  cashDigest,
  signCashReceipt,
  verifyCashAuthorization,
  verifyCashDeviceReceipt,
} from './crypto';
import type { LocalCashReceipt } from './storage-types';
import { offlineCashReadyEvent } from './events';

function assertNotSignedOut(signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    if (localStorage.getItem('pos-pending-logout')) throw new Error('Signed out.');
  } catch {
    throw new Error('Sign in again before completing an offline cash sale.');
  }
}
async function activeOperator(
  database: PosDatabase,
  ownerId: string,
  storeId: string,
  now: number,
  signal: AbortSignal,
) {
  assertNotSignedOut(signal);
  const session = await database.sessions.get('current');
  if (
    !session ||
    session.user.id !== ownerId ||
    session.expiresAt <= now ||
    (!(session.user.role === 1 && session.user.userType === 1) &&
      !session.user.storeIds.includes(storeId))
  )
    throw new Error('A valid matching cached operator session is required for offline cash.');
}

export async function activateCashAuthorization(
  ownerId: string,
  supplied: SignedCashAuthorization,
  snapshot: CashPriceSnapshot,
  serverKey: DevicePublicKey,
  signal: AbortSignal,
  database: PosDatabase = db,
  now = Date.now(),
) {
  assertNotSignedOut(signal);
  const envelope = await verifyCashAuthorization(supplied, snapshot, serverKey),
    grant = envelope.authorization;
  if (grant.operatorId !== ownerId || now < grant.issuedAt || now >= grant.expiresAt)
    throw new Error('This offline cash authorization is unavailable or expired.');
  return database.transaction(
    'rw',
    [database.sessions, database.offlineCashDevices, database.offlineCashAuthorizations],
    async () => {
      await activeOperator(database, ownerId, grant.storeId, now, signal);
      const device = await database.offlineCashDevices.get([ownerId, grant.deviceId]);
      if (
        !device ||
        device.storeId !== grant.storeId ||
        device.counterId !== grant.counterId ||
        (await Dexie.waitFor(cashDigest(device.publicKey))) !== grant.deviceKeyHash
      )
        throw new Error('This authorization does not match the protected device key.');
      const existing = await database.offlineCashAuthorizations.get(grant.id);
      if (existing) {
        if (
          existing.ownerId !== ownerId ||
          canonicalCashJson(existing.envelope) !== canonicalCashJson(envelope) ||
          canonicalCashJson(existing.snapshot) !== canonicalCashJson(snapshot)
        )
          throw new Error(
            'The offline authorization reference is already bound to different evidence.',
          );
        if (existing.revokedAt !== null)
          throw new Error('This offline cash authorization was replaced or revoked.');
        return existing;
      }
      const scope = await database.offlineCashAuthorizations
        .where('[ownerId+storeId+counterId]')
        .equals([ownerId, grant.storeId, grant.counterId])
        .toArray();
      if (scope.some((value) => value.issuedAt >= grant.issuedAt))
        throw new Error(
          'A newer or conflicting cash authorization is already saved. Keep its receipt sequence and prices.',
        );
      const value = {
        id: grant.id,
        ownerId,
        deviceId: grant.deviceId,
        storeId: grant.storeId,
        counterId: grant.counterId,
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        envelope,
        snapshot,
        serverKey,
        nextSequence: 1,
        usedCents: 0,
        lastCompletedAt: grant.issuedAt,
        revokedAt: null,
      };
      assertNotSignedOut(signal);
      await database.offlineCashAuthorizations
        .where('[ownerId+storeId+counterId]')
        .equals([ownerId, grant.storeId, grant.counterId])
        .modify({ revokedAt: now });
      await database.offlineCashAuthorizations.add(value);
      return value;
    },
  );
}

/** One durable local commit means cash received, immutable receipt and sync work. */
export async function completeOfflineCash(
  candidate: LocalDraft,
  authorizationId: string,
  cashReceivedCents: number,
  signal: AbortSignal,
  database: PosDatabase = db,
  now = Date.now(),
) {
  assertNotSignedOut(signal);
  const verified = await database.offlineCashAuthorizations.get(authorizationId);
  if (!verified) throw new Error('Enable and cache offline cash authorization while online first.');
  await verifyCashAuthorization(verified.envelope, verified.snapshot, verified.serverKey);
  const verifiedGrant = canonicalCashJson(verified.envelope),
    verifiedPrices = canonicalCashJson(verified.snapshot);
  const completed = await database.transaction(
    'rw',
    [
      database.sessions,
      database.drafts,
      database.operations,
      database.reviewSnapshots,
      database.completedSales,
      database.clearedDrafts,
      database.offlineCashDevices,
      database.offlineCashAuthorizations,
      database.offlineCashReceipts,
      database.offlineCashSync,
    ],
    async () => {
      await activeOperator(database, candidate.ownerId, candidate.storeId, now, signal);
      const key: [string, string] = [candidate.ownerId, candidate.id],
        existing = await database.offlineCashReceipts
          .where('[ownerId+draftId]')
          .equals(key)
          .first();
      if (existing) {
        const receipt = cashReceiptSchema.parse(existing.envelope.receipt);
        if (
          receipt.authorizationId !== authorizationId ||
          receipt.draftVersion !== candidate.updatedAt ||
          receipt.operatorId !== candidate.ownerId ||
          receipt.storeId !== candidate.storeId ||
          receipt.counterId !== candidate.counterId ||
          receipt.cashReceivedCents !== cashReceivedCents
        )
          throw new Error('This sale already has different immutable cash evidence.');
        const device = await database.offlineCashDevices.get([candidate.ownerId, receipt.deviceId]);
        if (
          !device ||
          !(await Dexie.waitFor(verifyCashDeviceReceipt(existing.envelope, device.publicKey)))
        )
          throw new Error('The saved cash receipt device signature could not be verified.');
        assertNotSignedOut(signal);
        return { alreadyCompleted: true, value: existing };
      }
      if ((await database.completedSales.get(key)) || (await database.clearedDrafts.get(key)))
        throw new Error('This sale was already paid or cleared. Its evidence has been kept.');
      const review = await database.reviewSnapshots.get(key);
      if (!review || review.checkoutId)
        throw new Error(
          'Use a new locally reviewed sale for offline cash. An online checkout must be reconciled first.',
        );
      const original = checkedSnapshot(review, candidate.ownerId, candidate.id);
      if (
        original.updatedAt !== candidate.updatedAt ||
        original.storeId !== candidate.storeId ||
        original.counterId !== candidate.counterId ||
        original.customerId !== null
      )
        throw new Error('Offline cash requires the original walk-in sale snapshot.');
      const authorization = await database.offlineCashAuthorizations.get(authorizationId);
      if (
        !authorization ||
        canonicalCashJson(authorization.envelope) !== verifiedGrant ||
        canonicalCashJson(authorization.snapshot) !== verifiedPrices
      )
        throw new Error('The offline cash authorization changed. Try again.');
      const grant = authorization.envelope.authorization;
      if (
        grant.operatorId !== original.ownerId ||
        grant.storeId !== original.storeId ||
        grant.counterId !== original.counterId ||
        authorization.revokedAt !== null ||
        now < grant.issuedAt ||
        now < authorization.lastCompletedAt ||
        now < original.updatedAt ||
        now >= grant.expiresAt ||
        now >= authorization.snapshot.expiresAt
      )
        throw new Error(
          'Offline cash authorization expired, changed or has an invalid device clock. Reconnect before completing this sale.',
        );
      const device = await database.offlineCashDevices.get([original.ownerId, grant.deviceId]);
      if (
        !device ||
        device.storeId !== original.storeId ||
        device.counterId !== original.counterId ||
        (await Dexie.waitFor(cashDigest(device.publicKey))) !== grant.deviceKeyHash
      )
        throw new Error('The protected offline cash device key is unavailable.');
      const lines = cashLines(authorization.snapshot, original.lines),
        totals = cashTotals(lines);
      if (
        !Number.isSafeInteger(cashReceivedCents) ||
        cashReceivedCents < totals.payableCents ||
        cashReceivedCents > MAX_CASH_CENTS ||
        totals.payableCents <= 0 ||
        totals.payableCents > grant.maxReceiptCents ||
        authorization.usedCents + totals.payableCents > grant.maxTotalCents ||
        authorization.nextSequence > grant.receiptCount
      )
        throw new Error('Cash received or this sale exceeds the signed offline cash limits.');
      const previous = await database.offlineCashReceipts
        .where('[ownerId+storeId]')
        .equals([original.ownerId, original.storeId])
        .toArray();
      for (const line of lines) {
        const stock = authorization.snapshot.products.find(
          (product) => product.productId === line.productId,
        )!.cachedStock;
        const sold = previous
          .filter(
            (sale) => sale.importedAt === null || sale.importedAt > authorization.snapshot.issuedAt,
          )
          .reduce(
            (sum, sale) =>
              sum +
              sale.envelope.receipt.lines
                .filter((entry) => entry.productId === line.productId)
                .reduce((quantity, entry) => quantity + entry.quantity, 0),
            0,
          );
        if (line.quantity > stock - sold)
          throw new Error(
            'The remaining cached stock is insufficient. Reconnect to refresh stock before completing this sale.',
          );
      }
      const latest = await database.drafts.get(key);
      if (!latest)
        throw new Error(
          'This local sale is no longer available. Its existing evidence has been kept.',
        );
      const sequence = authorization.nextSequence,
        receipt = cashReceiptSchema.parse({
          version: 1,
          id: crypto.randomUUID(),
          authorizationId,
          deviceId: device.deviceId,
          operatorId: original.ownerId,
          storeId: original.storeId,
          counterId: original.counterId,
          businessDate: grant.businessDate,
          draftId: original.id,
          draftVersion: original.updatedAt,
          sequence,
          receiptNumber: `${grant.receiptPrefix}-${String(sequence).padStart(4, '0')}`,
          completedAt: now,
          currency: 'INR',
          snapshotId: grant.snapshotId,
          snapshotHash: grant.snapshotHash,
          stockPolicy: 'cached-stock-manager',
          lines,
          ...totals,
          cashReceivedCents,
          changeCents: cashReceivedCents - totals.payableCents,
        });
      const envelope = await Dexie.waitFor(signCashReceipt(receipt, device.privateKey));
      if (!(await Dexie.waitFor(verifyCashDeviceReceipt(envelope, device.publicKey))))
        throw new Error('The protected device key does not match its registered identity.');
      const replacementDraftId = crypto.randomUUID(),
        changed = draftContents(latest) !== draftContents(original),
        preservedDraftId = changed ? replacementDraftId : null;
      await database.drafts.add(
        changed
          ? { ...latest, id: replacementDraftId, version: 0, createdAt: now, updatedAt: now }
          : {
              ...original,
              id: replacementDraftId,
              customerId: null,
              lines: [],
              version: 0,
              createdAt: now,
              updatedAt: now,
            },
      );
      const value: LocalCashReceipt = {
        ownerId: original.ownerId,
        receiptId: receipt.id,
        draftId: original.id,
        storeId: original.storeId,
        counterId: original.counterId,
        authorizationId,
        sequence,
        envelope,
        completedAt: now,
        acceptance: null,
        syncState: 'pending',
        importedAt: null,
        preservedDraftId,
        replacementDraftId,
      };
      await database.offlineCashReceipts.add(value);
      await database.offlineCashSync.add({
        receiptId: receipt.id,
        ownerId: original.ownerId,
        storeId: original.storeId,
        counterId: original.counterId,
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        claimId: null,
        claimedAt: null,
        errorCode: null,
      });
      await database.offlineCashAuthorizations.update(authorizationId, {
        nextSequence: sequence + 1,
        usedCents: authorization.usedCents + totals.payableCents,
        lastCompletedAt: now,
      });
      await database.drafts.delete(key);
      await database.reviewSnapshots.delete(key);
      await database.operations.where('[ownerId+draftId]').equals(key).delete();
      assertNotSignedOut(signal);
      return { alreadyCompleted: false, value };
    },
  );
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(offlineCashReadyEvent));
  } catch {
    /* A wake notification cannot change committed cash or its receipt. */
  }
  return completed;
}
