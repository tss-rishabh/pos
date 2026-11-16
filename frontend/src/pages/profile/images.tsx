import { z } from 'zod';
import { PrivateImages } from '../../components/private-images';

const attachmentSchema = z.object({
  profile: z.object({ revision: z.string() }),
  sessionExpiresAt: z.number().positive(),
});
export function ProfileImages({
  revision,
  available,
  hasImage,
  hasCover,
  online,
  onAttached,
  operatorId,
}: {
  revision: string;
  available: boolean;
  hasImage: boolean;
  hasCover: boolean;
  online: boolean;
  onAttached: () => Promise<void>;
  operatorId?: string;
}) {
  return (
    <PrivateImages
      title="Profile images"
      revision={revision}
      available={available}
      online={online}
      onAttached={onAttached}
      operatorId={operatorId}
      reservePath="/api/v1/operators/current/profile/image-uploads"
      attachmentPath={(id) => `/api/v1/operators/current/profile/image-uploads/${id}/attachment`}
      attachmentSchema={attachmentSchema}
      slots={[
        {
          kind: 'cover-image',
          label: 'Cover image',
          exists: hasCover,
          variant: 'cover',
          url: `/api/v1/operators/current/profile/images/cover-image?v=${revision}`,
        },
        {
          kind: 'image',
          label: 'Profile image',
          exists: hasImage,
          variant: 'portrait',
          url: `/api/v1/operators/current/profile/images/image?v=${revision}`,
        },
      ]}
    />
  );
}
