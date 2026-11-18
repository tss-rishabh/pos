# W2 deletion follow-ups

Workstream W2 removed the subsystems listed in `AGENTS.md` ("Single-stack and
schema-freeze decisions" and "Revisions, 19 November 2026"). This file lists
what the deletions left for the re-homing workstreams (W3–W5) and the parity
evidence gaps they opened. Legacy references are to `backend-pos-web@78d5b63`
unless another repository is named. No entry below is implemented. Each one is
an open item, not parity evidence.

## Screening subsystem and CSV order import (commit 1)

- **W4: Membership-order cancellation fence.**
  `src/modules/checkout/cancellations/membership-fence.ts` used to require the
  four rewrite-installed `pos_rewrite_mem_*` triggers on `user_eav`/`users`. It
  read them through the deleted screening `native-head-metadata` routine. Those
  triggers do not exist in production and are forbidden by the schema freeze, so
  the trigger part of the fence and `membership-fence-contract.ts` were removed.
  The column and index checks remain. Decide whether membership cancellations
  need a Redis lock, or whether legacy behaviour is enough. Legacy cancels
  through `order/views.py:2900` (`AjaxOrderCancelView`) with no such fence.
- **W4: Import-order holds removed from financial writers.** Payments, returns,
  pending cancellations, the finalizer and the whole-order-status handover no
  longer call `assertImportOrderMutationAvailable`. The order-import binding
  table that held imported orders is gone. Legacy has no equivalent hold
  because CSV order punch-in is disabled (`core/urls.py:72-76`).
- **W4: Screening cancellation guard kept.**
  `cancellations/repository.ts` still refuses SKU 390238 cancellation
  (`CANCELLATION_SCREENING_UNSUPPORTED`). This mirrors API-v2
  `controllers/OrderController.py:5482`@2960acb and reads only production
  tables. It is not part of the deleted screening writer.
- **Test fixtures re-homed.** `tests/return-window/native.mysql.test.ts` used to
  borrow the deleted CSV-import financial fixture. It now uses
  `tests/return-window/native-fixture.ts`, which creates the same legacy tables
  and surviving migrations. Its assertions are unchanged.
  `tests/checkout/cancellation-benefits.mysql.test.ts` no longer installs the
  native head/trigger fixture and runs on a plain per-run schema.

## Cash-return intent protocol (commit 2)

The intent protocol from `e1e2fce` was reverted. The PREPARED, armed, attested
and recorded intents, the retained-device claims, the signed per-store and
per-day controls, the publication v2 head binding, the pending queue UI and the
whole-order handover barrier are gone. The recorded cash correction from
`8f82783` (`payment-reversals`) is back in its pre-intent form. The
`checkout/order-mutation-guards.ts` composition and the whole-order-status
`assertHandoverAvailable` barrier are deleted. Their only callers were the cash
return and import holds.

- **W4: Restore legacy `AjaxPaymentStatusView`**
  (`order/views.py:685-775`, route `order/urls.py:40`
  `ajax-payment-status/`). Legacy behaviour, POST form fields `order_id`,
  `pay_type` (is_manually_paid), `transaction_id`, `p_status`, `message`,
  `offline_payment`, `online_payment`, `o_status`:
  - When `pay_type` is set, `offline_payment + online_payment` must equal
    `orders.pay_amt`. Otherwise it returns `{"status":"fail","message":"Incorrect Pay amount."}`.
  - It updates every `order_stores` row of the order: `is_manually_paid`,
    `transaction_id`, `message`, `offline_payment`, `online_payment`.
  - It sets `orders.payment_statuses`/`order_statuses` to (`p_status`,
    `o_status`) when manually paid, otherwise to (1, 1). The line status is
    `order_status.order_status` of `o_status` when paid, otherwise `PLACED`.
  - Paid: it inserts a `comments` row "Store Order: {status} status changed by pos
    admin." (notify 0, current user), pushes the order to Kinesis
    (`Helpers.push_order_kinesis`) and to EM (`Helpers.push_for_em`).
  - Reverted: it inserts "Store Order: Status Reverted to PLACED by pos admin."
    and **deletes every `comments` row with `status_id=3`** for the order. The
    counter amount is handed back with no durable return record.
  - It updates every `has_products` row of the order to the line status.
  - It calls `mark_stale(store_id, order_close_date(order_id), 'MANUAL_PAID' |
    'PAYMENT_REVERSED', order_id)` (day-close staleness) and
    `Helpers.transaction_logger(order_id, store_id, 0, user, pay_dict,
    log_comment)` (`pos_transaction_log`).
  - It responds `{"status":"success","message":"Payment status updated successfully."}`,
    or `fail` with the exception text.
  W4 must decide whether the retained `payment-reversals` correction (which
  rejects the arbitrary status/amount reset) or a literal port is the parity
  target. Record that decision in `parity/payment-reversals.md`.
- **W4/W5: Day-close and ledger fences.** The DSR, ledger and day-close
  snapshots no longer read cash-return controls. Legacy relies on `mark_stale`
  instead (see above). The rewrite has no equivalent of `mark_stale` for
  reversals yet.
