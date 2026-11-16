# Durable cart review and completion

IndexedDB schema version3 adds owner/draft-scoped review snapshots. The first
review atomically captures the persisted cart and all tabs/reloads reuse that
snapshot. Local edits after review remain distinct from the online checkout.
Legacy recovery identifiers without an original snapshot are rejected while
retaining the local cart.

Completion reads the original snapshot inside the same transaction as receipt
recording, queue cleanup and draft removal. It cannot archive a newer cart just
because a callback supplies its current contents. Newer edits move to a fresh
draft UUID/version; repeated receipts are idempotent. A different receipt for
the same completed draft fails closed. LocalStorage recovery identifiers are
cleared only after that transaction succeeds, and optional cleanup failure does
not undo a known completion.

The server binds one checkout per operator/draft, counter and immutable original
line manifest. Initialization checkpoints confirmed lines and prevents quotes
or submission until the manifest is complete. Reopening a completed import does
not replay old quantities over later explicit online cart edits.

Eight isolated IndexedDB tests include actual close/reopen, twenty simultaneous
captures, corrupt/missing snapshots, operator isolation and preservation of newer
unpaid quantities. The actual production-build CounterPage browser regression
also proves reload/edit/recover/paid completion creates no second order, replays
no lines and preserves the newer cart under a fresh identity. These tests do not
certify external payment/inventory projection contracts.
