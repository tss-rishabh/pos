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
