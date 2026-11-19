import { administrationCollectionPage, collectionField } from './collection-page.js';
import { generatedId } from '../../db/generated-id.js';
import { createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, desc, eq, gt, inArray, like, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosTutorial, PosUser } from '../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { currentRequestTrace } from '../../observability/context.js';
import {
  decodeDocumentationCursor,
  documentationPageQuery,
  encodeDocumentationCursor,
  legacyAssetId,
  mediaKind,
  mediaTypes,
  parseLegacyAssetList,
  sanitizeDocumentationHtml,
  uploadInput,
  utcMediaTimestamp,
  type DocumentationInput,
  type MediaKind,
  type UploadInput,
} from './media-domain.js';
import {
  mediaContentTypeFromKey,
  type DocumentationMediaStore,
  type ReservedMedia,
} from './media-storage.js';
import type { EphemeralStore } from '../../jobs/ephemeral.js';
import { withAdministrationLock } from './locks.js';
import { legacyIntegerReference } from './policies.js';
import { assertCurrentOperatorRole } from './authorization.js';
import { administrationEphemeralStore } from './ephemeral-runtime.js';

export interface DocumentationEvent {
  module: 'administration';
  resource: 'documentation-media';
  eventId: string;
  requestId: string | null;
  userId: string;
  documentId: string;
}
export interface DocumentationOptions {
  mediaStore?: DocumentationMediaStore;
  /** Registered resource event for an attachment that could not be deleted (no keys or names). */
  documentationLog?: (event: DocumentationEvent) => void;
}
type Tutorial = typeof PosTutorial.$inferSelect;
interface Attachment {
  id: string;
  key: string;
  kind: MediaKind;
  name: string;
  contentType: string;
}
const columns = {
  'cover-image': 'cover_image',
  image: 'image_link',
  video: 'video_link',
  document: 'doc_link',
} as const;
const required = <T>(value: T | undefined): T => {
  if (value === undefined)
    throw new AppError(404, 'DOCUMENTATION_NOT_FOUND', 'Guide was not found.');
  return value;
};
const readerAccess = (user: Principal, row: Tutorial) => {
  if (!row.is_active && user.role !== 1)
    throw new AppError(404, 'DOCUMENTATION_NOT_FOUND', 'Guide was not found.');
};
/** Uploaded keys end in `_{uploadId}.{ext}`; the display name drops that suffix. */
const uploadSuffix = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^./]+)$/i;
function attachmentList(row: Tutorial): Attachment[] {
  const result: Attachment[] = [];
  for (const [kind, column] of Object.entries(columns))
    for (const key of parseLegacyAssetList(row[column as (typeof columns)[MediaKind]]))
      result.push({
        id: legacyAssetId(kind as MediaKind, key),
        key,
        kind: kind as MediaKind,
        name: (key.split('/').at(-1) || 'Attachment').replace(uploadSuffix, '$1'),
        contentType: mediaContentTypeFromKey(key),
      });
  return result;
}
/**
 * Ledger administration/documentation-media: pending uploads live in Redis
 * (`pos:doc_upload:{assetId}`, 1 h); attached paths are the `pos_tutorial` list columns; the
 * optimistic version is `pos_tutorial.updated_at`; replays use `pos:idem:documentation:{op}`.
 */
export const documentationUploadKey = (id: string) => `pos:doc_upload:${id}`;
export const documentationMutationKey = (id: string) => `pos:idem:documentation:${id}`;
const pendingUpload = z
  .object({
    id: z.uuid(),
    objectKey: z.string(),
    actorId: z.string(),
    kind: mediaKind,
    name: z.string(),
    contentType: z.string(),
    size: z.number().int(),
    checksum: z.string(),
    state: z.enum(['PENDING', 'READY']),
    expiresAt: z.string(),
  })
  .strict();
type PendingUpload = z.infer<typeof pendingUpload>;
const mutationReceipt = z
  .object({
    actorId: z.string(),
    requestHash: z.string(),
    documentId: z.string(),
    version: z.string(),
    created: z.boolean(),
  })
  .strict();
function specification(row: PendingUpload): ReservedMedia {
  const parsed = uploadInput.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    contentType: row.contentType,
    size: row.size,
    checksum: row.checksum,
  });
  return { ...parsed, objectKey: row.objectKey, expiresAt: row.expiresAt };
}
const fileBase = (name: string) =>
  name
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'attachment';
export function documentationService(
  config: Config,
  db: Databases,
  options: DocumentationOptions = {},
  ephemeral: EphemeralStore = administrationEphemeralStore(config),
) {
  const localNow = () =>
    Temporal.Now.zonedDateTimeISO(config.BUSINESS_TIMEZONE)
      .toPlainDateTime()
      .toString({ smallestUnit: 'second' })
      .replace('T', ' ');
  const storage = () => {
    if (!options.mediaStore)
      throw new AppError(
        503,
        'DOCUMENTATION_STORAGE_UNAVAILABLE',
        'Guide attachments are unavailable.',
      );
    return options.mediaStore;
  };
  const traceId = () => currentRequestTrace()?.requestId || null;
  const versionOf = (row: Pick<Tutorial, 'updated_at'>) => row.updated_at;
  const locked = <T>(run: () => Promise<T>) =>
    withAdministrationLock(ephemeral, 'documentation', () => retryTransaction(run));
  async function pending(id: string): Promise<PendingUpload | null> {
    const raw = await ephemeral.get(documentationUploadKey(id));
    if (raw === null) return null;
    try {
      const value = pendingUpload.parse(JSON.parse(raw) as unknown);
      return value.expiresAt > utcMediaTimestamp() ? value : null;
    } catch {
      return null;
    }
  }
  const savePending = (value: PendingUpload) =>
    ephemeral.set(documentationUploadKey(value.id), JSON.stringify(value), { KEEPTTL: true });
  /** Legacy `storage.delete` of replaced objects (`core/views.py:2521-2522`), after commit. */
  async function removeObjects(user: Principal, documentId: string, keys: string[]) {
    for (const key of keys)
      try {
        await storage().remove(key);
      } catch {
        options.documentationLog?.({
          module: 'administration',
          resource: 'documentation-media',
          eventId: 'administration.documentation-media.delete-failed',
          requestId: traceId(),
          userId: user.id,
          documentId,
        });
      }
  }
  async function uploaderNames(rows: Tutorial[]) {
    const ids = [...new Set(rows.map((row) => BigInt(row.created_by)))];
    const users = ids.length
      ? await db
          .get('primary')
          .select({ id: PosUser.id, first: PosUser.first_name, last: PosUser.last_name })
          .from(PosUser)
          .where(inArray(PosUser.id, ids))
      : [];
    return new Map(users.map((user) => [String(user.id), `${user.first} ${user.last}`.trim()]));
  }
  function response(row: Tutorial, uploaderName = 'Unknown') {
    let files: Attachment[] = [],
      mediaState: 'available' | 'not-configured' | 'invalid-metadata' = options.mediaStore
        ? 'available'
        : 'not-configured';
    try {
      files = attachmentList(row);
    } catch {
      mediaState = 'invalid-metadata';
    }
    const assets = files.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      contentType: asset.contentType,
      url: `/api/v1/documentation/${row.id}/assets/${asset.id}/content`,
    }));
    const urls = (kind: MediaKind) =>
      JSON.stringify(assets.filter((asset) => asset.kind === kind).map((asset) => asset.url));
    // Legacy _detail.html:16 renders {{discription}}; Django prints NULL as 'None'.
    const html = sanitizeDocumentationHtml(row.discription ?? 'None');
    return {
      id: String(row.id),
      title: row.title,
      summary: row.short_discription,
      description: html,
      descriptionHtml: html,
      coverImage: urls('cover-image'),
      images: urls('image'),
      videos: urls('video'),
      documents: urls('document'),
      keywords: row.search_keyword,
      sortOrder: row.sort_value,
      active: row.is_active,
      version: versionOf(row),
      assets,
      mediaState,
      updatedAt: row.updated_at,
      uploaderName,
    };
  }
  async function replay(
    user: Principal,
    input: DocumentationInput,
    hash: string,
    documentId?: string,
  ) {
    const raw = await ephemeral.get(documentationMutationKey(input.operationId));
    if (raw === null) return null;
    const existing = mutationReceipt.parse(JSON.parse(raw) as unknown);
    if (
      existing.actorId !== user.id ||
      existing.requestHash !== hash ||
      (documentId && existing.documentId !== documentId)
    )
      throw new AppError(
        409,
        'DOCUMENTATION_OPERATION_CONFLICT',
        'This save operation belongs to another guide change.',
      );
    return {
      id: existing.documentId,
      version: existing.version,
      status: 'success',
      message: existing.created
        ? 'Documentation has been created.'
        : 'Documentation has been updated.',
    };
  }
  return {
    capabilities(user: Principal) {
      requireRole(user, [1]);
      return {
        enabled: !!options.mediaStore,
        types: Object.entries(mediaTypes).map(([contentType, type]) => ({
          contentType,
          kind: type.kind,
          extension: type.extension,
          maximumBytes: type.max,
        })),
        maximumPendingFiles: 40,
      };
    },
    async list(user: Principal, page: z.infer<typeof documentationPageQuery>) {
      if (user.role !== 1 && page.active !== 'true')
        throw new AppError(
          403,
          'DOCUMENTATION_ACCESS_DENIED',
          'Archived documentation requires a super administrator.',
        );
      const collection = page.sort
        ? administrationCollectionPage(
            page,
            JSON.stringify(['documentation', user.id, user.role, user.userType]),
            collectionField(PosTutorial.id, 'id', 'integer'),
            {
              title: collectionField(PosTutorial.title, 'title'),
              summary: collectionField(PosTutorial.short_discription, 'short_discription'),
              uploader: collectionField(PosTutorial.created_by, 'created_by'),
              sortOrder: collectionField(PosTutorial.sort_value, 'sort_value', 'integer'),
              updatedAt: collectionField(PosTutorial.updated_at, 'updated_at'),
              active: collectionField(PosTutorial.is_active, 'is_active', 'integer'),
            },
          )
        : null;
      let cursor: ReturnType<typeof decodeDocumentationCursor>;
      try {
        cursor = collection ? null : decodeDocumentationCursor(page.after);
      } catch {
        throw new AppError(400, 'INVALID_DOCUMENTATION_CURSOR', 'Choose a valid guide page.');
      }
      const rows = await db
        .get('primary')
        .select()
        .from(PosTutorial)
        .where(
          and(
            page.active === 'all'
              ? undefined
              : eq(PosTutorial.is_active, page.active === 'true' ? 1 : 0),
            collection
              ? collection.boundary
              : cursor
                ? or(
                    lt(PosTutorial.sort_value, cursor.sort),
                    and(
                      eq(PosTutorial.sort_value, cursor.sort),
                      gt(PosTutorial.id, BigInt(cursor.id)),
                    ),
                  )
                : undefined,
            page.search
              ? or(
                  like(PosTutorial.title, `%${page.search.replace(/[\\%_]/g, '\\$&')}%`),
                  like(PosTutorial.search_keyword, `%${page.search.replace(/[\\%_]/g, '\\$&')}%`),
                )
              : undefined,
          ),
        )
        .orderBy(...(collection?.order ?? [desc(PosTutorial.sort_value), asc(PosTutorial.id)]))
        .limit(page.limit + 1);
      const selected = rows.slice(0, page.limit);
      const names = await uploaderNames(selected);
      return {
        data: selected.map((row) => response(row, names.get(String(row.created_by)))),
        nextCursor: collection
          ? collection.finish(rows).nextCursor
          : rows.length > page.limit
            ? encodeDocumentationCursor(selected.at(-1)!.sort_value, selected.at(-1)!.id)
            : null,
      };
    },
    async detail(user: Principal, documentId: string) {
      const [row] = await db
        .get('primary')
        .select()
        .from(PosTutorial)
        .where(eq(PosTutorial.id, BigInt(documentId)))
        .limit(1);
      const document = required(row);
      readerAccess(user, document);
      return response(document, (await uploaderNames([document])).get(String(document.created_by)));
    },
    async setStatus(user: Principal, documentId: string, active: boolean) {
      requireRole(user, [1]);
      return locked(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentOperatorRole(transaction, user.id, [1]);
          const [row] = await transaction
            .select({ id: PosTutorial.id, active: PosTutorial.is_active })
            .from(PosTutorial)
            .where(eq(PosTutorial.id, BigInt(documentId)))
            .limit(1)
            .for('update');
          const document = required(row);
          if (document.active !== (active ? 1 : 0))
            await transaction
              .update(PosTutorial)
              .set({ is_active: active ? 1 : 0, updated_at: localNow() })
              .where(eq(PosTutorial.id, BigInt(documentId)));
          return { status: 'success', message: 'documentation status updated' };
        }),
      );
    },
    async reserve(user: Principal, input: UploadInput) {
      requireRole(user, [1]);
      const media = storage(),
        generated = media.keyFor(input),
        objectKey = generated.replace(
          /\/[^/]+$/,
          `/${fileBase(input.name)}_${input.id}.${mediaTypes[input.contentType].extension}`,
        );
      media.assertKey(objectKey);
      await db
        .get('writer')
        .transaction((transaction) => assertCurrentOperatorRole(transaction, user.id, [1]));
      const existing = await pending(input.id);
      let row: PendingUpload;
      if (existing) {
        if (
          existing.actorId !== user.id ||
          existing.state !== 'PENDING' ||
          existing.objectKey !== objectKey ||
          existing.checksum !== input.checksum ||
          existing.size !== input.size ||
          existing.contentType !== input.contentType ||
          existing.name !== input.name
        )
          throw new AppError(
            409,
            'DOCUMENTATION_UPLOAD_CONFLICT',
            'Choose this file again to start a fresh upload.',
          );
        row = existing;
      } else {
        let open = 0;
        for (const key of await ephemeral.scanKeys('pos:doc_upload:*')) {
          const other = await pending(key.slice('pos:doc_upload:'.length));
          if (other?.actorId === user.id) open++;
        }
        if (open >= 40)
          throw new AppError(
            429,
            'DOCUMENTATION_UPLOAD_LIMIT',
            'Finish or cancel existing guide uploads before adding more.',
          );
        row = {
          id: input.id,
          objectKey,
          actorId: user.id,
          kind: input.kind,
          name: input.name,
          contentType: input.contentType,
          size: input.size,
          checksum: input.checksum,
          state: 'PENDING',
          expiresAt: utcMediaTimestamp(Temporal.Now.instant().add({ hours: 1 })),
        };
        if (
          !(await ephemeral.set(documentationUploadKey(row.id), JSON.stringify(row), {
            NX: true,
            EX: 3600,
          }))
        )
          throw new AppError(
            409,
            'DOCUMENTATION_UPLOAD_CONFLICT',
            'Choose this file again to start a fresh upload.',
          );
      }
      return {
        id: row.id,
        expiresAt: row.expiresAt.replace(' ', 'T') + 'Z',
        upload: await media.upload(specification(row)),
      };
    },
    async complete(user: Principal, id: string) {
      requireRole(user, [1]);
      const media = storage();
      const row = await pending(id);
      if (!row || row.actorId !== user.id)
        throw new AppError(
          409,
          'DOCUMENTATION_UPLOAD_EXPIRED',
          'Choose the file again to renew its upload.',
        );
      if (row.state === 'READY') return { id, status: 'success', message: 'Attachment is ready.' };
      await media.verify(specification(row));
      await db
        .get('writer')
        .transaction((transaction) => assertCurrentOperatorRole(transaction, user.id, [1]));
      await savePending({ ...row, state: 'READY' });
      return { id, status: 'success', message: 'Attachment is ready.' };
    },
    async cancel(user: Principal, id: string) {
      requireRole(user, [1]);
      await db
        .get('writer')
        .transaction((transaction) => assertCurrentOperatorRole(transaction, user.id, [1]));
      const row = await pending(id);
      if (!row || row.actorId !== user.id)
        throw new AppError(
          404,
          'DOCUMENTATION_UPLOAD_NOT_FOUND',
          'Pending guide upload was not found.',
        );
      if (await ephemeral.delIfEquals(documentationUploadKey(id), JSON.stringify(row)))
        await removeObjects(user, 'pending', [row.objectKey]);
      return { status: 'success', message: 'Guide upload canceled.' };
    },
    /** `UploadOrEditTutorial.post` (`core/views.py:2475-2600`). */
    async save(user: Principal, input: DocumentationInput, documentId?: string) {
      requireRole(user, [1]);
      const normalized = {
          ...input,
          retainAssetIds: [...new Set(input.retainAssetIds)].sort(),
          uploadIds: [...new Set(input.uploadIds)].sort(),
        },
        hash = createHash('sha256')
          .update(JSON.stringify({ documentId: documentId || null, ...normalized }))
          .digest('hex');
      const repeated = await replay(user, normalized, hash, documentId);
      if (repeated) return repeated;
      const html = sanitizeDocumentationHtml(input.description);
      if (html.length > 1000)
        throw new AppError(
          400,
          'DOCUMENTATION_DESCRIPTION_TOO_LONG',
          'Shorten the guide description or its formatting.',
        );
      const uploads: PendingUpload[] = [];
      for (const id of normalized.uploadIds) {
        const upload = await pending(id);
        if (!upload || upload.actorId !== user.id || upload.state !== 'READY')
          throw new AppError(
            409,
            'DOCUMENTATION_UPLOAD_NOT_READY',
            'Complete each new attachment upload before saving.',
          );
        uploads.push(upload);
      }
      const outcome = await locked(() =>
        db.get('writer').transaction(async (transaction) => {
          await assertCurrentOperatorRole(transaction, user.id, [1]);
          const [current] = documentId
            ? await transaction
                .select()
                .from(PosTutorial)
                .where(eq(PosTutorial.id, BigInt(documentId)))
                .limit(1)
                .for('update')
            : [];
          if (documentId && !current)
            throw new AppError(404, 'DOCUMENTATION_NOT_FOUND', 'Guide was not found.');
          if ((current ? versionOf(current) : '') !== input.expectedVersion)
            throw new AppError(
              409,
              'DOCUMENTATION_VERSION_CONFLICT',
              'This guide changed. Reload it before saving.',
            );
          const currentFiles = current ? attachmentList(current) : [];
          if (
            normalized.retainAssetIds.some((id) => !currentFiles.some((asset) => asset.id === id))
          )
            throw new AppError(
              400,
              'DOCUMENTATION_ASSET_SCOPE_DENIED',
              'Keep only attachments already belonging to this guide.',
            );
          const selected = currentFiles.filter((asset) =>
            normalized.retainAssetIds.includes(asset.id),
          );
          selected.push(
            ...uploads.map((asset) => ({
              id: asset.id,
              key: asset.objectKey,
              kind: asset.kind,
              name: asset.name,
              contentType: asset.contentType,
            })),
          );
          if (selected.filter((asset) => asset.kind === 'cover-image').length > 1)
            throw new AppError(
              400,
              'DOCUMENTATION_COVER_CONFLICT',
              'Keep one cover image for this guide.',
            );
          const updatedAt = localNow(),
            values = {
              title: input.title,
              short_discription: input.summary,
              discription: html,
              search_keyword: input.keywords,
              sort_value: input.sortOrder,
              created_by: legacyIntegerReference(user.id),
              updated_at: updatedAt,
              cover_image: '[]',
              image_link: '[]',
              video_link: '[]',
              doc_link: '[]',
            };
          for (const [kind, column] of Object.entries(columns)) {
            const serialized = JSON.stringify(
              selected.filter((asset) => asset.kind === kind).map((asset) => asset.key),
            );
            if (serialized.length > 1000)
              throw new AppError(
                400,
                'DOCUMENTATION_ATTACHMENT_CAPACITY',
                'Use fewer attachments in this guide.',
              );
            values[column as (typeof columns)[MediaKind]] = serialized;
          }
          let id: bigint;
          if (current) {
            id = current.id;
            await transaction.update(PosTutorial).set(values).where(eq(PosTutorial.id, id));
          } else {
            const created = await transaction
              .insert(PosTutorial)
              .values({ ...values, is_active: 1, created_at: localNow() });
            id = generatedId(created);
          }
          return {
            id: String(id),
            version: updatedAt,
            created: !current,
            removed: currentFiles
              .filter((asset) => !normalized.retainAssetIds.includes(asset.id))
              .map((asset) => asset.key),
          };
        }),
      );
      await ephemeral.set(
        documentationMutationKey(input.operationId),
        JSON.stringify({
          actorId: user.id,
          requestHash: hash,
          documentId: outcome.id,
          version: outcome.version,
          created: outcome.created,
        }),
        { NX: true, EX: 86400 },
      );
      for (const upload of uploads) await ephemeral.del(documentationUploadKey(upload.id));
      await removeObjects(user, outcome.id, outcome.removed);
      return {
        id: outcome.id,
        version: outcome.version,
        status: 'success',
        message: outcome.created
          ? 'Documentation has been created.'
          : 'Documentation has been updated.',
      };
    },
    async content(
      user: Principal,
      documentId: string,
      assetId: string,
      range?: string,
      signal?: AbortSignal,
    ) {
      // Download references authorize access and must be writer-current.
      const [row] = await db
        .get('writer')
        .select()
        .from(PosTutorial)
        .where(eq(PosTutorial.id, BigInt(documentId)))
        .limit(1);
      const document = required(row);
      readerAccess(user, document);
      const file = attachmentList(document).find((asset) => asset.id === assetId);
      if (!file)
        throw new AppError(
          404,
          'DOCUMENTATION_ATTACHMENT_NOT_FOUND',
          'Attachment was not found in this guide.',
        );
      if (range) {
        if (!/^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/.test(range))
          throw new AppError(
            416,
            'DOCUMENTATION_RANGE_INVALID',
            'Choose a valid attachment range.',
          );
        const [start, end] = range.slice(6).split('-');
        if (start && end && BigInt(start) > BigInt(end))
          throw new AppError(
            416,
            'DOCUMENTATION_RANGE_INVALID',
            'Choose a valid attachment range.',
          );
      }
      const download = await storage().stream(file.key, file.kind, range, signal);
      return { ...download, name: file.name, kind: file.kind };
    },
  };
}
