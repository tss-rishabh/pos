import { z } from 'zod';
import { request, ApiError, captureOperatorScope, requestWithResponse } from '../../api/client';
import { administrationIdentifier } from './api';
import { fileChecksum, privateUploadSchema, uploadPrivateFile } from '../../lib/private-upload';

export const attachmentKind = z.enum(['cover-image', 'image', 'video', 'document']);
export type AttachmentKind = z.infer<typeof attachmentKind>;
export const guideAttachmentSchema = z.object({
  id: z.string().regex(/^(?:[0-9a-f-]{36}|legacy-[0-9a-f]{32})$/i),
  kind: attachmentKind,
  name: z.string(),
  contentType: z.string(),
  url: z
    .string()
    .regex(
      /^\/api\/v1\/documentation\/[1-9]\d{0,19}\/assets\/(?:[0-9a-f-]{36}|legacy-[0-9a-f]{32})\/content$/i,
    ),
});
export type GuideAttachment = z.infer<typeof guideAttachmentSchema>;
export const guideSchema = z.object({
  id: administrationIdentifier,
  title: z.string(),
  summary: z.string(),
  description: z.string(),
  descriptionHtml: z.string(),
  keywords: z.string(),
  sortOrder: z.number(),
  active: z.number(),
  version: z.string(),
  assets: z.array(guideAttachmentSchema),
  mediaState: z.enum(['available', 'not-configured', 'invalid-metadata']),
  updatedAt: z.string(),
  uploaderName: z.string().default('Unknown'),
});
export type Guide = z.infer<typeof guideSchema>;
export const guideCursorSchema = z.string().regex(/^v1\.[A-Za-z0-9_-]{1,200}$/);
export const mediaCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  types: z.array(
    z.object({
      contentType: z.string(),
      kind: z.enum(['image', 'video', 'document']),
      extension: z.string().regex(/^[a-z0-9]{2,8}$/),
      maximumBytes: z.number().int().positive(),
    }),
  ),
  maximumPendingFiles: z.number().int().positive(),
});
export type MediaCapabilities = z.infer<typeof mediaCapabilitiesSchema>;
const reservationSchema = z.object({
  id: z.uuid(),
  expiresAt: z.string(),
  upload: privateUploadSchema,
});
const completeSchema = z.object({ id: z.uuid(), status: z.string() });
export interface GuideFile {
  id: string;
  kind: AttachmentKind;
  file: File;
  contentType: string;
}
export async function uploadGuideFile(
  entry: GuideFile,
  parentSignal: AbortSignal,
  operatorId: string,
): Promise<void> {
  const signal = AbortSignal.any([parentSignal, captureOperatorScope(operatorId)]);
  const checksum = await fileChecksum(entry.file, signal);
  const headersSignal = () => AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  let reservation: z.infer<typeof reservationSchema>;
  try {
    reservation = await request(
      '/api/v1/admin/documentation/uploads',
      {
        method: 'POST',
        operatorId,
        signal: headersSignal(),
        body: JSON.stringify({
          id: entry.id,
          kind: entry.kind,
          name: entry.file.name,
          contentType: entry.contentType,
          size: entry.file.size,
          checksum,
        }),
      },
      reservationSchema,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'DOCUMENTATION_UPLOAD_CONFLICT') {
      await request(
        `/api/v1/admin/documentation/uploads/${entry.id}/complete`,
        { method: 'POST', operatorId, signal: headersSignal(), body: '{}' },
        completeSchema,
      );
      return;
    }
    throw error;
  }
  await uploadPrivateFile(entry.file, reservation.upload, signal);
  await request(
    `/api/v1/admin/documentation/uploads/${entry.id}/complete`,
    { method: 'POST', operatorId, signal: headersSignal(), body: '{}' },
    completeSchema,
  );
}
export async function downloadGuideAttachment(
  attachment: GuideAttachment,
  operatorId: string,
): Promise<void> {
  const blob = await requestWithResponse(
    attachment.url,
    {
      operatorId,
      signal: AbortSignal.timeout(300000),
      redirect: 'error',
      cache: 'no-store',
    },
    (response) => response.blob(),
  );
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = attachment.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
