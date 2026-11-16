import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { AppError } from '../../../domain/errors.js';
import { canonicalCashJson } from './canonical.js';
import {
  devicePublicKeySchema,
  signedCashAuthorizationSchema,
  signedCashReceiptSchema,
  type CashAuthorization,
  type DevicePublicKey,
  type SignedCashAuthorization,
  type SignedCashReceipt,
} from './contracts.js';
import {
  cashImportProofDataSchema,
  signedCashImportProofSchema,
  type CashImportProofData,
  type SignedCashImportProof,
} from './import-proof-contracts.js';

export const cashDigest = (value: unknown) =>
  createHash('sha256').update(canonicalCashJson(value)).digest('hex');
export function offlineCashSigner(privatePem: string) {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Unsupported key.');
  } catch {
    throw new AppError(
      503,
      'OFFLINE_CASH_NOT_CONFIGURED',
      'Offline cash authorization is not configured.',
    );
  }
  const publicKey = createPublicKey(privateKey),
    publicJwk = devicePublicKeySchema.parse(publicKey.export({ format: 'jwk' })),
    keyId = cashDigest(publicJwk);
  return {
    keyId,
    publicKey: publicJwk,
    authorize(authorization: CashAuthorization): SignedCashAuthorization {
      return signedCashAuthorizationSchema.parse({
        authorization,
        keyId,
        signature: sign(null, Buffer.from(canonicalCashJson(authorization)), privateKey).toString(
          'base64url',
        ),
      });
    },
    verify(supplied: SignedCashAuthorization) {
      return verifyCashAuthorizationWithKey(publicJwk, supplied);
    },
    sealImport(supplied: CashImportProofData): SignedCashImportProof {
      const proof = cashImportProofDataSchema.parse(supplied);
      return {
        proof,
        keyId,
        signature: sign(null, Buffer.from(canonicalCashJson(proof)), privateKey).toString(
          'base64url',
        ),
      };
    },
  };
}
export function verifyCashAuthorizationWithKey(
  publicKey: DevicePublicKey,
  supplied: SignedCashAuthorization,
) {
  try {
    const key = devicePublicKeySchema.parse(publicKey),
      envelope = signedCashAuthorizationSchema.parse(supplied);
    return (
      cashDigest(key) === envelope.keyId &&
      verify(
        null,
        Buffer.from(canonicalCashJson(envelope.authorization)),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(envelope.signature, 'base64url'),
      )
    );
  } catch {
    return false;
  }
}
export function verifyCashImportProofSignature(
  publicKey: DevicePublicKey,
  supplied: SignedCashImportProof,
) {
  return verifiedCashImportProof(publicKey, supplied) !== null;
}
export function verifiedCashImportProof(publicKey: DevicePublicKey, supplied: unknown): SignedCashImportProof | null {
  try {
    const key = devicePublicKeySchema.parse(publicKey),
      envelope = signedCashImportProofSchema.parse(supplied);
    return (
      cashDigest(key) === envelope.keyId &&
      verify(
        null,
        Buffer.from(canonicalCashJson(envelope.proof)),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(envelope.signature, 'base64url'),
      )
    ) ? envelope : null;
  } catch {
    return null;
  }
}
export function verifyDeviceCashReceipt(publicKey: DevicePublicKey, supplied: SignedCashReceipt) {
  const key = devicePublicKeySchema.parse(publicKey),
    receipt = signedCashReceiptSchema.parse(supplied);
  try {
    return verify(
      null,
      Buffer.from(canonicalCashJson(receipt.receipt)),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(receipt.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
