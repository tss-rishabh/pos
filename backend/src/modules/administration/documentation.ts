import { administrationCollectionPage, collectionField } from './collection-page.js';
import { generatedId } from '../../db/generated-id.js';
import { randomUUID, createHash } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { and, asc, count, desc, eq, gt, inArray, like, lt, or } from 'drizzle-orm';
import type { z } from 'zod';
import type { Config } from '../../config.js';
import type { Databases } from '../../db/pools.js';
import { PosTutorial, PosUser } from '../../db/legacy-schema.js';
import { requireRole, type Principal } from '../../domain/access.js';
import { AppError } from '../../domain/errors.js';
import { retryTransaction } from '../../db/retry.js';
import { currentRequestTrace } from '../../observability/context.js';
import {
  documentationAssets,
  documentationMutations,
  documentationRevisions,
} from './media-schema.js';
import {
  assetDigest,
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
import { lockAdministrationRegistry } from './locks.js';
import { legacyIntegerReference } from './policies.js';
import type { AdministrationTransaction } from './checkins.js';
import { assertCurrentOperatorRole } from './authorization.js';

export interface DocumentationOptions {
  mediaStore?: DocumentationMediaStore;
}
type Tutorial = typeof PosTutorial.$inferSelect;
type Asset = typeof documentationAssets.$inferSelect;
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
function attachmentList(row: Tutorial, owned: Asset[]): Attachment[] {
  const result: Attachment[] = [];
  for (const [kind, column] of Object.entries(columns))
    for (const key of parseLegacyAssetList(row[column as (typeof columns)[MediaKind]])) {
      const matched = owned.find((asset) => asset.objectKey === key && asset.kind === kind);
      result.push({
        id: matched?.id || legacyAssetId(kind as MediaKind, key),
        key,
        kind: kind as MediaKind,
        name: matched?.name || key.split('/').at(-1) || 'Attachment',
        contentType: matched?.contentType || mediaContentTypeFromKey(key),
      });
    }
  return result;
}
function specification(row: Asset): ReservedMedia {
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
export function documentationService(
  config: Config,
  db: Databases,
  options: DocumentationOptions = {},
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
  async function attachments(
    database: AdministrationTransaction | ReturnType<Databases['get']>,
    rows: Tutorial[],
  ) {
    const ids = rows.map((row) => row.id);
    return ids.length
      ? database
          .select()
          .from(documentationAssets)
          .where(
            and(
              inArray(documentationAssets.documentId, ids),
              eq(documentationAssets.state, 'ATTACHED'),
            ),
          )
      : [];
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
  function response(row: Tutorial, owned: Asset[], version: number, uploaderName = 'Unknown') {
    let files: Attachment[] = [],
      mediaState: 'available' | 'not-configured' | 'invalid-metadata' = options.mediaStore
        ? 'available'
        : 'not-configured';
    try {
      files = attachmentList(row, owned);
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
    const html = sanitizeDocumentationHtml(row.discription);
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
      version,
      assets,
      mediaState,
      updatedAt: row.updated_at,
      uploaderName,
    };
  }
  async function replay(
    transaction: AdministrationTransaction | ReturnType<Databases['get']>,
    user: Principal,
    input: DocumentationInput,
    hash: string,
    documentId?: string,
  ) {
    const [existing] = await transaction
      .select()
      .from(documentationMutations)
      .where(eq(documentationMutations.id, input.operationId))
      .limit(1);
    if (!existing) return null;
    if (
      existing.actorId !== user.id ||
      existing.requestHash !== hash ||
      (documentId && String(existing.documentId) !== documentId)
    )
      throw new AppError(
        409,
        'DOCUMENTATION_OPERATION_CONFLICT',
        'This save operation belongs to another guide change.',
      );
    return {
      id: String(existing.documentId),
      version: existing.version,
      status: 'success',
      message: documentId ? 'Documentation has been updated.' : 'Documentation has been created.',
    };
  }
  async function queueRemoval(
    transaction: AdministrationTransaction,
    user: Principal,
    asset: Attachment,
    documentId: bigint,
  ) {
    const digest = assetDigest(asset.key),
      now = utcMediaTimestamp();
    const [existing] = await transaction
      .select()
      .from(documentationAssets)
      .where(eq(documentationAssets.objectDigest, digest))
      .limit(1)
      .for('update');
    if (existing) {
      if (existing.objectKey !== asset.key)
        throw new AppError(
          409,
          'DOCUMENTATION_ASSET_CONFLICT',
          'Attachment identity could not be verified.',
        );
      await transaction
        .update(documentationAssets)
        .set({
          state: 'DELETE_PENDING',
          documentId,
          attempts: 0,
          updatedAt: now,
          requestId: traceId(),
          actorId: user.id,
        })
        .where(eq(documentationAssets.id, existing.id));
    } else
      await transaction.insert(documentationAssets).values({
        id: randomUUID(),
        objectKey: asset.key,
        objectDigest: digest,
        actorId: user.id,
        requestId: traceId(),
        documentId,
        kind: asset.kind,
        source: 'legacy',
        name: asset.name.slice(0, 255),
        contentType: asset.contentType,
        size: 0,
        checksum: null,
        state: 'DELETE_PENDING',
        attempts: 0,
        expiresAt: now,
        createdAt: now,
        updatedAt: now,
      });
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
      const selected = rows.slice(0, page.limit),
        owned = await attachments(db.get('primary'), selected),
        versions = selected.length
          ? await db
              .get('primary')
              .select()
              .from(documentationRevisions)
              .where(
                inArray(
                  documentationRevisions.documentId,
                  selected.map((row) => row.id),
                ),
              )
          : [];
      const names = await uploaderNames(selected);
      return {
        data: selected.map((row) =>
          response(
            row,
            owned.filter((asset) => asset.documentId === row.id),
            versions.find((value) => value.documentId === row.id)?.version || 0,
            names.get(String(row.created_by)),
          ),
        ),
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
      const [version] = await db
        .get('primary')
        .select()
        .from(documentationRevisions)
        .where(eq(documentationRevisions.documentId, document.id))
        .limit(1);
      return response(
        document,
        await attachments(db.get('primary'), [document]),
        version?.version || 0,
        (await uploaderNames([document])).get(String(document.created_by)),
      );
    },
    async setStatus(user: Principal, documentId: string, active: boolean) {
      requireRole(user, [1]);
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'documentation');
          await assertCurrentOperatorRole(transaction, user.id, [1]);
          const [row] = await transaction
            .select({ id: PosTutorial.id, active: PosTutorial.is_active })
            .from(PosTutorial)
            .where(eq(PosTutorial.id, BigInt(documentId)))
            .limit(1)
            .for('update');
          const document = required(row);
          if (document.active !== (active ? 1 : 0)) {
            const [revision] = await transaction
              .select()
              .from(documentationRevisions)
              .where(eq(documentationRevisions.documentId, BigInt(documentId)))
              .limit(1);
            await transaction
              .update(PosTutorial)
              .set({ is_active: active ? 1 : 0, updated_at: localNow() })
              .where(eq(PosTutorial.id, BigInt(documentId)));
            await transaction
              .insert(documentationRevisions)
              .values({
                documentId: BigInt(documentId),
                version: (revision?.version || 0) + 1,
                requestId: traceId(),
              })
              .onDuplicateKeyUpdate({
                set: {
                  version: (revision?.version || 0) + 1,
                  requestId: traceId(),
                },
              });
          }
          return { status: 'success', message: 'documentation status updated' };
        }),
      );
    },
    async reserve(user: Principal, input: UploadInput) {
      requireRole(user, [1]);
      const media = storage(),
        now = utcMediaTimestamp(),
        objectKey = media.keyFor(input);
      const row = await retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'documentation');
          await assertCurrentOperatorRole(transaction, user.id, [1]);
          const [existing] = await transaction
            .select()
            .from(documentationAssets)
            .where(eq(documentationAssets.id, input.id))
            .limit(1)
            .for('update');
          if (existing) {
            if (
              existing.actorId !== user.id ||
              existing.state !== 'PENDING' ||
              existing.objectKey !== objectKey ||
              existing.checksum !== input.checksum ||
              existing.size !== input.size ||
              existing.contentType !== input.contentType ||
              existing.name !== input.name ||
              existing.expiresAt <= now
            )
              throw new AppError(
                409,
                'DOCUMENTATION_UPLOAD_CONFLICT',
                'Choose this file again to start a fresh upload.',
              );
            return existing;
          }
          const [pending] = await transaction
            .select({ total: count() })
            .from(documentationAssets)
            .where(
              and(
                eq(documentationAssets.actorId, user.id),
                inArray(documentationAssets.state, ['PENDING', 'READY']),
                gt(documentationAssets.expiresAt, now),
              ),
            );
          if ((pending?.total || 0) >= 40)
            throw new AppError(
              429,
              'DOCUMENTATION_UPLOAD_LIMIT',
              'Finish or cancel existing guide uploads before adding more.',
            );
          const value: typeof documentationAssets.$inferInsert = {
            id: input.id,
            objectKey,
            objectDigest: assetDigest(objectKey),
            actorId: user.id,
            requestId: traceId(),
            documentId: null,
            kind: input.kind,
            source: 'upload',
            name: input.name,
            contentType: input.contentType,
            size: input.size,
            checksum: input.checksum,
            state: 'PENDING',
            attempts: 0,
            expiresAt: utcMediaTimestamp(Temporal.Now.instant().add({ hours: 1 })),
            createdAt: now,
            updatedAt: now,
          };
          await transaction.insert(documentationAssets).values(value);
          const [inserted] = await transaction
            .select()
            .from(documentationAssets)
            .where(eq(documentationAssets.id, input.id))
            .limit(1);
          return required(inserted);
        }),
      );
      return {
        id: row.id,
        expiresAt: row.expiresAt.replace(' ', 'T') + 'Z',
        upload: await media.upload(specification(row)),
      };
    },
    async complete(user: Principal, id: string) {
      requireRole(user, [1]);
      const media = storage();
      const [candidate] = await db
        .get('writer')
        .select()
        .from(documentationAssets)
        .where(and(eq(documentationAssets.id, id), eq(documentationAssets.actorId, user.id)))
        .limit(1);
      const row = required(candidate);
      if (row.expiresAt <= utcMediaTimestamp())
        throw new AppError(
          409,
          'DOCUMENTATION_UPLOAD_EXPIRED',
          'Choose the file again to renew its upload.',
        );
      if (row.state === 'READY') return { id, status: 'success', message: 'Attachment is ready.' };
      if (row.state !== 'PENDING' || row.expiresAt <= utcMediaTimestamp())
        throw new AppError(
          409,
          'DOCUMENTATION_UPLOAD_EXPIRED',
          'Choose the file again to renew its upload.',
        );
      await media.verify(specification(row));
      await db.get('writer').transaction(async (transaction) => {
        await assertCurrentOperatorRole(transaction, user.id, [1]);
        const [current] = await transaction
          .select()
          .from(documentationAssets)
          .where(eq(documentationAssets.id, id))
          .limit(1)
          .for('update');
        if (
          !current ||
          current.actorId !== user.id ||
          !['PENDING', 'READY'].includes(current.state) ||
          current.expiresAt <= utcMediaTimestamp()
        )
          throw new AppError(
            409,
            'DOCUMENTATION_UPLOAD_CONFLICT',
            'The upload is no longer available for this guide.',
          );
        await transaction
          .update(documentationAssets)
          .set({ state: 'READY', updatedAt: utcMediaTimestamp(), requestId: traceId() })
          .where(eq(documentationAssets.id, id));
      });
      return { id, status: 'success', message: 'Attachment is ready.' };
    },
    async cancel(user: Principal, id: string) {
      requireRole(user, [1]);
      await db.get('writer').transaction(async (transaction) => {
        await assertCurrentOperatorRole(transaction, user.id, [1]);
        const [row] = await transaction
          .select()
          .from(documentationAssets)
          .where(and(eq(documentationAssets.id, id), eq(documentationAssets.actorId, user.id)))
          .limit(1)
          .for('update');
        if (!row || !['PENDING', 'READY', 'DELETE_PENDING'].includes(row.state))
          throw new AppError(
            404,
            'DOCUMENTATION_UPLOAD_NOT_FOUND',
            'Pending guide upload was not found.',
          );
        await transaction
          .update(documentationAssets)
          .set({ state: 'DELETE_PENDING', updatedAt: utcMediaTimestamp(), requestId: traceId() })
          .where(eq(documentationAssets.id, id));
      });
      return { status: 'success', message: 'Guide upload canceled.' };
    },
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
      const repeated = await replay(db.get('writer'), user, normalized, hash, documentId);
      if (repeated) return repeated;
      const html = sanitizeDocumentationHtml(input.description);
      if (html.length > 1000)
        throw new AppError(
          400,
          'DOCUMENTATION_DESCRIPTION_TOO_LONG',
          'Shorten the guide description or its formatting.',
        );
      return retryTransaction(() =>
        db.get('writer').transaction(async (transaction) => {
          await lockAdministrationRegistry(transaction, 'documentation');
          await assertCurrentOperatorRole(transaction, user.id, [1]);
          const existingResult = await replay(transaction, user, normalized, hash, documentId);
          if (existingResult) return existingResult;
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
          const [revision] = current
            ? await transaction
                .select()
                .from(documentationRevisions)
                .where(eq(documentationRevisions.documentId, current.id))
                .limit(1)
                .for('update')
            : [];
          const version = revision?.version || 0;
          if (version !== input.expectedVersion)
            throw new AppError(
              409,
              'DOCUMENTATION_VERSION_CONFLICT',
              'This guide changed. Reload it before saving.',
            );
          const currentFiles = current
            ? attachmentList(current, await attachments(transaction, [current]))
            : [];
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
          const uploads = normalized.uploadIds.length
            ? await transaction
                .select()
                .from(documentationAssets)
                .where(inArray(documentationAssets.id, normalized.uploadIds))
                .orderBy(asc(documentationAssets.id))
                .for('update')
            : [];
          if (
            uploads.length !== normalized.uploadIds.length ||
            uploads.some(
              (asset) =>
                asset.actorId !== user.id ||
                asset.state !== 'READY' ||
                asset.expiresAt <= utcMediaTimestamp(),
            )
          )
            throw new AppError(
              409,
              'DOCUMENTATION_UPLOAD_NOT_READY',
              'Complete each new attachment upload before saving.',
            );
          selected.push(
            ...uploads.map((asset) => ({
              id: asset.id,
              key: asset.objectKey,
              kind: mediaKind.parse(asset.kind),
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
          const values = {
            title: input.title,
            short_discription: input.summary,
            discription: html,
            search_keyword: input.keywords,
            sort_value: input.sortOrder,
            created_by: legacyIntegerReference(user.id),
            updated_at: localNow(),
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
          if (uploads.length)
            await transaction
              .update(documentationAssets)
              .set({
                state: 'ATTACHED',
                documentId: id,
                updatedAt: utcMediaTimestamp(),
                requestId: traceId(),
              })
              .where(
                inArray(
                  documentationAssets.id,
                  uploads.map((asset) => asset.id),
                ),
              );
          for (const removed of currentFiles.filter(
            (asset) => !normalized.retainAssetIds.includes(asset.id),
          ))
            await queueRemoval(transaction, user, removed, id);
          await transaction
            .insert(documentationRevisions)
            .values({ documentId: id, version: version + 1, requestId: traceId() })
            .onDuplicateKeyUpdate({ set: { version: version + 1, requestId: traceId() } });
          await transaction.insert(documentationMutations).values({
            id: input.operationId,
            actorId: user.id,
            requestId: traceId(),
            requestHash: hash,
            documentId: id,
            version: version + 1,
            createdAt: utcMediaTimestamp(),
          });
          return {
            id: String(id),
            version: version + 1,
            status: 'success',
            message: current
              ? 'Documentation has been updated.'
              : 'Documentation has been created.',
          };
        }),
      );
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
      const file = attachmentList(document, await attachments(db.get('writer'), [document])).find(
        (asset) => asset.id === assetId,
      );
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
