# Existing-order authority recovery deployment

Implementation integration is in progress; this document does not certify the
recovery workflow. Parity, native execution and deployment acceptance remain
deferred until all feature code is integrated.

Apply the additive `authority-succession/migration.sql` through the registered
rewrite migration command before deploying the new financial-stage guards.
Its head and append-only evidence tables are required even when new approval
creation is disabled: disabling a selector cannot reopen an old actor's path.
No migration changes the original financial order, namespace, plan or receipts.

Deploy the matching Node, private Python and Go adapters and the regenerated
source manifest together. The common overlay includes
`legacy_import_succession.go`; private input hashes include
`authority_succession.py` and its consuming protocol/native modules. Preserve
the original proof keys while any retained stage still needs reconciliation.
Selecting a contract does not replace source, schema or cooperating-writer
qualification.

Select new approval creation on Node with
`LEGACY_ORDER_IMPORT_AUTHORITY_SUCCESSION_CONTRACT=pos-import-authority-succession-v1`.
The private Python/Go selector is
`POS_LEGACY_IMPORT_AUTHORITY_SUCCESSION_CONTRACT=pos-import-authority-succession-v1`.
Both example values remain blank by default. The API is registered beneath:

```text
/api/v1/admin/order-imports/:jobId/orders/:operationId/authority-successions
```

The current manager requests a fresh review, explicitly approves its hash and
reason under a retained command UUID, then explicitly continues using that
grant and a separate retained command UUID. GET reads the original approval or
continuation. Retry recovery preserves each original command reference and
does not create a second order or payment. Standalone manager lookup must not
depend on access to another operator's upload page.

Grant authority comes from the current authenticated manager and current native
store/counter/customer/session/period checks. The original actor, contact proof,
order/reference, coupon consumption and completion evidence remain immutable.
An original dispatched/unknown stage must reconcile under its original nonce;
a new approval cannot be used to resend an uncertain charge or publication.
Already sealed results retain their independent immutable recovery path.

Membership entity changes require their own authentic provenance/transfer
evidence. This workflow cannot silently move email-keyed entitlements, revoke
and regrant benefits, or treat a changed contact as proof of those facts.
These cases must be completed by the corresponding implementation before
claiming changed-contact coverage. Keep request bodies, reasons, customer
contact, source capabilities and proof keys out of logs; use the registered
resource event, request ID and authenticated operator ID.
