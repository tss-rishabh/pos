import { eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { AppError } from '../../../domain/errors.js';
import { cashDigest } from './crypto.js';
import { devicePublicKeySchema, type DevicePublicKey } from './contracts.js';
import { offlineCashSigningKeys } from './schema.js';

/** Public keys are append-only. Existing keys need no UPDATE/global writer lock. */
export async function retainCashSigningKey(
  tx: AdministrationTransaction,
  keyId: string,
  supplied: DevicePublicKey,
  createdAt: number,
) {
  const publicKey = devicePublicKeySchema.parse(supplied);
  const invalid = () =>
    new AppError(
      503,
      'OFFLINE_CASH_SIGNING_KEY_INVALID',
      'The trusted offline signing key could not be verified.',
    );
  if (cashDigest(publicKey) !== keyId) throw invalid();
  let [saved] = await tx
    .select()
    .from(offlineCashSigningKeys)
    .where(eq(offlineCashSigningKeys.keyId, keyId))
    .limit(1);
  if (!saved) {
    await tx
      .insert(offlineCashSigningKeys)
      .values({ keyId, publicKey: JSON.stringify(publicKey), createdAt })
      .onDuplicateKeyUpdate({ set: { keyId } });
    [saved] = await tx
      .select()
      .from(offlineCashSigningKeys)
      .where(eq(offlineCashSigningKeys.keyId, keyId))
      .limit(1)
      .for('share');
  }
  if (
    !saved ||
    cashDigest(devicePublicKeySchema.parse(JSON.parse(saved.publicKey) as unknown)) !== keyId
  )
    throw invalid();
}
