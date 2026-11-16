import { z } from 'zod';
import type { Principal } from '../../../domain/access.js';
import type { AdministrationTransaction } from '../checkins.js';
import { uploadInput } from '../media-domain.js';
import type { lockAdministrationRegistry } from '../locks.js';

export const imageKind = z.enum(['image', 'cover-image']);
export type ImageKind = z.infer<typeof imageKind>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const imageReservationInput = z
  .object({
    revision,
    upload: uploadInput.refine(
      (input) => ['image', 'cover-image'].includes(input.kind),
      'Choose an image.',
    ),
  })
  .strict();
export const imageAttachmentInput = z.object({ revision }).strict();
export interface ImageContext {
  user: Principal;
  ownerId: string;
}
export interface ImageOwnerState {
  revision: string;
  keys: Partial<Record<ImageKind, string>>;
}
/** The adapter owns current authorization, row locks, references and persistent owner fields. */
export interface ImageOwnerAdapter {
  registry: Parameters<typeof lockAdministrationRegistry>[1];
  errorPrefix: string;
  subject: string;
  kinds: readonly ImageKind[];
  reservationOwner(context: ImageContext): string;
  authorize(
    transaction: AdministrationTransaction,
    context: ImageContext,
    mode: 'read' | 'attach' | 'publish',
  ): Promise<ImageOwnerState>;
  write(
    transaction: AdministrationTransaction,
    context: ImageContext,
    kind: ImageKind,
    key: string,
  ): Promise<void>;
  referencedKeys(
    transaction: AdministrationTransaction,
    keys: string[],
  ): Promise<ReadonlySet<string>>;
  allowsKey(kind: ImageKind, key: string): boolean;
  allowsCleanupKey(key: string): boolean;
}
