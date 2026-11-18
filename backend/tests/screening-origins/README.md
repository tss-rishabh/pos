# Genuine source previews and final membership qualification

`source.test.ts` runs the closed current-coupon WSGI/disabled worker checks. With
`ORIGIN_PREVIEW_MYSQL_TEST_URL` selected it also runs `test_preview.py` and
`test_coupon_preview.py`. The URL
must name `pos_rewrite_origin_preview_test` on localhost; each case creates and
drops a separate random schema. It cannot target an application database.

Set `POS_LEGACY_IMPORT_SOURCE_ROOT` to the immutable API commit
`2960acbea10c4eaf16b6d99e15ff6e03ef7724c5`. The fixture checks original source
hashes before compiling Cart, middleware, cart persistence/serializer, JWT
verification, original CartController, Order/PosOrder and CSK prefix code. The
owned fixture runner uses the frozen `origin-source-fixtures` dependency group
in a separate temporary environment. It pins Requests 2.34.2 and PyJWT 2.15.1
alongside the existing SQLAlchemy/PyMySQL/cryptography lock. This executes the
original source classes with current fixture dependencies; it does not certify
the dependencies inside an externally deployed original API image. The runner
does not mutate the shared source `.venv` or forward service credentials.

The native cases prove cart hydration waits for genuine current authority,
history providers execute after every SQL connection is released, current
authority/cart/head changes prevent stale replay, and rollback rehearsals
cannot write native state. The final Order/PosOrder guard executes the pinned
`AddFreeMembership.process` on a source Cart clone using the true command's
history document before reservation/admission. Changed products, quantities,
prices or calculated values produce the existing `QUOTE_CHANGED` no-order
closure and preserve the original cart. Source bookkeeping timestamps are
excluded from that comparison. Unchanged eligible carts reach each original
responder's real checkout-validation call.

The coupon cases run the original `MetaInitializer` and pinned coupon helper
bodies on a real source Cart. Existing A hydrates first; an incoming B is
selected lazily at the same preview time. A current-only B needs no history;
a historical B unwinds SQL, receives a signed generated document, and replays
the same preview. A forged document preserves native A and commits no preview
receipt. A missing incoming code takes the original invalid-coupon removal
branch. No old Orders/coupon-log table exists in this fixture.

The CSK test executes the original strict-prepaid/cart prefix and the native
same-command recovery journal, then intentionally stops before the original
Order constructor. It does not prove a paid order, provider charge or Go
confirmation. The deferred-effect test executes the real native invocation
fence and original task body through a fixture broker acknowledgement; it does
not claim acceptance by a deployed broker.

Current catalog/calculation initialization and qualified projection/head ports
are synthetic, explicitly injected fixtures. Signed historical selections are
generated inputs, not live BigQuery reads. These checks establish source
control flow and native ownership/rollback behavior; they do not certify tax
formulas, publication completeness, all-writer deployment, provider/printer
acceptance, or an entire source surface.

Example from `backend/`:

```sh
POS_LEGACY_IMPORT_SOURCE_ROOT=/immutable/api-2960 \
ORIGIN_PREVIEW_MYSQL_TEST_URL=mysql+pymysql://root@127.0.0.1:54566/pos_rewrite_origin_preview_test \
TZ=Asia/Kolkata \
tools/screening-origins/run-fixture.sh -B tests/screening-origins/test_preview.py -v
```
