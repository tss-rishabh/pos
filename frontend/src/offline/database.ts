import Dexie, { type Table, type EntityTable } from 'dexie';
import type { Draft, DraftMutation, Principal, Product, Store, Counter } from '../api/types';
import type {
  LocalCashAuthorization,
  LocalCashDevice,
  LocalCashReceipt,
  LocalCashSync,
} from './cash/storage-types';
import type { WalletCommand, WalletCommandOwner } from './benefits/storage';
import type { FastCashCommand, FastCashOwner } from './fast-cash/contracts';
import type { PerformanceCapture, PerformanceCommand } from './performance/contracts';

export interface LocalDraft extends Draft {
  ownerId: string;
  updatedAt: number;
  createdAt: number;
}
export interface Operation {
  id: string;
  ownerId: string;
  draftId: string;
  storeId: string;
  payload: DraftMutation;
  state: 'pending' | 'retry' | 'conflict' | 'rejected';
  attempts: number;
  nextAttemptAt: number;
  message?: string;
}
export interface ReviewSnapshot {
  ownerId: string;
  draftId: string;
  snapshot: LocalDraft;
  createdAt: number;
  checkoutId?: string;
}
export interface ClearedDraft {
  ownerId: string;
  draftId: string;
  storeId: string;
  counterId: string;
  checkoutId: string;
  clearOperationId: string;
  draftVersion: number;
  clearedAt: number;
  reason: 'cart-clear' | 'customer-detach';
  preservedDraftId: string | null;
  replacementDraftId: string;
}
export type CompletedSale = {
  ownerId: string;
  draftId: string;
  storeId: string;
  orderId: string;
  transactionId: string;
  completedAt: number;
} & (
  | { source: 'counter'; receiptId: string; paymentAttemptId: string }
  | { source: 'prepaid'; receiptId: string; checkoutId: string; checkoutOperationId: string }
  | { source?: undefined; receiptId?: undefined; paymentAttemptId: string }
);
interface CachedProduct extends Product {
  ownerId: string;
  storeId: string;
  cachedAt: number;
}
interface Session {
  id: 'current';
  user: Principal;
  expiresAt: number;
}
interface Lookup {
  ownerId: string;
  stores: Store[];
  counters: Counter[];
}
export interface CachedBarcode {
  ownerId: string;
  storeId: string;
  barcode: string;
  productId: string;
  observedAt: number;
}
export class PosDatabase extends Dexie {
  drafts!: Table<LocalDraft, [string, string]>;
  operations!: EntityTable<Operation, 'id'>;
  catalog!: Table<CachedProduct, [string, string, string]>;
  catalogBarcodes!: Table<CachedBarcode, [string, string, string, string]>;
  sessions!: EntityTable<Session, 'id'>;
  lookups!: EntityTable<Lookup, 'ownerId'>;
  completedSales!: Table<CompletedSale, [string, string]>;
  reviewSnapshots!: Table<ReviewSnapshot, [string, string]>;
  clearedDrafts!: Table<ClearedDraft, [string, string]>;
  offlineCashDevices!: Table<LocalCashDevice, [string, string]>;
  offlineCashAuthorizations!: EntityTable<LocalCashAuthorization, 'id'>;
  offlineCashReceipts!: Table<LocalCashReceipt, [string, string]>;
  offlineCashSync!: EntityTable<LocalCashSync, 'receiptId'>;
  walletCommands!: EntityTable<WalletCommand, 'id'>;
  walletCommandOwners!: EntityTable<WalletCommandOwner, 'ownerId'>;
  fastCashCommands!: EntityTable<FastCashCommand, 'id'>;
  fastCashOwners!: Table<FastCashOwner, [string, string, string]>;
  performanceCaptures!: Table<PerformanceCapture, [string, string]>;
  performanceCommands!: EntityTable<PerformanceCommand, 'id'>;
  constructor(name = 'souled-pos-v1') {
    super(name, { chromeTransactionDurability: 'strict' });
    this.version(1).stores({
      drafts: '[ownerId+id],ownerId,[ownerId+storeId],updatedAt',
      operations: 'id,ownerId,&[ownerId+draftId],nextAttemptAt',
      catalog: '[ownerId+storeId+id],[ownerId+storeId],ownerId',
      sessions: 'id',
      lookups: 'ownerId',
    });
    this.version(2).stores({ completedSales: '[ownerId+draftId],ownerId,completedAt' });
    this.version(3).stores({ reviewSnapshots: '[ownerId+draftId],ownerId,createdAt' });
    this.version(4).stores({ clearedDrafts: '[ownerId+draftId],ownerId,clearedAt' });
    this.version(5).stores({
      offlineCashDevices: '[ownerId+deviceId],ownerId,[ownerId+storeId+counterId]',
      offlineCashAuthorizations:
        'id,ownerId,[ownerId+storeId+counterId],[ownerId+storeId+counterId+expiresAt],deviceId',
      offlineCashReceipts:
        '[ownerId+receiptId],&[ownerId+draftId],&[authorizationId+sequence],ownerId,storeId,[ownerId+storeId],[ownerId+storeId+completedAt],syncState,completedAt',
      offlineCashSync: 'receiptId,ownerId,storeId,[ownerId+state],[storeId+state],nextAttemptAt',
    });
    this.version(6).stores({
      walletCommands: 'id,ownerId,[ownerId+createdAt],[ownerId+state]',
      walletCommandOwners: 'ownerId',
    });
    this.version(7).stores({
      fastCashCommands: 'id,ownerId,[ownerId+storeId+counterId],[ownerId+createdAt]',
      fastCashOwners: '[ownerId+storeId+counterId],ownerId',
    });
    this.version(8).stores({
      performanceCaptures: '[ownerId+draftId],ownerId,[ownerId+checkoutId]',
      performanceCommands: 'id,ownerId,[ownerId+storeId+counterId+state+nextAttemptAt]',
    });
    this.version(9)
      .stores({
        offlineCashSync:
          'receiptId,ownerId,storeId,[ownerId+state],[storeId+state],nextAttemptAt,[ownerId+storeId+counterId+state],[storeId+counterId+state]',
      })
      .upgrade(async (transaction) => {
        const jobs = transaction.table<LocalCashSync, string>('offlineCashSync'),
          receipts = transaction.table<LocalCashReceipt, [string, string]>('offlineCashReceipts');
        // Only queue routing metadata changes. Never replace a signed receipt,
        // create another cash claim or clear an incomplete/uncertain record.
        for (const id of await jobs.toCollection().primaryKeys()) {
          const job = await jobs.get(id);
          if (!job) continue;
          const receipt = await receipts.get([job.ownerId, job.receiptId]);
          if (
            receipt?.ownerId === job.ownerId &&
            receipt.receiptId === job.receiptId &&
            receipt.storeId === job.storeId &&
            receipt.counterId === receipt.envelope.receipt.counterId
          )
            await jobs.update(id, { counterId: receipt.counterId });
        }
      });
    this.version(10).stores({
      catalogBarcodes: '[ownerId+storeId+barcode+productId],[ownerId+storeId+barcode],ownerId',
    });
  }
}
export const db = new PosDatabase();
export async function eraseOperator(ownerId: string) {
  await db.transaction(
    'rw',
    [
      db.drafts,
      db.operations,
      db.catalog,
      db.catalogBarcodes,
      db.sessions,
      db.lookups,
      db.completedSales,
      db.reviewSnapshots,
      db.clearedDrafts,
      db.performanceCaptures,
      db.performanceCommands,
    ],
    async () => {
      await Promise.all([
        db.drafts.where('ownerId').equals(ownerId).delete(),
        db.operations.where('ownerId').equals(ownerId).delete(),
        db.catalog.where('ownerId').equals(ownerId).delete(),
        db.catalogBarcodes.where('ownerId').equals(ownerId).delete(),
        db.sessions.clear(),
        db.lookups.delete(ownerId),
        db.completedSales.where('ownerId').equals(ownerId).delete(),
        db.reviewSnapshots.where('ownerId').equals(ownerId).delete(),
        db.clearedDrafts.where('ownerId').equals(ownerId).delete(),
        db.performanceCaptures.where('ownerId').equals(ownerId).delete(),
        db.performanceCommands.where('ownerId').equals(ownerId).delete(),
      ]);
    },
  );
}
