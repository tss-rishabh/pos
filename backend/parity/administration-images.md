# Store images (store create/edit form)

Legacy: `stores/forms.py:80` (`store_image` in `StoreCreateForm.Meta.fields`), `_form.html:376-389`
(multipart file input in the same form), `stores/models.py:117` (default
`uploads/stores/stores_image/default_store_image.jpeg`). Legacy never deletes a replaced image.

Rewrite (W8a, schema freeze):
- The file is chosen in the store form. On Submit the browser reserves a private upload
  (`POST /api/v1/admin/store-image-uploads {storeId?, upload}`), posts the bytes to S3 with the signed
  form, then submits the store form with `store_image: <uploadId>`.
- Reservation: Redis `pos:store_image_upload:{uploadId}` → JSON `{id, actorId, storeId|null,
  objectKey, contentType, size, checksum, expiresAt}`, `EX 900`, `SET NX`; at most 5 open per actor.
  It is consumed (deleted) after the store form commits.
- The store service verifies the object (size, type, checksum, full decode) before the writer
  transaction, then writes `stores.store_image` in the same transaction as the other fields.
- Object key `uploads/stores/stores_image/{sanitised original name}_{uploadId}.{ext}` (legacy keeps
  the original name; the UUID suffix replaces Django's random de-duplication suffix).
- Replaced images are never deleted (legacy). The `worker:store-images` cleanup job and
  `pos_rewrite_store_image_uploads/_jobs` are no longer used.
- `GET /api/v1/admin/stores/:storeId/image` and `/image/content` stream the current image (edit
  page header, `edit.html:18-22`).

| Case | Legacy message | Rewrite |
|---|---|---|
| Not an image / corrupt | "Upload a valid image. The file you uploaded was either not an image or a corrupted image." (field error) | 400 `fields.store_image` with the same text |
| Reservation expired | — | 400 `fields.store_image`: "The store image upload expired. Choose the image again." |

Differences kept (security): only JPEG/PNG/WebP/GIF up to 10 MB and 16 MP are accepted (legacy: any
Pillow format); the bytes go to private storage through a signed POST, not through the API server.
Orphans (form rejected after upload, abandoned reservations) need an S3 lifecycle rule on the
`uploads/stores/stores_image/` prefix scoped to rewrite-generated `_<uuid>` keys.
