"""Generate reviewable compatibility patches against pinned, untouched source.

Only compatibility/patches is written. The sibling repositories are read-only.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parents[3]
TARGETS = {
    'api-v2': (WORKSPACE / 'backend-tss-api_v2', '2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'),
    'payments': (WORKSPACE / 'security-scans-20261113/backend-tss-domestic_payments_api', '434f3e438d1cb48c64e5723222c6efda506db571'),
}


def original(target, filename):
    repository, commit = TARGETS[target]
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository, text=True).strip()
    if actual != commit:
        raise RuntimeError(f'{target} source is not at its reviewed commit')
    return subprocess.check_output(['git', 'show', f'{commit}:{filename}'], cwd=repository, text=True)


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError('Reviewed patch context changed')
    return source.replace(old, new, 1)


def diff(filename, before, after):
    return ''.join(difflib.unified_diff((before or '').splitlines(True), after.splitlines(True), fromfile='a/'+filename if before is not None else '/dev/null', tofile='b/'+filename))


def build(write=False):
    original_api = original('api-v2', 'controllers/ExchangeOrderController.py')
    api = replace_once(original_api, 'class PosExchangeOrder():', '''def _pos_exchange_stock_proof(session, ctx, child_order_id):
    """Writer proof committed with stock and payment; never infer it from HTTP."""
    return fetchOne(session, """
        SELECT p.order_id FROM pos_rewrite_exchange_stock_confirmations p
        JOIN orders o ON o.id=p.order_id
        JOIN has_products h ON h.id=p.has_product_id AND h.order_id=o.id
        JOIN has_products ph ON ph.id=p.parent_has_product_id AND ph.order_id=p.parent_order_id
        JOIN orders parent ON parent.id=p.parent_order_id
        WHERE p.order_id=:child_id AND p.parent_order_id=:order_id
          AND p.parent_has_product_id=:has_product_id AND p.store_id=:store_id
          AND p.counter_id=:counter_id AND p.product_id=:exchange_prod_id
          AND h.prod_id=p.product_id AND h.qty=p.quantity AND ph.qty=p.quantity
          AND h.status IN ('PLACED','DELIVERED')
          AND o.parent_order_id=p.parent_order_id AND o.user_id=parent.user_id
          AND o.payment_method=3 AND o.pay_amt=0 AND o.payment_status=4
          AND o.order_status IN (1,3) AND p.contract_version='pos-exchange-stock-v1'
    """, {**ctx, 'child_id': child_order_id}, to_dict=True)


class PosExchangeOrder():''')
    api = replace_once(api, '''            logger.warning(f"[POS Exchange] order_id={order_id} has_prod_id={has_product_id} lock acquire failed, proceeding without lock: {e}")
            lock_acquired = True''', '''            logger.warning("[POS Exchange] concurrency service unavailable")
            raise falcon.HTTPServiceUnavailable("Exchange processing is temporarily unavailable.")''')
    api = replace_once(api, '"SELECT eol.order_id, os.id AS order_store_id, chp.prod_id AS child_prod_id "', '"SELECT eol.order_id, os.id AS order_store_id, os.store_id AS child_store_id, os.counter_id AS child_counter_id, chp.prod_id AS child_prod_id "')
    api = replace_once(api, '''            # Half-finished counter exchange — hand it back for pos-web to complete.
            result = {"status": "SUCCESS", "new_order_id": live_child_row['order_id']}''', '''            if int(live_child_row.get('child_store_id') or 0) != store_id or int(live_child_row.get('child_counter_id') or 0) != counter_id:
                raise falcon.HTTPBadRequest("A replacement already exists at a different store or counter.")
            if not _pos_exchange_stock_proof(session, ctx, live_child_row['order_id']):
                raise falcon.HTTPServiceUnavailable("Replacement confirmation requires review.")
            # Reuse only an exactly scoped child with committed stock/payment proof.
            result = {"status": "SUCCESS", "new_order_id": live_child_row['order_id']}''')
    api = replace_once(api, '''        # 2. Live stock re-check — second guard against a race, moments after the picker's read.''', '''        # A prior 4xx/timeout can leave a committed child before payment or even
        # before exchange_order_log. Never create another child over that state.
        incomplete_child = fetchOne(session,
            "SELECT e.order_id FROM exchange_order_log e JOIN orders o ON o.id=e.order_id "
            "WHERE e.parent_order_id=:order_id AND e.parent_has_product_id=:has_product_id "
            "AND (o.order_status IS NULL OR o.order_status NOT IN (4,22)) LIMIT 1",
            {'order_id': order_id, 'has_product_id': has_product_id}, to_dict=True)
        orphan_child = fetchOne(session,
            "SELECT o.id FROM orders o LEFT JOIN exchange_order_log e ON e.order_id=o.id "
            "WHERE o.parent_order_id=:order_id AND e.id IS NULL "
            "AND (o.order_status IS NULL OR o.order_status NOT IN (4,22)) LIMIT 1",
            {'order_id': order_id}, to_dict=True)
        if incomplete_child or orphan_child:
            raise falcon.HTTPServiceUnavailable("An incomplete replacement requires reconciliation.")

        # 2. Live stock re-check — second guard against a race, moments after the picker's read.''')
    # Last occurrence is the POS branch; earlier online/reship callers are unchanged.
    marker='''        # 9. Suppress online-only side effects — no FB purchase event, no customer-support'''
    api = replace_once(api, marker, '''        if not _pos_exchange_stock_proof(session, ctx, order.id):
            raise falcon.HTTPServiceUnavailable("Replacement confirmation requires review.")

'''+marker)
    original_go = original('payments', 'juspay/Order.go')
    go = replace_once(original_go, '\t// Express-Parent-Order\n', '\t// POS exchanges must commit stock/payment before returning the source success body.\n\tif tryConfirmPOSExchange(c, &o) {\n\t\treturn\n\t}\n\n\t// Express-Parent-Order\n')
    api_patch=diff('controllers/ExchangeOrderController.py', original_api, api)
    go_patch=diff('juspay/Order.go', original_go, go)
    for target, path in [('internal/posstock/stock.go',ROOT/'go/internal/posstock/stock.go'),('internal/posstock/stock_test.go',ROOT/'go/internal/posstock/stock_test.go'),('juspay/pos_exchange_http.go',ROOT/'payload/juspay/pos_exchange_http.go')]:
        go_patch+=diff(target,None,path.read_text())
    manifest={'sources':{key:{'commit':value[1],'path':str(value[0])} for key,value in TARGETS.items()},'contract':'pos-exchange-stock-v1','patches':{name:hashlib.sha256(value.encode()).hexdigest() for name,value in [('api-v2-pos-exchange.patch',api_patch),('payments-pos-exchange.patch',go_patch)]}}
    artifacts = {ROOT/'patches/api-v2-pos-exchange.patch':api_patch,ROOT/'patches/payments-pos-exchange.patch':go_patch,ROOT/'manifest.json':json.dumps(manifest,indent=2)+'\n'}
    for path, content in artifacts.items():
        if write:
            path.write_text(content)
        elif not path.exists() or path.read_text()!=content:
            raise RuntimeError('Saved exchange patch differs from its reviewed inputs')
    return manifest


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true')
    print(json.dumps(build(write=parser.parse_args().write)['patches']))
