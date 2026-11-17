import { z } from 'zod';
import { captureOperatorScope } from '../../../api/client';

const intentSchema = z
  .object({
    version: z.literal(1),
    operatorId: z.string().regex(/^[1-9]\d{0,19}$/),
    jobId: z.uuid(),
    operationId: z.uuid(),
  })
  .strict();
export type ImportResumptionIntent = z.infer<typeof intentSchema>;
const key = (operatorId: string, jobId: string) =>
  'pos-order-import-resumption:' + JSON.stringify([operatorId, z.uuid().parse(jobId)]);

export function readImportResumption(operatorId: string, jobId: string) {
  captureOperatorScope(operatorId).throwIfAborted();
  const raw = localStorage.getItem(key(operatorId, jobId));
  if (raw === null) return null;
  try {
    if (raw.length > 300) throw new Error();
    const value = intentSchema.parse(JSON.parse(raw) as unknown);
    if (value.operatorId !== operatorId || value.jobId !== jobId) throw new Error();
    return value;
  } catch {
    throw new Error(
      'The saved resume reference is unreadable. Keep this device for administrator recovery.',
    );
  }
}
export function saveImportResumption(value: ImportResumptionIntent) {
  const parsed = intentSchema.parse(value),
    prior = readImportResumption(parsed.operatorId, parsed.jobId);
  if (prior && prior.operationId !== parsed.operationId)
    throw new Error('Recover the original resume request before creating another.');
  const encoded = JSON.stringify(parsed),
    storageKey = key(parsed.operatorId, parsed.jobId);
  try {
    localStorage.setItem(storageKey, encoded);
    if (localStorage.getItem(storageKey) !== encoded) throw new Error();
  } catch {
    throw new Error('The resume reference could not be saved. No resume request was sent.');
  }
  return parsed;
}
export function clearImportResumption(value: ImportResumptionIntent) {
  const prior = readImportResumption(value.operatorId, value.jobId);
  if (prior && prior.operationId !== value.operationId)
    throw new Error('The saved resume reference changed. Refresh its original receipt.');
  localStorage.removeItem(key(value.operatorId, value.jobId));
}
