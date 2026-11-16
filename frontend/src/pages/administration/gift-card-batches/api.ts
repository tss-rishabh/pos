import { z } from 'zod';
import { requestWithResponse } from '../../../api/client';

const id = z.string().regex(/^[1-9]\d{0,18}$/),
  version = z.string().regex(/^[a-f0-9]{64}$/);
export const batchBase = '/api/v1/gift-card-batches';
export const batchCapabilities = z.object({
  today: z.iso.date(),
  timeZone: z.string(),
  generationAvailable: z.boolean(),
  recipient: z.email().nullable(),
  historyAvailable: z.boolean(),
  maxSize: z.literal(10000),
});
export const batchRecord = z.object({
  id,
  size: z.number().int().min(0).max(2147483647),
  message: z.string().nullable(),
  completed: z.boolean(),
  blocked: z.boolean(),
  printed: z.boolean(),
  createdById: id,
  createdByName: z.string(),
  createdAt: z.string(),
});
export const batchPhase = z.enum([
  'QUEUED',
  'GENERATED',
  'STORED',
  'SENDING',
  'DELIVERED',
  'BLOCKED',
  'UNCERTAIN',
  'FAILED',
]);
export const batchDetails = batchRecord.extend({
  version,
  artifactAvailable: z.boolean(),
  job: z
    .object({
      phase: batchPhase,
      errorCode: z.string().nullable(),
      updatedAt: z.string(),
      version,
      canRetry: z.boolean(),
    })
    .nullable(),
});
export type BatchDetails = z.infer<typeof batchDetails>;
export const batchReceipt = z.object({
  id: z.uuid(),
  batchId: id,
  status: z.literal('success'),
  message: z.string(),
});
export const batchHistory = z.object({
  reader: z.enum(['data-reader', 'bigquery']),
  today: z.iso.date(),
  recordsTotal: z.string().regex(/^\d+$/),
  recordsFiltered: z.string().regex(/^\d+$/),
  start: z.number().int().nonnegative().refine(Number.isSafeInteger),
  length: z.number().int().min(1).max(500),
  data: z.array(batchRecord).max(500),
});
export const batchSecret = z.object({
  filename: z.string().regex(/^gift-cards-[1-9]\d{0,18}\.zip$/),
  password: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type BatchFilters = {
  from: string | null;
  to: string | null;
  search: string;
  start: number;
  length: number;
  sort: 'id' | 'size' | 'message' | 'createdBy' | 'createdAt';
  direction: 'asc' | 'desc';
};
export const batchPhaseLabels: Record<z.infer<typeof batchPhase>, string> = {
  QUEUED: 'Queued',
  GENERATED: 'Archive prepared',
  STORED: 'Archive ready',
  SENDING: 'Sending email',
  DELIVERED: 'Email accepted',
  BLOCKED: 'Generation paused',
  UNCERTAIN: 'Delivery needs review',
  FAILED: 'Generation needs review',
};
export const batchColumns = [
  { id: 'id', label: 'Batch' },
  { id: 'size', label: 'Cards' },
  { id: 'message', label: 'Message' },
  { id: 'createdByName', label: 'Created by' },
  { id: 'createdAt', label: 'Created at' },
  { id: 'status', label: 'Status' },
] as const;
export type BatchColumn = (typeof batchColumns)[number]['id'];
export const batchPreferences = z.object({
  columns: z
    .array(z.enum(['id', 'size', 'message', 'createdByName', 'createdAt', 'status']))
    .min(1)
    .max(6)
    .refine((values) => new Set(values).size === values.length),
  length: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100), z.literal(500)]),
  sort: z.enum(['id', 'size', 'message', 'createdBy', 'createdAt']),
  direction: z.enum(['asc', 'desc']),
});
export const defaultBatchPreferences: z.infer<typeof batchPreferences> = {
  columns: batchColumns.map((column) => column.id),
  length: 10,
  sort: 'id',
  direction: 'desc',
};
export function readBatchPreferences(operatorId: string) {
  try {
    return batchPreferences.parse(
      JSON.parse(
        localStorage.getItem('pos.gift-card-batches.preferences.' + operatorId) || 'null',
      ) as unknown,
    );
  } catch {
    return defaultBatchPreferences;
  }
}
export function batchStatus(batch: z.infer<typeof batchRecord>) {
  return [
    batch.blocked ? 'Blocked' : 'Active',
    batch.printed ? 'Printed' : batch.completed ? 'Ready' : 'Generating',
  ].join(' · ');
}
export function batchHistoryCsv(
  rows: readonly z.infer<typeof batchRecord>[],
  columns: readonly BatchColumn[],
) {
  const quote = (value: string) =>
    '"' + (/^[\s\p{C}]*[=+\-@]/u.test(value) ? "'" + value : value).replaceAll('"', '""') + '"';
  return (
    [
      columns.map((id) => quote(batchColumns.find((column) => column.id === id)!.label)).join(','),
      ...rows.map((row) =>
        columns
          .map((id) => quote(id === 'status' ? batchStatus(row) : String(row[id] ?? '')))
          .join(','),
      ),
    ].join('\r\n') + '\r\n'
  );
}

export function downloadBatchArchive(operatorId: string, batchId: string, signal: AbortSignal) {
  return requestWithResponse(
    batchBase + '/' + id.parse(batchId) + '/archive',
    { operatorId, signal, cache: 'no-store', redirect: 'error' },
    async (response) => {
      const size = Number(response.headers.get('Content-Length'));
      if (
        response.headers.get('Content-Type')?.split(';')[0] !== 'application/zip' ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 2 * 1024 * 1024 ||
        !response.body
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('The private batch file is unavailable.');
      }
      const reader = response.body.getReader(),
        parts: Uint8Array<ArrayBuffer>[] = [];
      let received = 0;
      try {
        for (;;) {
          const part = await reader.read();
          signal.throwIfAborted();
          if (part.done) break;
          received += part.value.length;
          if (received > size) throw new Error('The private batch file is unavailable.');
          parts.push(Uint8Array.from(part.value));
        }
        if (received !== size) throw new Error('The private batch file is unavailable.');
        return new Blob(parts, { type: 'application/zip' });
      } catch {
        await reader.cancel().catch(() => undefined);
        signal.throwIfAborted();
        throw new Error('The private batch file is unavailable.');
      } finally {
        reader.releaseLock();
      }
    },
  );
}
export function saveBatchArchive(blob: Blob, batchId: string) {
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'gift-cards-' + id.parse(batchId) + '.zip';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
