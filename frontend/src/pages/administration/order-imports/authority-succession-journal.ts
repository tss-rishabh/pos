import { z } from 'zod';
import { captureOperatorScope } from '../../../api/client';
import type { Principal } from '../../../api/types';
import { orderImportActorScope } from './approval-journal';
import { authorityReasonSchema } from './authority-succession-client';
const prefix = 'pos-import-authority-action:',
  common = {
    version: z.literal(1),
    operatorId: z.string().regex(/^[1-9]\d{0,18}$/),
    actorScope: z.string().min(1).max(20000),
    jobId: z.uuid(),
    operationId: z.uuid(),
    commandId: z.uuid(),
  };
export const authorityIntentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('approve'),
      reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
      reason: authorityReasonSchema,
    })
    .strict(),
  z.object({ ...common, kind: z.literal('continue'), grantId: z.uuid() }).strict(),
]);
export type AuthorityIntent = z.infer<typeof authorityIntentSchema>;
const key = (actor: string) => prefix + actor;
const unavailable = () =>
  Error(
    'The saved authority recovery action is unreadable. Keep this device for manager reconciliation.',
  );
export function listAuthorityIntents(user: Principal): AuthorityIntent[] {
  captureOperatorScope(user.id).throwIfAborted();
  try {
    if (localStorage.length > 20000) throw unavailable();
    const values: AuthorityIntent[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const name = localStorage.key(index);
      if (!name?.startsWith(key(user.id) + ':')) continue;
      const raw = localStorage.getItem(name);
      if (!raw || raw.length > 24000) throw unavailable();
      const value = authorityIntentSchema.parse(JSON.parse(raw) as unknown);
      if (value.operatorId !== user.id || name !== key(user.id) + ':' + value.commandId)
        throw unavailable();
      values.push(value);
      if (values.length > 1000) throw unavailable();
    }
    return values;
  } catch {
    throw unavailable();
  }
}
export function readAuthorityIntent(user: Principal): AuthorityIntent | null {
  return listAuthorityIntents(user)[0] ?? null;
}
async function locked<T>(user: Principal, signal: AbortSignal, work: () => T) {
  const current = AbortSignal.any([captureOperatorScope(user.id), signal]);
  current.throwIfAborted();
  if (!navigator.locks)
    throw Error('Safe action coordination is unavailable. No request was sent.');
  return navigator.locks.request(key(user.id), { mode: 'exclusive', signal: current }, () => {
    current.throwIfAborted();
    return work();
  });
}
export function saveAuthorityIntent(user: Principal, input: AuthorityIntent, signal: AbortSignal) {
  const value = authorityIntentSchema.parse(input);
  if (value.actorScope !== orderImportActorScope(user) || value.operatorId !== user.id)
    throw unavailable();
  return locked(user, signal, () => {
    const all = listAuthorityIntents(user),
      prior = all.find((v) => v.commandId === value.commandId);
    if (prior) throw Error('Recover this original saved action without sending it again.');
    if (all.length >= 1000) throw unavailable();
    const raw = JSON.stringify(value);
    try {
      const name = key(user.id) + ':' + value.commandId;
      localStorage.setItem(name, raw);
      if (localStorage.getItem(name) !== raw) throw Error();
    } catch {
      throw Error('The action reference could not be saved. No request was sent.');
    }
    return value;
  });
}
export function retireAuthorityIntent(
  user: Principal,
  input: AuthorityIntent,
  signal: AbortSignal,
) {
  return locked(user, signal, () => {
    const prior = listAuthorityIntents(user).find((v) => v.commandId === input.commandId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(input)) throw unavailable();
    const name = key(user.id) + ':' + input.commandId;
    localStorage.removeItem(name);
    if (localStorage.getItem(name) !== null) throw unavailable();
  });
}
export async function retireCompletedAuthorityScope(
  user: Principal,
  scope: { jobId: string; operationId: string },
  signal: AbortSignal,
) {
  for (const saved of listAuthorityIntents(user)) {
    if (saved.jobId === scope.jobId && saved.operationId === scope.operationId)
      await retireAuthorityIntent(user, saved, signal);
  }
}
