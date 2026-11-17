import { z } from 'zod';
import { captureOperatorScope } from '../../../api/client';
import {
  correctionScopeSchema,
  type CorrectionInput,
  type CorrectionScope,
} from './correction-client';

export const correctionJournalEvent = 'pos-import-correction-journal';
export const correctionIntentSchema = correctionScopeSchema
  .extend({
    version: z.literal(1),
    operatorId: z.string().regex(/^[1-9]\d{0,19}$/),
    id: z.uuid(),
    successorJobId: z.uuid(),
    successorOperationId: z.uuid(),
    evidenceId: z.uuid(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type CorrectionIntent = z.infer<typeof correctionIntentSchema>;
const prefix = 'pos-order-import-correction:',
  key = (operatorId: string, scope: CorrectionScope) =>
    prefix + JSON.stringify([operatorId, scope.jobId, scope.operationId]),
  unreadable = () =>
    new Error('Saved correction references are unreadable. Keep this device for manager recovery.');
export function readCorrectionIntent(
  operatorId: string,
  scope: CorrectionScope,
): CorrectionIntent | null {
  captureOperatorScope(operatorId).throwIfAborted();
  try {
    const raw = localStorage.getItem(key(operatorId, scope));
    if (raw === null) return null;
    if (raw.length > 1000) throw unreadable();
    const value = correctionIntentSchema.parse(JSON.parse(raw) as unknown);
    if (
      value.operatorId !== operatorId ||
      value.jobId !== scope.jobId ||
      value.operationId !== scope.operationId
    )
      throw unreadable();
    return value;
  } catch {
    throw unreadable();
  }
}
export function listCorrectionIntents(operatorId: string) {
  captureOperatorScope(operatorId).throwIfAborted();
  try {
    if (localStorage.length > 20000) throw unreadable();
    const values: CorrectionIntent[] = [],
      owned = prefix + JSON.stringify([operatorId]).slice(0, -1) + ',';
    for (let index = 0; index < localStorage.length; index++) {
      const candidate = localStorage.key(index);
      if (!candidate?.startsWith(owned)) continue;
      const [owner, jobId, operationId] = z
          .tuple([z.string(), z.uuid(), z.uuid()])
          .parse(JSON.parse(candidate.slice(prefix.length)) as unknown),
        scope = { jobId, operationId };
      if (owner !== operatorId) throw unreadable();
      const value = readCorrectionIntent(operatorId, scope);
      if (!value) throw unreadable();
      values.push(value);
      if (values.length > 1000) throw unreadable();
    }
    return values.sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    throw unreadable();
  }
}
export async function correctionInputHash(input: CorrectionInput) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function locked<T>(value: CorrectionIntent, signal: AbortSignal, task: () => T) {
  const owner = captureOperatorScope(value.operatorId),
    combined = AbortSignal.any([signal, owner]);
  combined.throwIfAborted();
  if (!navigator.locks)
    throw new Error('Safe correction recovery storage is unavailable. No correction was sent.');
  return navigator.locks.request(
    key(value.operatorId, value),
    { mode: 'exclusive', signal: combined },
    () => {
      combined.throwIfAborted();
      return task();
    },
  );
}
export async function saveCorrectionIntent(value: CorrectionIntent, signal: AbortSignal) {
  const parsed = correctionIntentSchema.parse(value);
  return locked(parsed, signal, () => {
    const prior = readCorrectionIntent(parsed.operatorId, parsed);
    if (prior && JSON.stringify(prior) !== JSON.stringify(parsed))
      throw new Error('Recover the original correction before preparing a replacement.');
    try {
      localStorage.setItem(key(parsed.operatorId, parsed), JSON.stringify(parsed));
      if (
        JSON.stringify(readCorrectionIntent(parsed.operatorId, parsed)) !== JSON.stringify(parsed)
      )
        throw unreadable();
    } catch {
      throw new Error(
        'The original correction reference could not be saved. No correction was sent.',
      );
    }
    window.dispatchEvent(new Event(correctionJournalEvent));
    return parsed;
  });
}
export async function clearCorrectionIntent(value: CorrectionIntent, signal: AbortSignal) {
  return locked(value, signal, () => {
    const prior = readCorrectionIntent(value.operatorId, value);
    if (prior && JSON.stringify(prior) !== JSON.stringify(value)) throw unreadable();
    localStorage.removeItem(key(value.operatorId, value));
    window.dispatchEvent(new Event(correctionJournalEvent));
  });
}
