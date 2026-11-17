import type {
  CashPriceSnapshot,
  CashReceiptAcceptance,
  DevicePublicKey,
  SignedCashAuthorization,
  SignedCashReceipt,
} from './contracts';

export interface LocalCashDevice {
  ownerId: string;
  deviceId: string;
  storeId: string;
  counterId: string;
  privateKey: CryptoKey;
  publicKey: DevicePublicKey;
  createdAt: number;
}
export interface LocalCashAuthorization {
  id: string;
  ownerId: string;
  deviceId: string;
  storeId: string;
  counterId: string;
  envelope: SignedCashAuthorization;
  issuedAt: number;
  expiresAt: number;
  snapshot: CashPriceSnapshot;
  serverKey: DevicePublicKey;
  nextSequence: number;
  usedCents: number;
  lastCompletedAt: number;
  revokedAt: number | null;
}
export interface LocalCashReceipt {
  ownerId: string;
  receiptId: string;
  draftId: string;
  storeId: string;
  counterId: string;
  authorizationId: string;
  sequence: number;
  envelope: SignedCashReceipt;
  completedAt: number;
  acceptance: CashReceiptAcceptance | null;
  syncState: 'pending' | 'accepted' | 'conflicted' | 'imported';
  importedAt: number | null;
  preservedDraftId: string | null;
  replacementDraftId: string;
}
export interface LocalCashSync {
  receiptId: string;
  ownerId: string;
  storeId: string;
  /** Backfilled from the immutable receipt when upgrading older ledgers. */
  counterId?: string;
  state: 'pending' | 'sending' | 'retry' | 'accepted' | 'imported';
  attempts: number;
  nextAttemptAt: number;
  claimId: string | null;
  claimedAt: number | null;
  errorCode: string | null;
  autoImportEligible?: boolean;
  orderImport?: LocalCashOrderImport;
}

/** The same saved intent is reused after an uncertain order import; cash is never collected again. */
export interface LocalCashOrderImport {
  operationId: string;
  actorId: string;
  expectedVersion: number;
  state: 'dispatching' | 'uncertain' | 'blocked' | 'confirmed';
  attempts: number;
  attemptId: string | null;
  dispatchedAt: number;
  errorCode: string | null;
}
