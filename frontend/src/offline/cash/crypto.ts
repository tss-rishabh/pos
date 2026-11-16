import { canonicalCashJson } from './canonical';
import { assertCashSnapshot } from './evidence';
import {
  cashPriceSnapshotSchema,
  devicePublicKeySchema,
  signedCashAuthorizationSchema,
  cashReceiptSchema,
  signedCashReceiptSchema,
  type CashPriceSnapshot,
  type DevicePublicKey,
  type SignedCashAuthorization,
  type CashReceipt,
  type SignedCashReceipt,
} from './contracts';

const bytes = (value: unknown) => new TextEncoder().encode(canonicalCashJson(value));
function decode(value: string): Uint8Array<ArrayBuffer> {
  const input = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(input, (character) => character.charCodeAt(0));
}
const encode = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

export async function cashDigest(value: unknown) {
  const hash = await crypto.subtle.digest('SHA-256', bytes(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function createCashDeviceKeys() {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  if (!('privateKey' in keys) || !('publicKey' in keys))
    throw new Error('Offline cash requires a protected device key pair.');
  const exported = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const publicKey = devicePublicKeySchema.parse({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
  });
  return { privateKey: keys.privateKey, publicKey };
}
export async function verifyCashAuthorization(
  supplied: SignedCashAuthorization,
  suppliedSnapshot: CashPriceSnapshot,
  pinnedServerKey: DevicePublicKey,
) {
  try {
    const envelope = signedCashAuthorizationSchema.parse(supplied),
      snapshot = cashPriceSnapshotSchema.parse(suppliedSnapshot),
      key = devicePublicKeySchema.parse(pinnedServerKey);
    if ((await cashDigest(key)) !== envelope.keyId) throw new Error('Key mismatch.');
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        imported,
        decode(envelope.signature),
        bytes(envelope.authorization),
      ))
    )
      throw new Error('Signature mismatch.');
    assertCashSnapshot(envelope.authorization, snapshot, await cashDigest(snapshot));
    return envelope;
  } catch {
    throw new Error(
      'The saved offline cash authorization or price snapshot could not be verified.',
    );
  }
}
export async function signCashReceipt(supplied: CashReceipt, privateKey: CryptoKey) {
  const receipt = cashReceiptSchema.parse(supplied);
  if (
    privateKey.type !== 'private' ||
    privateKey.algorithm.name !== 'Ed25519' ||
    privateKey.extractable ||
    !privateKey.usages.includes('sign')
  )
    throw new Error('The protected offline cash device key is unavailable.');
  const signature = await crypto.subtle.sign('Ed25519', privateKey, bytes(receipt));
  return { receipt, signature: encode(signature) };
}

export async function verifyCashDeviceReceipt(
  supplied: SignedCashReceipt,
  publicKey: DevicePublicKey,
) {
  try {
    const envelope = signedCashReceiptSchema.parse(supplied),
      key = devicePublicKeySchema.parse(publicKey);
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(
      'Ed25519',
      imported,
      decode(envelope.signature),
      bytes(envelope.receipt),
    );
  } catch {
    return false;
  }
}
