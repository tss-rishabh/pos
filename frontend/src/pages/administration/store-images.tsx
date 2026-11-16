import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { X } from 'lucide-react';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading } from '../../components/common';
import { PrivateImages } from '../../components/private-images';
import { useOnline } from '../../hooks/use-pos';

const imageSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  available: z.boolean(),
  hasImage: z.boolean(),
});
const attachmentSchema = z.object({ status: z.literal('success'), image: imageSchema });
export function StoreImageDialog({
  user,
  storeId,
  storeName,
  onClose,
}: {
  user: Principal;
  storeId: string;
  storeName: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    client = useQueryClient();
  const online = useOnline();
  const path = `/api/v1/admin/stores/${encodeURIComponent(storeId)}`;
  const view = useQuery({
    queryKey: [user.id, 'administration', 'store-image', storeId],
    queryFn: ({ signal }) =>
      request(`${path}/image`, { operatorId: user.id, cache: 'no-store', signal }, imageSchema),
    retry: false,
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      aria-labelledby="store-image-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <h2 id="store-image-title">Image for {storeName}</h2>
        <button className="icon-button" aria-label="Close store image" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {view.isPending ? (
        <Loading />
      ) : view.isError ? (
        <ErrorState error={view.error} retry={() => void view.refetch()} />
      ) : (
        <PrivateImages
          title="Store image"
          operatorId={user.id}
          revision={view.data.revision}
          available={view.data.available}
          online={online}
          reservePath={`${path}/image-uploads`}
          attachmentPath={(id) => `${path}/image-uploads/${id}/attachment`}
          attachmentSchema={attachmentSchema}
          onAttached={async () => {
            await view.refetch({ throwOnError: true });
            await client.invalidateQueries({
              queryKey: [user.id, 'administration', '/api/v1/admin/stores'],
            });
          }}
          slots={[
            {
              kind: 'image',
              label: 'Store image',
              exists: view.data.hasImage,
              variant: 'cover',
              url: `${path}/image/content?v=${view.data.revision}`,
            },
          ]}
        />
      )}
    </dialog>
  );
}
