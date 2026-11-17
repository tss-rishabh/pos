"""Opt-in screening admission around the unchanged private source pipeline.

No installer calls this automatically. It needs the reviewed reservation schema,
the global/all-writer admission contract and the existing private capability keys.
It changes only the explicit screening rejection in an independently qualified
base profile. Membership, benefits and original-tender checks remain delegated.
"""
import ast
import copy
import inspect
import json
import hmac
import re
from contextlib import contextmanager
from contextvars import ContextVar

from protocol import ImportReview, digest, verify_capability
from native import one, rows, json_value

CONTRACT = 'pos-csv-screening-2960-v1'
SCHEMA = 'pos-screening-schema-v1'
WRITERS = 'pos-screening-all-writers-v1'
SKU = '390238'
MAXIMUM = 2
SOURCE = {'apiCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5',
          'helperHash':'a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46',
          'controllerHash':'821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad',
          'modelHash':'d9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5'}
CURRENT_PROFILE = ContextVar('pos_csv_screening_profile', default=None)
COUNT_SQL = '''SELECT STRAIGHT_JOIN COUNT(*) AS cnt
FROM spiderman_screening_orders s FORCE INDEX (idx_user_id)
JOIN orders o FORCE INDEX (PRIMARY) ON o.id=s.order_id
JOIN has_products hp FORCE INDEX (PRIMARY) ON hp.id=s.has_product_id
WHERE s.user_id=:user_id AND hp.prod_id=:sku AND o.order_status NOT IN (0,17)'''


def screened_base_profile(base):
    """Delete exactly the one owned reject, retaining every other base AST node."""
    if not inspect.isfunction(base) or getattr(base, '__closure__', None):
        raise ImportReview('ORDER_IMPORT_SCREENING_BASE_UNQUALIFIED')
    try:
        tree = ast.parse(inspect.getsource(base))
    except Exception:
        raise ImportReview('ORDER_IMPORT_SCREENING_BASE_UNQUALIFIED') from None
    function = next((node for node in tree.body if isinstance(node, ast.FunctionDef)), None)
    if function is None or function.decorator_list:
        raise ImportReview('ORDER_IMPORT_SCREENING_BASE_UNQUALIFIED')
    expected = ast.parse("if any(str(row['prod_id'])=='390238' for row in products):\n raise ImportReview('ORDER_IMPORT_SCREENING_PROFILE_REQUIRED')").body[0]
    matches = [node for node in function.body if ast.dump(node, include_attributes=False) == ast.dump(expected, include_attributes=False)]
    if len(matches) != 1:
        raise ImportReview('ORDER_IMPORT_SCREENING_BASE_UNQUALIFIED')
    function = copy.deepcopy(function)
    function.body = [node for node in function.body if ast.dump(node, include_attributes=False) != ast.dump(expected, include_attributes=False)]
    function.decorator_list = []
    namespace = dict(base.__globals__)
    exec(compile(ast.Module(body=[function], type_ignores=[]), '<qualified-screening-base>', 'exec'), namespace)
    return namespace[function.name]


def checked_state(row, key):
    def identifier(value):
        return isinstance(value, str) and re.fullmatch(r'[1-9][0-9]{0,18}', value) and int(value) <= 9223372036854775807
    def hashed(value):
        return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value)
    try:
        value = json_value(row['data'])
        expected = {'contract','scope','source','customerId','sku','kind','planHash','requestHash','authorityHash','catalogHash',
                    'quantity','lineItemsEnabled','markerRows','sourceCountBefore','pendingBefore','phase','orderId','lines','markers',
                    'sourceReceiptHash','completionHash','rejectionHash','version','createdAt','updatedAt'}
        if (not isinstance(value, dict) or set(value) != expected or value['contract'] != CONTRACT or value['source'] != SOURCE or
            value['sku'] != SKU or value['kind'] not in ('offline','shopify','pos') or not identifier(value['customerId']) or
            set(value['scope']) != {'actorId','operationId','storeId','counterId'} or
            not all(identifier(value['scope'][field]) for field in ('actorId','storeId','counterId')) or
            not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value['scope']['operationId']) or
            row['operation_id'] != value['scope']['operationId'] or row['customer_id'] != value['customerId'] or
            row['sku'] != SKU or row['order_id'] != value['orderId'] or
            not all(hashed(value[field]) for field in ('planHash','requestHash','authorityHash','catalogHash')) or
            not isinstance(row['proof_hash'],str) or not hmac.compare_digest(row['proof_hash'], digest(key, 'screening-state', value)) or
            type(value['lineItemsEnabled']) is not bool or type(value['quantity']) is not int or value['quantity'] not in (1, 2) or
            type(value['markerRows']) is not int or value['markerRows'] != (value['quantity'] if value['lineItemsEnabled'] else 1) or
            type(value['pendingBefore']) is not int or not 0 <= value['pendingBefore'] <= 2000 or
            not isinstance(value['sourceCountBefore'],str) or not re.fullmatch(r'(?:0|[1-9][0-9]{0,19})',value['sourceCountBefore']) or
            value['phase'] not in ('RESERVED', 'BOUND', 'COUNTED', 'REJECTED') or
            not all(type(value[field]) is int and 0 < value[field] <= 9007199254740991 for field in ('version','createdAt','updatedAt')) or
            value['updatedAt'] < value['createdAt'] or
            not all(value[field] is None or hashed(value[field]) for field in ('sourceReceiptHash','completionHash','rejectionHash'))):
            raise ValueError()
        bound = value['phase'] in ('BOUND','COUNTED')
        if (not isinstance(value['lines'],list) or not isinstance(value['markers'],list) or
            bound != (value['orderId'] is not None) or bound and not identifier(value['orderId']) or
            len(value['lines']) != (value['markerRows'] if bound else 0) or len(value['markers']) != (value['markerRows'] if bound else 0) or
            any(set(line) != {'id','quantity'} or not identifier(line['id']) or type(line['quantity']) is not int or line['quantity'] not in (1,2) for line in value['lines']) or
            any(set(marker) != {'id','lineId'} or not identifier(marker['id']) or not identifier(marker['lineId']) for marker in value['markers']) or
            bound and sum(line['quantity'] for line in value['lines']) != value['quantity'] or
            len({line['id'] for line in value['lines']}) != len(value['lines']) or
            len({marker['id'] for marker in value['markers']}) != len(value['markers']) or
            len({marker['lineId'] for marker in value['markers']}) != len(value['markers']) or
            any(marker['lineId'] not in {line['id'] for line in value['lines']} for marker in value['markers']) or
            (value['phase'] == 'COUNTED') != (value['completionHash'] is not None) or
            value['phase'] == 'COUNTED' and value['sourceReceiptHash'] is None or
            (value['phase'] == 'REJECTED') != (value['rejectionHash'] is not None) or
            not bound and value['sourceReceiptHash'] is not None):
            raise ValueError()
        return value
    except Exception:
        raise ImportReview('ORDER_IMPORT_SCREENING_PROOF_INVALID') from None


def write_state(session, key, value, now):
    value = {**value, 'version': value['version'] + 1, 'updatedAt': now}
    session.execute('UPDATE pos_rewrite_import_screening_reservations SET order_id=:order,data=:data,proof_hash=:hash WHERE operation_id=:id',
                    {'order': value['orderId'], 'data': json.dumps(value, ensure_ascii=False, separators=(',', ':')),
                     'hash': digest(key, 'screening-state', value), 'id': value['scope']['operationId']})
    return value


def native_projection(session, value, order_id):
    order = one(session, 'SELECT user_id,order_status FROM orders WHERE id=:id FOR SHARE', {'id': order_id})
    store = one(session, 'SELECT store_id,counter_id FROM order_stores WHERE order_id=:id', {'id': order_id})
    lines = rows(session, 'SELECT id,qty,sub_prod_id FROM has_products WHERE order_id=:id AND prod_id=:sku ORDER BY id', {'id': order_id, 'sku': SKU}, 4)
    markers = rows(session, 'SELECT id,order_id,has_product_id,user_id FROM spiderman_screening_orders FORCE INDEX (idx_order_id) WHERE order_id=:id ORDER BY id', {'id': order_id}, 4)
    if (str(order['user_id']) != value['customerId'] or str(store['store_id']) != value['scope']['storeId'] or
        str(store['counter_id']) != value['scope']['counterId'] or len(lines) != value['markerRows'] or
        len(markers) != value['markerRows'] or sum(row['qty'] for row in lines) != value['quantity'] or
        any(row['sub_prod_id'] != 0 or row['qty'] not in (1, 2) for row in lines) or
        value['lineItemsEnabled'] and any(row['qty'] != 1 for row in lines) or
        len({row['has_product_id'] for row in markers}) != value['markerRows'] or
        any(str(row['user_id']) != value['customerId'] or row['has_product_id'] not in {line['id'] for line in lines} for row in markers)):
        raise ImportReview('ORDER_IMPORT_SCREENING_STRUCTURE_CHANGED')
    projection = {'lines': [{'id': str(row['id']), 'quantity': row['qty']} for row in lines],
                  'markers': [{'id': str(row['id']), 'lineId': str(row['has_product_id'])} for row in markers]}
    if value['lines'] and (projection['lines'] != value['lines'] or projection['markers'] != value['markers']):
        raise ImportReview('ORDER_IMPORT_SCREENING_STRUCTURE_CHANGED')
    return projection, order['order_status'] is not None and order['order_status'] not in (0, 17)


def admission(session, cap, plan, key, line_items, snapshot=None):
    # Only the Receiver-owned current RC prelude can issue this opaque witness.
    # Missing/primed/reused scopes are not converted into a zero bought-count.
    try:
        from screening_transaction import current
    except ImportError:
        raise ImportReview('ORDER_IMPORT_SCREENING_TRANSACTION_REQUIRED') from None
    current(session, cap)
    # Establish the global customer lock before acquiring reservation/Order rows.
    one(session, 'SELECT id FROM users WHERE id=:id FOR UPDATE', {'id': cap['authority']['customerId']})
    value = checked_state(one(session, 'SELECT * FROM pos_rewrite_import_screening_reservations WHERE operation_id=:id FOR UPDATE', {'id': cap['operationId']}), key)
    quantity = sum(line['quantity'] for line in plan['lines'] if line['productId'] == SKU)
    if (value['scope'] != cap['scope'] or value['requestHash'] != cap['requestHash'] or
        value['planHash'] != cap['planHash'] or value['customerId'] != cap['authority']['customerId'] or
        value['authorityHash'] != digest(key, 'screening-authority', cap['authority']) or
        value['kind'] != plan['kind'] or value['quantity'] != quantity or value['lineItemsEnabled'] != line_items or
        value['phase'] != 'RESERVED' or value['orderId'] is not None):
        raise ImportReview('ORDER_IMPORT_SCREENING_REPLAY_REQUIRED')
    from screening_counter import read_current
    snapshot=read_current(session,value['customerId']) if snapshot is None else snapshot
    snapshot.guard()
    if snapshot.customer!=value['customerId']:raise ImportReview('ORDER_IMPORT_SCREENING_SCOPE_CHANGED')
    bought=snapshot.count
    all_rows = rows(session, 'SELECT * FROM pos_rewrite_import_screening_reservations FORCE INDEX (ix_import_screening_customer) WHERE customer_id=:id AND sku=:sku ORDER BY operation_id', {'id': value['customerId'], 'sku': SKU}, 1002)
    if len(all_rows) > 1000:
        raise ImportReview('ORDER_IMPORT_SCREENING_RECONCILIATION_REQUIRED')
    pending = 0
    for found in all_rows:
        other = checked_state(found, key)
        if other['scope']['operationId'] == cap['operationId']:
            continue
        if other['phase'] == 'RESERVED':
            pending += other['markerRows']
        elif other['phase'] == 'BOUND' and not native_projection(session, other, other['orderId'])[1]:
            pending += other['markerRows']
    if bought + pending + quantity > MAXIMUM:
        raise ImportReview('ORDER_IMPORT_SCREENING_LIMIT')
    return value


class ScreeningSourceRuntime:
    """Wrap SourceRuntime only after explicit schema/all-writer qualification."""
    def __init__(self, source, auth_key, proof_key, clock, contracts):
        if contracts != {'profile': CONTRACT, 'schema': SCHEMA, 'writers': WRITERS}:
            raise ImportReview('ORDER_IMPORT_SCREENING_UNQUALIFIED')
        # Validate both private keys without printing or retaining them in receipts.
        digest(auth_key, 'screening-ready', None)
        digest(proof_key, 'screening-ready', None)
        self.source, self.auth_key, self.proof_key, self.clock = source, auth_key, proof_key, clock
        namespace = source.order_pipeline.__func__.__globals__
        current = namespace.get('assert_plain_profile')
        if current is None:
            raise ImportReview('ORDER_IMPORT_SCREENING_BASE_UNQUALIFIED')
        original = getattr(current, '_screening_original', current)
        self.base = screened_base_profile(original)
        if current is original:
            def qualified(*args, **kwargs):
                selected = CURRENT_PROFILE.get()
                return (selected or original)(*args, **kwargs)
            qualified._screening_original = original
            namespace['assert_plain_profile'] = qualified

    def __getattr__(self, name):
        return getattr(self.source, name)

    @contextmanager
    def preparation_scope(self, session, user, plan, capability):
        if not any(line['productId'] == SKU for line in plan['lines']):
            yield
            return
        from screening_preparation import capture
        with capture(self,session,user,plan,capability):yield

    def preparation_pipeline(self, session, user, plan, capability):
        if not any(line['productId'] == SKU for line in plan['lines']):
            return self.source.preparation_pipeline(session,user,plan,capability)
        from screening_preparation import replay
        with replay(self,session,user,plan,capability) as supplied:
            return self.source.preparation_pipeline(supplied,user,plan,capability)

    def order_pipeline(self, session, user, plan, capability):
        if not any(line['productId'] == SKU for line in plan['lines']):
            return self.source.order_pipeline(session, user, plan, capability)
        cap = verify_capability(self.auth_key, capability, capability['operationId'], 'order', plan, self.clock())
        if str(user['user_id']) != cap['authority']['customerId']:
            raise ImportReview('ORDER_IMPORT_SCREENING_SCOPE_CHANGED')
        from screening_counter import read_current,writer_entry,ReplaySession,CounterReadRefused
        snapshot=read_current(session,cap['authority']['customerId'])
        value = admission(session, cap, plan, self.proof_key, bool(self.source.settings.IS_LINE_ITEM_ENABLED),snapshot)
        token = CURRENT_PROFILE.set(self.base)
        try:
            with writer_entry(session,snapshot.customer):
                supplied=ReplaySession(session,snapshot)
                order_id, cart = self.source.order_pipeline(supplied, user, plan, cap)
                projection, counted = native_projection(session, value, order_id)
                write_state(session, self.proof_key, {**value, 'phase': 'BOUND', 'orderId': str(order_id), **projection}, self.clock())
                if supplied.reads==0:raise ImportReview('ORDER_IMPORT_SCREENING_COUNTER_INVALID')
                snapshot.validate(value['markerRows'] if counted else 0)
                return order_id, cart
        except CounterReadRefused:
            raise ImportReview('ORDER_IMPORT_SCREENING_COUNTER_INVALID') from None
        finally:
            CURRENT_PROFILE.reset(token)
