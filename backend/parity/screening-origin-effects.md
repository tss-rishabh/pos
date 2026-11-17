# Executable source-origin effects

Implementation checkpoint; final source/native/browser validation is deferred
by the user's code-first instruction. All new selectors stay off.

Register `screening-origins/effects-migration.sql`. The existing source worker
calls `main._screening_origins.effect_candidates(limit)` and
`dispatch_effects(commandId)`; shutdown calls `close_worker()`. These methods
use the immutable source creation and encrypted effect payload. The native
SENDING checkpoint precedes each external call, with no SQL locks held over
transport. A stale SENDING claim becomes UNCERTAIN and is never resent.

The source generator's pre-controller hook installs the existing qualified
private Celery factory when the origin selector is selected. It requires
`POS_SCREENING_ORIGIN_EFFECTS_CONTRACT=pos-screening-origin-effects-v1` and the
existing owned AMQPS broker/CA/durable-queue configuration. It does not execute
the original ad-hoc `add_consumer` broadcasts. The original task bodies,
arguments, queue choices and two-task Kinesis canvas are retained. Source
direct-task results are unused and now become separately durable postcommit
task invocations.

The two consumer entries are `celery -A origin_consumer:app worker` and
`celery -A origin_consumer:abandon_app worker`, with source/module paths and
`POS_SCREENING_ORIGIN_EFFECT_CONSUMER_CONTRACT=pos-screening-origin-effects-v1`.
They load the same reviewed source candidate. Purpose-authenticated messages
verify the actual original command/effect/call before the real task body.
Native invocation receipts fence redelivery, retain the original result for
the second canvas step, and leave unknown original executions unresolved.
Consumer logs/stdout/stderr are suppressed; private payloads are never printed.

Original cart persistence uses the original serializer and MySQL cart item/meta
methods inside one owned transaction. Bounded current cart ranges are locked
using qualified full cart_id indexes, then the original namespace hash is
compared. A newer cart is preserved. The cart mutation and its native receipt
commit together, so a lost metadata acknowledgment cannot replay the save.

Deferred Redis mutations capture private bounded dumps. The later Lua command
compares that state (or its exact preceding source-effect owner), performs the
original mutation and writes its purpose-bound receipt atomically. An unrelated
newer cache value is retained and the effect remains unresolved. The original
transaction lock is acquired synchronously with its actual command owner; that
acquisition is never replayed by this worker.

`effect_summary(commandId)` exposes only phase and accepted/total counts to an
authorized caller. COMPLETE here means all obligations reached their recorded
acceptance boundary. It does not mean warehouse/provider/notification delivery,
and it never authorizes order/payment/stock replay. Unknown broker acceptance
still needs an authoritative receipt or manager reconciliation; no generic
resend action is introduced. The legacy HTTP-helper worker remains separate.

System worker discovery is bounded and invokes `SystemOrders.run` only for a
new durable PREPARED job or an original source-created payment recovery. The
same-command saved-prefix preparation/resume and source benefit variants are
separate following implementation slices.
