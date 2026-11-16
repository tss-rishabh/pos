import { Temporal } from '@js-temporal/polyfill';
import { and, asc, eq, gt, inArray, lt, lte } from 'drizzle-orm';
import type { Databases } from '../../db/pools.js';
import { PosTutorial } from '../../db/legacy-schema.js';
import { AppError } from '../../domain/errors.js';
import { documentationAssets } from './media-schema.js';
import { parseLegacyAssetList, utcMediaTimestamp } from './media-domain.js';
import type { DocumentationMediaStore } from './media-storage.js';
import type { AdministrationTransaction } from './checkins.js';

async function stillReferenced(
  transaction: AdministrationTransaction,
  key: string,
): Promise<boolean> {
  let after = 0n;
  // Legacy arrays are repr/JSON strings without an indexed relation. Scan bounded
  // PK pages rather than use a LIKE test that can miss escaped file names.
  for (let page = 0; page < 100; page++) {
    const rows = await transaction
      .select({
        id: PosTutorial.id,
        cover: PosTutorial.cover_image,
        images: PosTutorial.image_link,
        videos: PosTutorial.video_link,
        documents: PosTutorial.doc_link,
      })
      .from(PosTutorial)
      .where(gt(PosTutorial.id, after))
      .orderBy(asc(PosTutorial.id))
      .limit(100);
    for (const row of rows)
      for (const serialized of [row.cover, row.images, row.videos, row.documents]) {
        let keys: string[];
        try {
          keys = parseLegacyAssetList(serialized);
        } catch {
          throw new AppError(
            409,
            'DOCUMENTATION_REFERENCE_UNRESOLVED',
            'Guide attachment references require review before cleanup.',
          );
        }
        if (keys.includes(key)) return true;
      }
    if (rows.length < 100) return false;
    after = rows.at(-1)!.id;
  }
  throw new AppError(
    409,
    'DOCUMENTATION_REFERENCE_SCAN_LIMIT',
    'Guide attachment references require a larger offline audit.',
  );
}
export interface MediaCleanupResult {
  id: string;
  actorId: string;
  requestId: string | null;
  documentId: string | null;
  status: 'deleted' | 'retained' | 'failed' | 'blocked';
  errorCode?: string;
}
export function documentationMediaCleanup(db: Databases, media: DocumentationMediaStore) {
  return {
    async dispatchNext(signal?: AbortSignal): Promise<MediaCleanupResult | null> {
      return db.get('writer').transaction(async (transaction) => {
        // Every issued upload form expires before this extra fifteen-minute grace.
        const cutoff = utcMediaTimestamp(Temporal.Now.instant().subtract({ minutes: 15 }));
        const [row] = await transaction
          .select()
          .from(documentationAssets)
          .where(
            and(
              inArray(documentationAssets.state, ['PENDING', 'READY', 'DELETE_PENDING']),
              lte(documentationAssets.expiresAt, cutoff),
              lt(documentationAssets.attempts, 10),
            ),
          )
          .orderBy(
            asc(documentationAssets.attempts),
            asc(documentationAssets.expiresAt),
            asc(documentationAssets.id),
          )
          .limit(1)
          .for('update', { skipLocked: true });
        if (!row) return null;
        const result = {
          id: row.id,
          actorId: row.actorId,
          requestId: row.requestId,
          documentId: row.documentId === null ? null : String(row.documentId),
        };
        try {
          // Guide save attaches state+documentId atomically; an upload with no
          // documentId is an orphan, while removed files retain their origin ID.
          if (
            !(row.source === 'upload' && row.documentId === null) &&
            (await stillReferenced(transaction, row.objectKey))
          ) {
            await transaction
              .update(documentationAssets)
              .set({ state: 'RETAINED', updatedAt: utcMediaTimestamp() })
              .where(eq(documentationAssets.id, row.id));
            return { ...result, status: 'retained' };
          }
          media.assertKey(row.objectKey);
          await media.remove(row.objectKey, signal);
          await transaction
            .update(documentationAssets)
            .set({ state: 'DELETED', attempts: row.attempts + 1, updatedAt: utcMediaTimestamp() })
            .where(eq(documentationAssets.id, row.id));
          return { ...result, status: 'deleted' };
        } catch (error) {
          const blocked = row.attempts + 1 >= 10;
          await transaction
            .update(documentationAssets)
            .set({
              state: blocked ? 'BLOCKED' : 'DELETE_PENDING',
              attempts: row.attempts + 1,
              updatedAt: utcMediaTimestamp(),
            })
            .where(eq(documentationAssets.id, row.id));
          return {
            ...result,
            status: blocked ? 'blocked' : 'failed',
            errorCode: error instanceof AppError ? error.code : 'DOCUMENTATION_CLEANUP_UNAVAILABLE',
          };
        }
      });
    },
    async retry(id: string): Promise<void> {
      await db.get('writer').transaction(async (transaction) => {
        const [row] = await transaction
          .select({ state: documentationAssets.state })
          .from(documentationAssets)
          .where(eq(documentationAssets.id, id))
          .limit(1)
          .for('update');
        if (!row || !['DELETE_PENDING', 'BLOCKED'].includes(row.state))
          throw new AppError(
            409,
            'DOCUMENTATION_CLEANUP_NOT_PENDING',
            'Attachment cleanup is not pending.',
          );
        await transaction
          .update(documentationAssets)
          .set({ state: 'DELETE_PENDING', attempts: 0, updatedAt: utcMediaTimestamp() })
          .where(eq(documentationAssets.id, id));
      });
    },
  };
}
