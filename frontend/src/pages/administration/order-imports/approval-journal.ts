import { z } from 'zod';
import { captureOperatorScope } from '../../../api/client';
import type { Principal } from '../../../api/types';
import { importApprovalReasonSchema } from './approval-client';

const identifier = z.string().regex(/^[1-9]\d{0,19}$/);
export const importApprovalIntentSchema = z
  .object({
    version: z.literal(1),
    operatorId: identifier,
    jobId: z.uuid(),
    operationId: z.uuid(),
    commandId: z.uuid(),
    reason: importApprovalReasonSchema,
  })
  .strict();
export type ImportApprovalIntent = z.infer<typeof importApprovalIntentSchema>;
const prefix = 'pos-order-import-approval:';
const key = (operatorId: string, jobId: string, operationId: string) =>
  prefix +
  JSON.stringify([
    identifier.parse(operatorId),
    z.uuid().parse(jobId),
    z.uuid().parse(operationId),
  ]);
const unreadable = () =>
  new Error(
    'The saved approval references are unreadable. Keep this device for administrator recovery.',
  );
export function orderImportActorScope(user: Principal) {
  return JSON.stringify([user.id, user.role, user.userType, [...new Set(user.storeIds)].sort()]);
}
export function readImportApprovalIntent(
  operatorId: string,
  jobId: string,
  operationId: string,
): ImportApprovalIntent | null {
  captureOperatorScope(operatorId).throwIfAborted();
  try {
    const storageKey = key(operatorId, jobId, operationId),
      raw = localStorage.getItem(storageKey);
    if (raw === null) return null;
    if (raw.length > 500) throw unreadable();
    const value = importApprovalIntentSchema.parse(JSON.parse(raw) as unknown);
    if (key(value.operatorId, value.jobId, value.operationId) !== storageKey) throw unreadable();
    return value;
  } catch {
    throw unreadable();
  }
}
export function listImportApprovalIntents(operatorId: string): ImportApprovalIntent[] {
  captureOperatorScope(operatorId).throwIfAborted();
  try {
    const ownedPrefix = prefix + JSON.stringify([identifier.parse(operatorId)]).slice(0, -1) + ',',
      result: ImportApprovalIntent[] = [];
    if (localStorage.length > 20000) throw unreadable();
    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index);
      if (!storageKey?.startsWith(ownedPrefix)) continue;
      const parts = z
        .tuple([identifier, z.uuid(), z.uuid()])
        .parse(JSON.parse(storageKey.slice(prefix.length)) as unknown);
      if (parts[0] !== operatorId) throw unreadable();
      const value = readImportApprovalIntent(...parts);
      if (!value) throw unreadable();
      result.push(value);
      if (result.length > 1000) throw unreadable();
    }
    return result.sort((left, right) =>
      key(left.operatorId, left.jobId, left.operationId).localeCompare(
        key(right.operatorId, right.jobId, right.operationId),
      ),
    );
  } catch {
    throw unreadable();
  }
}
async function locked<T>(
  value: ImportApprovalIntent,
  work: () => T,
  signal?: AbortSignal,
): Promise<T> {
  const owner = captureOperatorScope(value.operatorId),
    scope = AbortSignal.any([owner, ...(signal ? [signal] : [])]);
  scope.throwIfAborted();
  if (!globalThis.navigator?.locks)
    throw new Error(
      'Safe approval reference coordination is unavailable in this browser. No approval request was sent.',
    );
  return navigator.locks.request(
    key(value.operatorId, value.jobId, value.operationId),
    { mode: 'exclusive', signal: scope },
    () => {
      scope.throwIfAborted();
      return work();
    },
  );
}
export async function saveImportApprovalIntent(input: ImportApprovalIntent, signal?: AbortSignal) {
  captureOperatorScope(input.operatorId).throwIfAborted();
  const value = importApprovalIntentSchema.parse(input);
  return locked(
    value,
    () => {
      listImportApprovalIntents(value.operatorId);
      const prior = readImportApprovalIntent(value.operatorId, value.jobId, value.operationId),
        encoded = JSON.stringify(value);
      if (prior && JSON.stringify(prior) !== encoded)
        throw new Error('Recover the original approval request before creating another.');
      try {
        const storageKey = key(value.operatorId, value.jobId, value.operationId);
        localStorage.setItem(storageKey, encoded);
        if (localStorage.getItem(storageKey) !== encoded) throw new Error();
      } catch {
        throw new Error('The approval reference could not be saved. No approval request was sent.');
      }
      return value;
    },
    signal,
  );
}
export async function clearImportApprovalIntent(input: ImportApprovalIntent, signal?: AbortSignal) {
  const value = importApprovalIntentSchema.parse(input);
  return locked(
    value,
    () => {
      const prior = readImportApprovalIntent(value.operatorId, value.jobId, value.operationId);
      if (
        prior &&
        JSON.stringify(prior) !== JSON.stringify(importApprovalIntentSchema.parse(value))
      )
        throw new Error('The saved approval request changed. Refresh its original receipt.');
      if (!prior) return;
      try {
        const storageKey = key(value.operatorId, value.jobId, value.operationId);
        localStorage.removeItem(storageKey);
        if (localStorage.getItem(storageKey) !== null) throw new Error();
      } catch {
        throw new Error(
          'The confirmed approval reference could not be retired. Refresh its original receipt.',
        );
      }
    },
    signal,
  );
}
