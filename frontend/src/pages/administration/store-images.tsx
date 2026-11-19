import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { request } from '../../api/client';
import { fileChecksum, privateUploadSchema, uploadPrivateFile } from '../../lib/private-upload';

const imageSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  available: z.boolean(),
  hasImage: z.boolean(),
});
const reservationSchema = privateUploadSchema.extend({
  id: z.uuid(),
  expiresAt: z.number().positive(),
});
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Upload the image chosen in the store form to private storage; the returned id is posted as
 * `store_image` with the form (legacy multipart `store_image`, `_form.html:376-389`).
 */
export async function uploadStoreImage(
  file: File,
  operatorId: string,
  storeId: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (!imageTypes.has(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024)
    throw new Error(
      'Upload a valid image. The file you uploaded was either not an image or a corrupted image.',
    );
  const checksum = await fileChecksum(file, signal);
  const reservation = await request(
    '/api/v1/admin/store-image-uploads',
    {
      method: 'POST',
      operatorId,
      cache: 'no-store',
      signal,
      body: JSON.stringify({
        ...(storeId ? { storeId } : {}),
        upload: {
          id: crypto.randomUUID(),
          kind: 'image',
          name: file.name,
          contentType: file.type,
          size: file.size,
          checksum,
        },
      }),
    },
    reservationSchema,
  );
  await uploadPrivateFile(file, reservation, signal, 120000);
  return reservation.id;
}

/** Current store image shown at the top of the legacy edit page (`edit.html:18-22`). */
export function StoreImagePreview({
  operatorId,
  storeId,
}: {
  operatorId: string;
  storeId: string;
}) {
  const path = `/api/v1/admin/stores/${encodeURIComponent(storeId)}`;
  const [broken, setBroken] = useState(false);
  const view = useQuery({
    queryKey: [operatorId, 'administration', 'store-image', storeId],
    queryFn: ({ signal }) =>
      request(`${path}/image`, { operatorId, cache: 'no-store', signal }, imageSchema),
    retry: false,
  });
  if (!view.data?.available || !view.data.hasImage || broken) return null;
  return (
    <img
      className="administration-store-image"
      alt="Store image"
      src={`${path}/image/content?v=${view.data.revision}`}
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}
