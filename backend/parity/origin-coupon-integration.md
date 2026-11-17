# Shared origin coupon wiring

Code-first integration checkpoint; validation is deferred. Selectors stay off.
The new coupon modules/migration and independent provider are owned separately
in `origin-coupons.md`.

OriginBootstrap installs the real alias router/factory using the same generic
source history key (`POS_LEGACY_IMPORT_PROOF_KEY`) and original constants,
settings and Cart.py execution clock. Source zone remains the reviewed configured
zone and must describe that genuine naive source wall clock; it is not inferred
from a historical row or a browser timestamp. Invalid clock/configuration is
explicitly unavailable rather than a zero coupon/history result.

Command preparation reads the current owned cart quantity/hash and raw meta
before hydrating any source Product/Meta initializer. Qualified coupon and
customer-count documents are fetched outside SQL, then native authority,
original command and exact cart are rechecked before retained preparation save.
Frame enters the coupon scope before private_session and CartFactory, and exits
it after private_session, so owner SET/CLEAR cannot bypass the SQL guard. A
separate short native pass acquires the actual customer for Redis observation;
the pass closes before Redis, and final source authority is freshly checked.
An immutable already-created order does not need a current coupon snapshot.

The actual original source functions produce the coupon/refund/native mutation.
Capture uses the same timestamp as creation and assets, and optional couponHash
is omitted when no coupon remains. Without the producer an actual applied coupon
is refused before commit. Go confirm/definite-decline companion receipts are
verified by Node/Python quota readers and by original cash finalization; a
missing consumption/reversal proof is never treated as released credit.

CSK prepared-prefix execution uses the same raw saved meta and outside-SQL
provider boundary. Its earlier product-add prefix and ordinary Cart previews
still require the separate genuine preview-context/member/coupon coordination;
this checkpoint does not claim those paths complete. No raw historical SQL is
whitelisted as a substitute.

Root may compose `Bootstrap.coupon_control_application(fallback,emit_stream)`
after original route registration. It preserves the private control endpoint's
independent key and falls back to the existing application for all other paths.

Original string SQL and dict(row) calling conventions now use the existing
LegacyResult codec on the exact native session for cart hashing, pure CSK prefix
and postcommit cart persistence. This changes transport compatibility only;
no financial math, SQL mode or source tables are substituted.
