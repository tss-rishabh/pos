# Gift-card batch generation, print and block (W8d, schema freeze)

Source: `backend-pos-web@78d5b63`, `core/urls.py:103-107`, `core/views.py:2169-2252`,
`core/datatables/gift_card_datatable.py`, `core/tasks.py:208-223`, `helpers/helpers.py:1265-1371,1418-1475`,
template `core/templates/gift_card/index.html`. This is the physical-card batch family. Generation writes a CSV of
codes and PINs and does **not** create `gift_vouchers`, balances or money movements.

## Behaviour (legacy, with one approved divergence)

| Legacy | Rewrite | Notes |
| --- | --- | --- |
| `GiftCardView` page | `GET /api/v1/gift-card-batches/capabilities` + `GiftCardBatchesPage` | Page shows the cleaned delivery email and the legacy password instructions verbatim. |
| `AjaxGiftCardListView` (POST datatable) | `POST /api/v1/gift-card-batches/search` | All collections, one sort column (`id`, `size`, `message`, `created_by`, `created_at`), Django paginator fallback to page 1, creator `get_full_name()`, `'%Y-%m-%d %H:%M:%S'`. `draw == 1` writes `pos_special_permission_activity_log` (`Gift Card` / `Viewed the gift card batch list`). Primary reader (interactive read). |
| `AjaxGenerateGiftCardView` | `POST /api/v1/gift-card-batches` | Inserts `gift_card_collection(size, message, created_by, is_completed=0, is_block=0, is_printed=0, filename='')`, then, after commit, enqueues `pos.gift_card_batches.generate` on queue `core` with `{collectionId, size, userId}`. |
| `generate_and_upload_gift_card` (called inline) | job handler `src/modules/gift-card-batches/jobs.ts` | **Approved divergence** (user, 19 Nov): runs on the Redis job queue. Body as legacy: `Helpers.generate_gift_card` → CSV → `pyminizip` zip (ZipCrypto, level 5, entry `GFTCRDS-<ts><6 digits>.csv`) with the legacy derived password → `storage.upload('uploads/csv/giftcards/GFTCRDS-….zip')` → Netcore mail `GC Card Data` with `GC_CARD_DATA.zip` → `filename`, `is_completed=1`, `message += '| File has been sent on {email}'` (truncated to 255 explicitly, as non-strict MySQL stores it). |
| `AjaxPrintGiftCardView` | `PUT /api/v1/gift-card-batches/:id/print-status` | Sets `is_printed=1` (no completion check, as legacy; the UI only offers it on completed rows). |
| `AjaxBlockGiftCardView` | `PUT /api/v1/gift-card-batches/:id/block-status` `{opr:'block'|'active'}` | `active` → `is_block=0`, otherwise 1; message `Marked as {opr}`. |

Failure semantics follow legacy: generation or zip failure leaves `is_completed=0`; a storage upload or email failure
is logged and swallowed, and the collection is still completed. A job that finds the collection already completed does
nothing (guards an operator re-queue). The phone and email are read from `pos_user` by the job (args carry ids only),
so a contact edited between request and job uses the new value.

Archive password: `last 6 characters of pos_user.phone + collection id`, or `'123456' + collection id` when the phone
is empty (`helpers/helpers.py:1345-1350`). This is weak and predictable; it is used because the user mandated legacy
behaviour (AGENTS.md, 19 Nov). The rewrite's random password, sealed secrets, retrievable password, owner download,
frozen archive and delivery-state machine are removed.

Kept differences: the list search box works, limited to the fields legacy configures (user decision N7, 19 Nov 2026).
Legacy filters `product__product__icontains | product__id__icontains` (`core/datatables/gift_card_datatable.py:47-51`),
but `gift_card_collection` has no product relation (`core/models.py:742-757`), so legacy raises `FieldError` on every
non-empty search. The rewrite matches the `id` lookup literally; the product name has no column and is not searched; the size must be an integer 1–10 000 (legacy accepts any
truthy integer, including negatives, from a direct POST); messages with characters outside MySQL latin1 are rejected
instead of stored as `?`.

## Messages (S4)

| Case | Legacy (HTTP 200 JSON) | Rewrite |
| --- | --- | --- |
| Generated | `success` / "Gift Cards Generated, Please check your mail box." | 200 "Gift card generation started. The file will be emailed to you." (generation is queued) |
| Missing size/message | `failed` / "Please provide the data" | 400 validation error |
| No email on the requester | `failed` / "Not Eligible to generate the GCs." (row already created) | 422 `GIFT_CARD_BATCH_NOT_ELIGIBLE` "Not Eligible to generate the GCs." (row already created, as legacy) |
| Unknown collection (print/block) | `failed` / "Please provide valid data" | 404 `GIFT_CARD_BATCH_NOT_FOUND` |
| Printed / blocked / activated | `success` / "Marked as printed", "Marked as block", "Marked as active" | same, 200 |
| Role not 1/2, or franchise | redirect + "Permisssion denied" | 403 `GIFT_CARD_BATCH_ACCESS_DENIED` |
| Not configured (`GC_SALTKEY`, bucket, Netcore) | task fails or swallows | 503 `GIFT_CARD_BATCH_GENERATION_UNAVAILABLE` before any write |
| Operation id reused with other input | — | 409 `GIFT_CARD_BATCH_OPERATION_REUSED` |

## State

- Durable: `gift_card_collection` only (`filename`, `is_completed`, `message`, `is_printed`, `is_block`).
- Redis: `pos:idem:gift_card_batch:{operationId}` → JSON `{state: pending|created|done, actorId, inputHash, batchId?, outcome?}`, `EX 86400`.
- Queue: `pos.gift_card_batches.generate`, queue `core`, args `{collectionId, size, userId}`.
- No lock: legacy has none and every write is a single-row insert or flag update.

## Configuration

`GC_SALTKEY`, `AWS_STORAGE_BUCKET_NAME` (+ optional `AWS_S3_*`), `NETCORE_EMAIL_URL`, `NETCORE_API_KEY`,
`GIFT_CARD_BATCH_DELIVERY_TIMEOUT_MS` (default 30 000). The handler runs in `worker:jobs`.

## Checks

`tests/administration/gift-card-batches.test.ts` (pinned Python CSV/Hashids/PIN oracle, email cleanup, password and
file names, ZipCrypto archive), `gift-card-batch-adapters.test.ts` (S3 key/private bucket, Netcore payload and
swallowed failures), `gift-card-batches.mysql.test.ts` (isolated MySQL: insert + enqueue + receipt replay, job
success, swallowed storage/email failures, failed generation, no-email ghost row, franchise denial, print/block,
list paging/sort/activity log; run with `GIFT_CARD_BATCH_MYSQL_TEST_URL=mysql://root@127.0.0.1:<port>/x`). No real
storage, email or job queue is contacted.

Open: Windows/macOS unzip of the ZipCrypto archive and live Netcore/S3 acceptance are not certified here.
