"""Compose the non-POS origin candidate onto an OWNED payments build tree.

The immutable reference is read only. This is a build implementation, not a
test runner or deployment tool. Root's common composer owns when to invoke it.
"""
from __future__ import annotations

from collections.abc import Callable
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
PAYMENTS_COMMIT = '434f3e438d1cb48c64e5723222c6efda506db571'
CONTRACT = 'pos-screening-origin-payments-v1'


def once(value: str, before: str, after: str) -> str:
    if value.count(before) != 1:
        raise RuntimeError('Origin composition requires its exact source seam')
    return value.replace(before, after, 1)


def format_source_logs(target: Path) -> None:
    """Exact pinned format corrections only; no source control-flow changes."""
    path = target / 'juspay/Customer.go'
    value = path.read_text()
    for old, new in [
        ('utils.Errorf(err, "error parsing amount", err)', 'utils.Errorf(err, "error parsing amount")'),
        ('utils.Errorf(err, "Error in parseUserID in WalletRefresh:", err)', 'utils.Errorf(err, "Error in parseUserID in WalletRefresh:")'),
        ('utils.Errorf(err, "Error parseUserID in method UpdateCustomer:", err)', 'utils.Errorf(err, "Error parseUserID in method UpdateCustomer:")'),
        ('utils.Errorf(err, "Error parseUserID in method CreateCustomer:", err)', 'utils.Errorf(err, "Error parseUserID in method CreateCustomer:")'),
        ('utils.Errorf(nil, "User does not exist in our db, errs", errs)', 'utils.Errorf(nil, "User does not exist in our db, errs: %v", errs)'),
    ]:
        value = once(value, old, new)
    old = 'utils.Errorf(err, "%v")'
    if value.count(old) != 4:
        raise RuntimeError('Pinned customer error format boundary changed')
    value = value.replace(old, 'utils.Errorf(err, "source customer operation failed")')
    path.write_text(value)
    path = target / 'juspay/model.go'
    value = path.read_text()
    for old in [
        'utils.Errorf(nil, fmt.Sprint("user_eav expiry date error: ", err))',
        'utils.Errorf(nil, fmt.Sprint("exclusive upgrade: EXCLUSIVE_EXPIRY not found for email=", user.Email, " res.Error=", res.Error))',
    ]:
        value = once(value, old, 'utils.Errorf(nil, "%s", '+old[len('utils.Errorf(nil, '):-1]+')')
    path.write_text(value)


def _owned_tree(target: Path, reference: Path) -> None:
    if (target == reference or reference in target.parents or target in reference.parents
            or not (target / 'go.mod').is_file()):
        raise RuntimeError('An independent owned payments build tree is required')
    head = subprocess.check_output(['git', '-C', str(reference), 'rev-parse', 'HEAD'], text=True).strip()
    if head != PAYMENTS_COMMIT:
        raise RuntimeError('Pinned original payments reference is required')


def compose_payments(target: Path | str, reference: Path | str,
                     generate: Callable[[list[str]], bytes] | None = None) -> dict[str, object]:
    """Apply AFTER ordinary/exchange/CSV/public/counter composers.

    `generate` runs the standard-library-only AST producer with the supplied
    args. Root may provide its existing network-disabled Go build runner.
    No source repository, cloud provider, schema or deployment is mutated.
    """
    target, reference = Path(target).resolve(), Path(reference).resolve()
    _owned_tree(target, reference)
    model, orders = reference / 'juspay/model.go', reference / 'juspay/Order.go'
    for file in (model, orders):
        committed = subprocess.check_output(['git', '-C', str(reference), 'show',
                                             PAYMENTS_COMMIT + ':' + str(file.relative_to(reference))])
        if file.read_bytes() != committed:
            raise RuntimeError('Pinned original payments bytes were modified')
    model_hash = hashlib.sha256(model.read_bytes()).hexdigest()
    order_hash = hashlib.sha256(orders.read_bytes()).hexdigest()
    arguments = [str(HERE / 'transform_source.go'), '-input', str(model), '-sha256', model_hash,
                 '-orders', str(orders), '-orders-sha256', order_hash]
    if generate is None:
        environment = {**os.environ, 'GOTOOLCHAIN': 'local', 'GOPROXY': 'off', 'GOSUMDB': 'off'}
        def local_generate(args: list[str]) -> bytes:
            return subprocess.check_output([os.environ.get('POS_GO_BINARY', 'go'), 'run', *args],
                                           cwd=target, env=environment)
        generate = local_generate
    generated = generate(arguments)
    if (not isinstance(generated, bytes) or not generated.startswith(b'// Generated from pinned payments ')
            or len(generated) > 1000000):
        raise RuntimeError('The pinned origin allocation producer did not finish')

    copied: dict[str, str] = {}
    for source in sorted((HERE / 'payload').rglob('*')):
        if not source.is_file():
            continue
        relative = source.relative_to(HERE / 'payload')
        destination = target / relative
        if destination.exists():
            raise RuntimeError('An origin payload path is already occupied')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
        copied[str(relative)] = hashlib.sha256(source.read_bytes()).hexdigest()
    allocation = target / 'juspay/origin_source.go'
    allocation.write_bytes(generated)
    copied['juspay/origin_source.go'] = hashlib.sha256(generated).hexdigest()

    path = target / 'juspay/Order.go'
    text = path.read_text()
    text = once(text, '\tCreateCustomer(c)\n\n\t// Getting IP',
                '\tif tryOtherOriginProcessOrder(c,&o,po,"juspay") { return }\n\tCreateCustomer(c)\n\n\t// Getting IP')
    begin = text.index('func GokwikProcessOrder(c *gin.Context) {')
    head, tail = text[:begin], text[begin:]
    tail = once(tail, '\tswitch o.PaymentMethod {',
                '\tif tryOtherOriginProcessOrder(c,&o,po,"gokwik") { return }\n\tswitch o.PaymentMethod {')
    path.write_text(head + tail)

    path = target / 'juspay/model.go'
    text = path.read_text()
    for signature in ['func (o *Order) OrderAndStockConfirmed(Db *gorm.DB, reduceStock ...bool) bool {',
                      'func (o *Order) ExchangeOrderAndStockConfirmed(Db *gorm.DB) bool {']:
        text = once(text, signature, signature + '\n\tif handled,confirmed:=tryOtherOriginInternal(o,Db);handled{return confirmed}')
    path.write_text(text)

    path = target / 'juspay/payment.go'
    text = path.read_text()
    hooks = {
        'func WebhookUpdate(c *gin.Context) {': 'if tryOtherOriginJuspayWebhook(c){return}',
        'func OrderPaymentStatusUpdate(c *gin.Context) {': 'if tryOtherOriginCron(c){return}',
        'func VerifyPayment(c *gin.Context) {': 'if tryOtherOriginReturn(c,false){return}',
        'func VerifyPaymentWWE(c *gin.Context) {': 'if tryOtherOriginReturn(c,true){return}',
        'func GokwikWebhookUpdate(c *gin.Context) {': 'if tryOtherOriginGokwikWebhook(c){return}',
        'func GokwikPaymentUpdate(gkOrder GokwikOrder) GokwikPaymentVerifyResponse {':
            'if handled,result:=tryOtherOriginGokwikUpdate(gkOrder);handled{return result}',
        'func GokwikPaymentVerify(c *gin.Context) {': 'if tryOtherOriginGokwikVerification(c){return}',
        'func GokwikPaymentVerifyCron(c *gin.Context) {': 'if !admitOtherOriginGokwikCron(c){return}',
    }
    for signature, hook in hooks.items():
        text = once(text, signature, signature + '\n\t' + hook)
    path.write_text(text)

    # The old Gokwik cron emits entire native rows before its internal call;
    # suppress those original diagnostic statements too. Do not replace any
    # pricing, provider request, refund, counter or failure expression.
    for relative in ('juspay/Order.go', 'juspay/payment.go'):
        path = target / relative
        private = generate([str(HERE / 'transform_source.go'), '-sanitize', str(path)])
        if not private or len(private) > 2000000:
            raise RuntimeError('Owned origin privacy composition did not finish')
        path.write_bytes(private)

    format_source_logs(target)
    # Calendar DateOnly correction approved separately; original source expiry
    # date and IsExpired predicates remain inclusive and otherwise unchanged.
    expiry_path = target / 'juspay/model.go'
    expiry_source = expiry_path.read_text()
    if expiry_source.count('.Format("2006-02-01")') != 4:
        raise RuntimeError('Pinned wallet expiry date boundary changed')
    expiry_source = expiry_source.replace('.Format("2006-02-01")', '.Format("2006-01-02")')
    # The approved restoration preserves independent cashback. Limit this
    # change to the original Money method; retain both original history writes.
    money_signature = 'func (o *Order) RevertTssMoney(Db *gorm.DB) {'
    points_signature = 'func (o *Order) RevertTssPoints(Db *gorm.DB) {'
    if expiry_source.count(money_signature) != 1 or expiry_source.count(points_signature) != 1:
        raise RuntimeError('Pinned original wallet method boundary changed')
    money_start = expiry_source.index(money_signature)
    money_end = expiry_source.index(points_signature, money_start)
    money_body = once(
        expiry_source[money_start:money_end],
        'Db.Exec("UPDATE users SET cashback = ?, tss_money = ? WHERE id = ? LIMIT 1", finalTSSMoneyToUpdate, finalTSSMoneyToUpdate, o.User)',
        'Db.Exec("UPDATE users SET tss_money=? WHERE id=? LIMIT 1", finalTSSMoneyToUpdate, o.User)',
    )
    if money_body.count('utils.Db.Create(&tm)') != 2:
        raise RuntimeError('Pinned original Money history boundary changed')
    money_body = money_body.replace('utils.Db.Create(&tm)',
                                    'createOriginalFailureMoneyHistory(utils.Db, &tm)')
    points_tail = expiry_source[money_end:]
    voucher_signature = 'func (o *Order) RevertGiftVoucher(Db *gorm.DB) {'
    if points_tail.count(voucher_signature) != 1:
        raise RuntimeError('Pinned original Points history boundary changed')
    points_end = points_tail.index(voucher_signature)
    points_body = points_tail[:points_end]
    if points_body.count('utils.Db.Create(&tp)') != 2:
        raise RuntimeError('Pinned original Points history write count changed')
    points_body = points_body.replace('utils.Db.Create(&tp)',
                                      'createOriginalFailurePointsHistory(utils.Db, &tp)')
    expiry_path.write_text(expiry_source[:money_start] + money_body + points_body + points_tail[points_end:])

    # Existing public/CSV confirmation remains intact. The extra credit is
    # computed under its already-held global customer lock, using only the
    # materialized counter and individually verified current origin commands.
    path = target / 'internal/poscheckout/screening.go'
    text = path.read_text()
    marker = '\tif bought > 2 || pending > 2 || bought+pending > 2 {'
    text = once(text, marker,
                '\toriginPending,originErr:=PendingOriginScreeningCredit(ctx,tx,strconv.FormatInt(p.user,10),os.Getenv("POS_SCREENING_ORIGIN_PROOF_KEY"),"")\n'
                '\tif originErr!=nil{return originErr}\n\tpending+=originPending\n' + marker)
    path.write_text(text)

    path = target / 'main.go'
    text = path.read_text()
    text = once(text, 'v2.POST("/orders", juspay.ProcessOrder)',
                'juspay.RegisterOtherOriginPaymentRoutes(v2)\n\t\tv2.POST("/orders", juspay.ProcessOrder)')
    path.write_text(text)
    manifest: dict[str, object] = {
        'contract': CONTRACT, 'selectedByDefault': False, 'validation': 'pending-final-validation',
        'sourceCommit': PAYMENTS_COMMIT, 'referenceFiles': {'juspay/model.go': model_hash, 'juspay/Order.go': order_hash},
        'copied': copied,
        'composed': {str(file.relative_to(target)): hashlib.sha256(file.read_bytes()).hexdigest()
                     for file in [target / 'juspay/Order.go', target / 'juspay/model.go', target / 'juspay/payment.go', target / 'juspay/Customer.go',
                                  target / 'internal/poscheckout/screening.go', target / 'main.go']},
        'reviewMigrations': ['screening-origins/migration.sql', 'screening-origins/assets-migration.sql',
                             'screening-origins/origin-coupon-migration.sql',
                             'screening-origins/stage-recovery-migration.sql',
                             'screening-origins/history-heads.review.sql',
                             'screening-origins/history-security.review.sql',
                             'screening-origins/transaction-security.review.sql',
                             'screening-origins/history-grants.review.sql',
                             'legacy-order-imports/screening-counter.review.sql',
                             'legacy-order-imports/screening-counter-writers.review.sql',
                             'legacy-order-imports/screening-counter-grants.review.sql',
                             'public-screening-writer/membership-history-writers.review.sql',
                             'legacy-order-imports/benefit-profile/coupon-history-writers.review.sql',
                             'other-writer-origins/go/migration.review.sql',
                             'other-writer-origins/go/coupon-migration.review.sql',
                             'other-writer-origins/go/admission-migration.review.sql',
                             'other-writer-origins/go/provider-migration.review.sql',
                             'other-writer-origins/go/exchange-migration.review.sql',
                             'other-writer-origins/go/stage-recovery-migration.review.sql'],
        'reviewOrdering': [
            'Review only: no automatic DDL, account grants, backfill or cutover is authorized.',
            'Fence all affected writers and drain sessions before installing or changing accounts, fixed functions, grants, controls, or trigger families; qualify actual runtime readers before releasing the fence.',
            'Create control/head tables before dependent grants and triggers. Install both exact readonly audit functions under the isolated locked audit owner; grant only their exact EXECUTE permissions to declared readers and the transaction reader to the locked counter owner.',
            'The combined screening-counter.review.sql contains tables plus all counter writers. Use it OR install the control-table migration plus screening-counter-writers.review.sql; never apply both writer definitions twice.',
            'Install selected membership/coupon families under their distinct locked owners with the exact table rights declared by head_participants.py; review and seed baseline publications separately before allowing new financial work.',
        ],
        'effectsCommand': 'cmd/screening-origin-effects',
    }
    (target / 'other-writer-origins-manifest.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    return manifest
