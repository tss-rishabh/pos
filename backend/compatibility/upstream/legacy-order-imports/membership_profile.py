"""Private CSV membership composition of the pinned ordinary producer.

No source repository is modified. Shopify only stages; method14 uses the
existing Go activation and cancellation provenance. Unknown historical free
membership eligibility is never substituted with an empty purchase history.
"""
import ast
import copy
from datetime import datetime
import time
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import hmac
import json
import os
from pathlib import Path
import sys
from types import ModuleType

from sqlalchemy import text
from protocol import ImportReview, SOURCE_COMMIT, digest
from transaction import VIOLATION

HERE = Path(__file__).resolve().parent
PRODUCER = HERE.parent / 'pending-cancellation'
CONTRACT = 'pos-legacy-import-membership-v1'
FRESH_READER = 'pos-membership-fresh-reader-v1'
CONTEXT = ContextVar('pos_import_membership_profile', default=None)
MUTATORS={
    'set_exclusive_user','set_exclusive_expiry','set_exclusive_upgrade_user','set_exclusive_upgrade_expiry',
    'set_exclusive_user_check','set_exclusive_expiry_check','set_exclusive_upgrade_user_check','set_exclusive_upgrade_expiry_check',
}
PINS = {
    'controllers/OrderController.py':'821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad',
    'controllers/user/userDal.py': 'ad0135cb60aa2c8ffd8d5aa5bc6d8b343efb97227fd3394a1ff31989054141a8',
    'controllers/cart/Cart.py': '1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3',
}


def refuse(code='ORDER_IMPORT_MEMBERSHIP_PROFILE_REQUIRED'):
    # Source Cart catches broad exceptions. A refusal must still abort its
    # private writer transaction, never become source-success by swallowing it.
    VIOLATION.set(True)
    raise ImportReview(code) from None


def selected():
    value = os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_CONTRACT', '')
    if not value:
        return False
    if value != CONTRACT or os.environ.get('POS_MEMBERSHIP_FRESH_READER_CONTRACT') != FRESH_READER:
        refuse()
    return True


def _source(root, path):
    value = (Path(root) / path).read_bytes()
    expected = PINS[path]
    if not expected or hashlib.sha256(value).hexdigest() != expected:
        refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    return value.decode()


def producer():
    # Each private composition has its own globals. Never monkey-patch the
    # ordinary producer used by another worker/thread or its existing tests.
    sys.path.insert(0, str(PRODUCER))
    module = ModuleType('pos_private_import_membership_producer')
    filename = PRODUCER / 'membership_provenance.py'
    tree = ast.parse(filename.read_text())
    stages = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'membership_order_stage']
    if len(stages) != 1:
        refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    old = 'order["payment_method"] not in (3, 14)'
    replacements = {
        old: 'order["payment_method"] not in (3, 14, 15)',
        'order["payment_status"] != 0': 'order["payment_status"] != (1 if order["payment_method"] == 15 else 0)',
        'order["order_status"] != 0': 'order["order_status"] != (1 if order["payment_method"] == 15 else 0)',
    }
    body = ast.unparse(stages[0])
    # Compare AST, not quoting/formatting of the reviewed original helper.
    for original, changed in replacements.items():
        original = ast.unparse(ast.parse(original, mode='eval').body)
        changed = ast.unparse(ast.parse(changed, mode='eval').body)
        if body.count(original) != 1:
            refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
        body = body.replace(original, changed, 1)
    replacement = ast.parse(body).body[0]
    tree.body[tree.body.index(stages[0])] = replacement
    exec(compile(ast.fix_missing_locations(tree), str(filename), 'exec'), module.__dict__)
    module._publish = journal_invalidations
    return module


def journal_invalidations(proxy):
    state = CONTEXT.get()
    if state is None:
        refuse('ORDER_IMPORT_MEMBERSHIP_SCOPE_REQUIRED')
    for _callback, args, kwargs in proxy.invalidations:
        if (kwargs or len(args) != 6 or args[1] is not None or args[2] != 'exclusive_user'
                or str(args[4]) != str(state['user']['user_id']) or args[5] != state['user']['email']):
            refuse('ORDER_IMPORT_MEMBERSHIP_CACHE_UNQUALIFIED')
    state['invalidations'] += len(proxy.invalidations)


def compile_writers(root, namespace, adapter):
    parsed = ast.parse(_source(root, 'controllers/user/userDal.py'))
    class Defer(ast.NodeTransformer):
        def visit_Call(self, node):
            node = self.generic_visit(node)
            if isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'cache' and node.func.attr == 'region_invalidate':
                return ast.copy_location(ast.Call(func=ast.Name(id='defer_membership_invalidation', ctx=ast.Load()),
                    args=[ast.Name(id='session', ctx=ast.Load()), node.func, *node.args], keywords=node.keywords), node)
            return node
    namespace.update(membership_user_lock=adapter.membership_user_lock,
                     defer_membership_invalidation=adapter.defer_membership_invalidation)
    found = set()
    for node in parsed.body:
        if isinstance(node, ast.FunctionDef) and node.name in MUTATORS:
            node = Defer().visit(copy.deepcopy(node))
            node.decorator_list = [ast.Name(id='membership_user_lock', ctx=ast.Load())]
            exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<pinned-csv-membership-writer>', 'exec'), namespace)
            found.add(node.name)
    if found != MUTATORS:
        refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    return namespace


def membership_order_tree(root):
    # Apply the same reviewed ordinary producer seam directly to immutable
    # artifact bytes. Runtime must not execute Git or require a developer repo.
    tree=ast.parse(_source(root,'controllers/OrderController.py'))
    target=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='PosOrder')
    method=next(node for node in target.body if isinstance(node,ast.FunctionDef) and node.name=='on_post')
    condition=ast.unparse(ast.parse("exclusive_user and not exclusive_user.get('store_exclusive',0)",mode='eval').body)
    candidates=[(index,node) for index,node in enumerate(method.body) if isinstance(node,ast.If) and ast.unparse(node.test)==condition]
    if len(candidates)!=1:
        refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    index,original=candidates[0]
    class StageSession(ast.NodeTransformer):
        def __init__(self):self.changed=[]
        def visit_Call(self,node):
            node=self.generic_visit(node)
            if isinstance(node.func,ast.Name) and node.func.id in ('set_exclusive_user','set_exclusive_upgrade_user'):
                if not node.args or not isinstance(node.args[0],ast.Name) or node.args[0].id!='session':
                    refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
                node.args[0]=ast.Attribute(value=ast.Name(id='member_stage',ctx=ast.Load()),attr='session',ctx=ast.Load())
                self.changed.append(node.func.id)
            return node
    transform=StageSession();block=transform.visit(copy.deepcopy(original))
    if sorted(transform.changed)!=['set_exclusive_upgrade_user','set_exclusive_user']:
        refuse('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    wrapped=ast.With(items=[ast.withitem(context_expr=ast.Call(func=ast.Name(id='membership_order_stage',ctx=ast.Load()),
        args=[ast.Name(id='session',ctx=ast.Load()),ast.Attribute(value=ast.Name(id='order',ctx=ast.Load()),attr='id',ctx=ast.Load()),
              ast.Name(id='user',ctx=ast.Load()),ast.Name(id='settings',ctx=ast.Load())],keywords=[]),
        optional_vars=ast.Name(id='member_stage',ctx=ast.Store()))],
        body=[ast.If(test=ast.Attribute(value=ast.Name(id='member_stage',ctx=ast.Load()),attr='apply',ctx=ast.Load()),body=[block],orelse=[])])
    method.body[index]=ast.copy_location(wrapped,original)
    for node in target.body:
        if isinstance(node,ast.FunctionDef):node.decorator_list=[]
    return ast.fix_missing_locations(target)


def compile_order(root, namespace, adapter):
    target=membership_order_tree(root)
    namespace['membership_order_stage']=adapter.membership_order_stage
    exec(compile(ast.Module(body=[target],type_ignores=[]),'<pinned-csv-membership-PosOrder>','exec'),namespace)
    return namespace['PosOrder']()


def compile_free_membership(root, namespace):
    tree = ast.parse(_source(root, 'controllers/cart/Cart.py'))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'AddFreeMembership')
    scope = dict(namespace)
    exec(compile(ast.Module(body=[original], type_ignores=[]), '<pinned-AddFreeMembership>', 'exec'), scope)
    source = scope['AddFreeMembership']
    source_clock = namespace.get('datetime',datetime)
    history_clock = ContextVar('pos_import_membership_history_clock',default=None)
    class FrozenSourceClock:
        @staticmethod
        def now():
            return history_clock.get() or source_clock.now()
    scope['datetime']=FrozenSourceClock
    class QualifiedFreeMembership(source):
        def check_criteria(self):
            state = CONTEXT.get()
            if state is None:
                refuse('ORDER_IMPORT_MEMBERSHIP_SCOPE_REQUIRED')
            if self.cart_value > 2000:
                # Execute the exact original short circuit: no order-history SQL.
                state['eligibility'] = 'source-cart-over-2000'
                return super().check_criteria()
            if self.number_of_items == 0:
                # Both original branches remove any free line when there are no
                # ordinary items. This avoids reading irrelevant old history.
                state['eligibility'] = 'no-ordinary-items'
                return False
            reader=state.get('historyReader')
            if reader is None:
                refuse('ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED')
            from membership_history import request,validate,HistorySession
            point=source_clock.now()
            query=request(state,point)
            try:
                supplied=reader.read(query)
            except Exception:
                refuse('ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED')
            facts=validate(supplied,query,os.environ.get('POS_LEGACY_IMPORT_MEMBERSHIP_HISTORY_KEY',''),
                           {str(value) for value in scope['MEMBERSHIP_PROD_ID']},int(time.time()*1000))
            state['historyEvidence']={'generationId':facts['generationId'],'fetchedAt':facts['fetchedAt'],
                                      'asOf':query['asOf'],'cutoff':query['cutoff'],
                                      'proofHash':facts['signature']}
            previous=self.session
            self.session=HistorySession(previous,facts)
            token=history_clock.set(point)
            try:
                result=super().check_criteria()
                state['eligibility']='source-qualified-history'
                return result
            finally:
                history_clock.reset(token)
                self.session=previous
    return QualifiedFreeMembership


class MembershipProfile:
    def __init__(self, root, settings, history_reader=None):
        self.root, self.settings, self.adapter = Path(root), settings, producer()
        self.history_reader=history_reader
        self.adapter.config(settings)

    @contextmanager
    def scope(self, session, user, plan, capability):
        if CONTEXT.get() is not None or not selected():
            refuse('ORDER_IMPORT_MEMBERSHIP_SCOPE_REQUIRED')
        if user.get('email'):
            customer, _ = self.adapter.lock_customer(session, user['user_id'])
            before = self.adapter.current(session, customer['email'])
            active = any(row['attribute'] == 'EXCLUSIVE_MEMBER' and row['active'] == 1 for row in before)
            if customer['email'] != user['email'] or bool(user.get('is_exclusive')) != active:
                refuse('ORDER_IMPORT_MEMBERSHIP_AUTHORITY_CHANGED')
        else:
            # Enabling the optional profile must not invent an email or disable
            # an otherwise plain anonymous POS import. Any actual enrollment
            # still requires the bound nonempty native identity before writes.
            customer=session_one(session,'SELECT id,email,status,is_block,is_disabled FROM users WHERE id=:id FOR UPDATE',{'id':user['user_id']})
            if (customer['email']!=user.get('email') or customer['status']!=1 or
                    customer['is_block'] not in (None,0) or customer['is_disabled'] not in (None,0)
                    or bool(user.get('is_exclusive'))):
                refuse('ORDER_IMPORT_MEMBERSHIP_AUTHORITY_CHANGED')
            before=[]
        state = {'profile': self, 'session': session, 'user': user, 'plan': plan,
                 'capability': capability, 'before': before, 'invalidations': 0,
                 'eligibility': 'not-added', 'extras': [], 'kind': None, 'historyReader':self.history_reader, 'historyEvidence':None}
        token = CONTEXT.set(state)
        try:
            yield state
        finally:
            CONTEXT.reset(token)

    def admit(self, cart, types, plan):
        state = CONTEXT.get()
        if not state or state['profile'] is not self or state['plan'] is not plan:
            refuse('ORDER_IMPORT_MEMBERSHIP_SCOPE_REQUIRED')
        products = cart.get(types.PRODUCTS)
        new = {str(key) for key in self.settings.EXCLUSIVE_PRODUCT}
        upgrade = {str(key) for key in self.settings.EXCLUSIVE_UPGRADE_PRODUCT}
        members = [row for row in products if str(row['prod_id']) in new | upgrade]
        if not members:
            return []
        if len(members) != 1 or type(members[0]['quantity']) is not int or members[0]['quantity'] != 1:
            refuse('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
        if not state['user'].get('email'):
            refuse('ORDER_IMPORT_MEMBERSHIP_CUSTOMER_REQUIRED')
        row = members[0]
        sku = str(row['prod_id'])
        planned = {line['productId']: line for line in plan['lines']}
        active = bool(state['user']['is_exclusive'])
        if sku in upgrade:
            if not active or sku not in planned:
                refuse('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
            state['kind'] = 'upgrade'
        elif sku in planned:
            if active:
                refuse('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
            state['kind'] = 'new'
        else:
            free = str(self.settings.FREE_EXCLUSIVE_PRODUCT)
            if (active or sku != free or state['eligibility'] not in ('source-cart-over-2000','source-qualified-history')
                    or float(row.get('spl_price') or row.get('price') or 0) != 0
                    or any(key in new | upgrade for key in planned)):
                refuse('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
            state['kind'] = 'auto-free'
            state['extras'] = [{'productId': sku, 'quantity': 1, 'unitPrice': '0.00'}]
            stock = session_one(state['session'], 'SELECT stock,is_avail,is_del FROM product_store WHERE store_id=:store AND product_id=:id FOR UPDATE',
                                {'store': state['capability']['scope']['storeId'], 'id': sku})
            if stock['stock'] < 1 or stock['is_avail'] != 1 or stock['is_del'] != 0:
                refuse('ORDER_IMPORT_STOCK_SHORTAGE')
        return state['extras']

    def capture(self, session, order_id, cart, state):
        if not state['kind']:
            if state['invalidations']:
                refuse('ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID')
            return None
        raw = session_one(session, 'SELECT * FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=:id FOR UPDATE', {'id': order_id})
        proof = self.adapter._decode(raw)
        key, _ = self.adapter.config(self.settings)
        current = self.adapter.current(session, state['user']['email'])
        revision = session_one(session, 'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR UPDATE', {'id': state['user']['user_id']})['revision']
        header = session_one(session, 'SELECT '+self.adapter.HEADER_SQL+' AS value FROM orders WHERE id=:id FOR UPDATE', {'id': order_id})['value']
        if (proof['contract'] != self.adapter.STAGED_CONTRACT or proof['before'] != state['before']
                or proof['confirmed'] != current or proof['revision'] != str(revision)
                or proof['headerHash'] != header or proof['customerId'] != str(state['user']['user_id'])
                or not hmac.compare_digest(proof['proofHash'], self.adapter.proof_hash(proof, key))):
            refuse('ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID')
        # Internal ephemeral evidence; never client-supplied and never persisted
        # into the source cart. Receiver publishes it in the same order TX.
        cart.pos_import_membership = {'kind': state['kind'], 'extras': state['extras'],
            'eligibility': state['eligibility'], 'provenance': proof,
            'invalidations': state['invalidations'], 'historyEvidence':state.get('historyEvidence')}
        return cart.pos_import_membership


def session_one(session, statement, parameters):
    values = session.execute(text(statement), parameters).mappings().fetchmany(2)
    if len(values) != 1:
        refuse('ORDER_IMPORT_MEMBERSHIP_PROOF_INVALID')
    return dict(values[0])


def additional_lines(cart):
    value = getattr(cart, 'pos_import_membership', None)
    return [] if value is None else value['extras']


def receipt(cart, cap, plan, order_id, header, lines, line_hash):
    value = getattr(cart, 'pos_import_membership', None)
    if value is None:
        return None
    member_ids = set(json.loads(os.environ['POS_MEMBERSHIP_PRODUCT_IDS']))
    members = [line for line in lines if line['productId'] in member_ids]
    if not members or sum(line['quantity'] for line in members) != 1:
        refuse('ORDER_IMPORT_MEMBERSHIP_LINE_REVIEW')
    return {'contract': CONTRACT, 'operationId': cap['operationId'], 'requestHash': cap['requestHash'],
            'planHash': cap['planHash'], 'namespace': cap['namespace'], 'orderId': order_id,
            'actorId':cap['scope']['actorId'],
            'authorityHash':digest(os.environ['POS_LEGACY_IMPORT_PROOF_KEY'],'membership-authority',cap['authority']),
            'customerId': cap['authority']['customerId'], 'storeId': cap['scope']['storeId'],
            'counterId': cap['scope']['counterId'], 'method': 14 if plan['kind'] == 'offline' else 15,
            'sourceCommit': SOURCE_COMMIT, 'kind': value['kind'], 'eligibility': value['eligibility'],
            'headerHash': header['native_hash'], 'lineHash': line_hash, 'memberLines': members,
            'additionalLines': [line for line in members if line['productId'] in {item['productId'] for item in value['extras']}],
            'provenance': value['provenance'], 'cacheInvalidations': value['invalidations'], 'historyEvidence':value.get('historyEvidence')}
