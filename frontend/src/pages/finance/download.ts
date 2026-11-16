import { captureOperatorScope, requestWithResponse } from '../../api/client';
const workbookContentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export async function downloadReportFile(
  path: string,
  filename: string,
  ownerId: string,
  format: 'CSV' | 'XLSX',
) {
  if (
    (path !== '/api/v1/catalog/inventory-pulls/sample' &&
      !path.startsWith('/api/v1/reports/') &&
      !/^\/api\/v1\/report-exports\/(?:legacy\/)?[a-f0-9-]+\/file$/.test(path)) ||
    path.startsWith('//')
  )
    throw new Error('Invalid report download path.');
  if (!/^[1-9]\d*$/.test(ownerId))
    throw new Error('A signed-in operator is required for report downloads.');
  const actorSignal = captureOperatorScope(ownerId);
  const file = await requestWithResponse(
    path,
    {
      operatorId: ownerId,
      credentials: 'include',
      headers: { Accept: format === 'XLSX' ? workbookContentType : 'text/csv' },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    },
    async (response) => {
      const contentType = response.headers.get('Content-Type')?.toLowerCase().split(';')[0]?.trim();
      if (contentType !== (format === 'XLSX' ? workbookContentType : 'text/csv'))
        throw new Error('The report returned an unexpected file format.');
      const declared = response.headers.get('Content-Length'),
        expected = declared === null ? null : Number(declared);
      if (
        expected !== null &&
        (!Number.isSafeInteger(expected) || expected < 0 || expected > 268435456)
      )
        throw new Error('This report exceeds the download limit.');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The report file is unavailable.');
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          actorSignal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 268435456 || (expected !== null && size > expected))
            throw new Error('This report exceeds the download limit.');
          chunks.push(Uint8Array.from(next.value));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (expected !== null && size !== expected)
        throw new Error('The report file could not be verified.');
      return new Blob(chunks, { type: contentType });
    },
  );
  actorSignal.throwIfAborted();
  const url = URL.createObjectURL(file),
    link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/[<>:"/\\|?*]/g, '-').replace(/\p{C}/gu, '-');
  link.click();
  URL.revokeObjectURL(url);
}
export function downloadReportCsv(path: string, filename: string, ownerId: string) {
  return downloadReportFile(path, filename, ownerId, 'CSV');
}
