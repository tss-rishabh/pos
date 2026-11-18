import { and, desc, eq } from 'drizzle-orm';
import type { AdministrationTransaction } from '../administration/checkins.js';
import { publicContactChallenge } from './contracts.js';
import { contactAttemptLimit } from './limits.js';
import { openContactEnvelope } from './crypto.js';
import type { CustomerContactOptions } from './options.js';
import { customerContactChallenges, customerContactDeliveries as deliveries } from './schema.js';

export type ContactChallenge = typeof customerContactChallenges.$inferSelect;
export function contactStageDestination(
  row: ContactChallenge,
  input: ReturnType<typeof openContactEnvelope>,
) {
  return row.stage === 'current'
    ? input.current
    : {
        channel: input.kind === 'email' ? ('email' as const) : ('sms' as const),
        destination: input.value,
      };
}
export function maskContact(channel: 'sms' | 'email', value: string) {
  if (channel === 'sms') return '••••••' + value.slice(-4);
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(0, 1) + '•••' + value.slice(at) : 'Existing customer email';
}
export async function contactChallengeView(
  tx: AdministrationTransaction,
  row: ContactChallenge,
  secret: string,
  options: CustomerContactOptions,
  now: number,
) {
  const input = openContactEnvelope(secret, row.id, row.encryptedInput),
    destination = contactStageDestination(row, input);
  const [latest] = await tx
    .select({ status: deliveries.status })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.challengeId, row.id),
        eq(deliveries.kind, 'otp'),
        eq(deliveries.stage, row.stage),
      ),
    )
    .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
    .limit(1);
  const status =
    ['PENDING_CURRENT', 'PENDING_NEW', 'READY'].includes(row.status) && row.expiresAt <= now
      ? 'EXPIRED'
      : row.status;
  return publicContactChallenge.parse({
    id: row.id,
    kind: row.kind,
    stage: row.stage,
    status,
    version: row.version,
    customerId: row.customerId,
    value: input.value,
    currentDestination: maskContact(input.current.channel, input.current.destination),
    expiresAt: row.expiresAt,
    codeExpiresAt: row.codeExpiresAt,
    retryAt: row.retryAt,
    attemptsRemaining: Math.max(
      0,
      contactAttemptLimit(destination.channel, options) - row.attempts,
    ),
    delivery: latest?.status ?? null,
  });
}
