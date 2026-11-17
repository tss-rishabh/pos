"""Pinned pure screening source, synthetic inputs only; no app/database imports."""
import ast
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'compatibility/upstream/legacy-order-imports'))
from protocol import ImportReview
from screening_profile import SOURCE, checked_state, screened_base_profile
from profiles import assert_plain_profile


def checked(root, path, expected):
    raw = (root / path).read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise RuntimeError('Pinned screening source changed.')
    return ast.parse(raw)


def run(value):
    if value.get('action') == 'state':
        try:
            state = checked_state(value['row'], value['key'])
            return {'phase': state['phase'], 'quantity': state['quantity']}
        except ImportReview as error:
            return {'code': error.code}
    source = Path(value['sourceRoot'])
    helper = checked(source, 'libs/OrderHelper.py', SOURCE['helperHash'])
    controller = checked(source, 'controllers/OrderController.py', SOURCE['controllerHash'])
    checked(source, 'models/Order.py', SOURCE['modelHash'])
    cart_hash = '22604e22405c778f9fd756fb277f8bd0d026ccbd29d4eca84363427f48403072'
    cart_controller = checked(source, 'controllers/CartController.py', cart_hash)
    selected = [node for node in helper.body if isinstance(node, ast.FunctionDef) and node.name in
                {'get_screening_tickets_bought', 'enforce_screening_ticket_limit', 'build_has_products_model'}]
    queries = []
    response = {'value': 0, 'error': False}
    def fetch(_session, query, **_kwargs):
        if 'spiderman_screening_orders' in query:
            queries.append(query)
            if response['error']:
                raise RuntimeError('Synthetic count unavailable.')
            return {'cnt': response['value']}
        return {'parent_id': 390238, 'normal_price': 25, 'special_price': 0, 'cog': 0, 'exclusive_price': 0}
    class Denied(Exception):
        pass
    settings = SimpleNamespace(IS_LINE_ITEM_ENABLED=False, EXCLUSIVE_PRICELISTS=[1], EXCLUSIVE_PRODUCT={}, EXCLUSIVE_UPGRADE_PRODUCT={})
    namespace = {'SCREENING_TICKET_SKU': 390238, 'SCREENING_MAX_TICKETS': 2, 'fetchOne': fetch,
                 'logger': SimpleNamespace(error=lambda *_args: None), 'falcon': SimpleNamespace(HTTPBadRequest=Denied),
                 'Session': None, 'settings': settings, 'HasProductModel': lambda **fields: SimpleNamespace(**fields),
                 'allocate_amount_per_unit': lambda amount, quantity, _index: amount / quantity}
    exec(compile(ast.Module(body=selected, type_ignores=[]), '<pinned-screening-helpers>', 'exec'), namespace)
    limit = []
    for bought in range(4):
        for quantity in range(1, 4):
            message = None
            try:
                namespace['enforce_screening_ticket_limit'](bought, quantity)
            except Denied as error:
                message = str(error)
            limit.append({'bought': bought, 'quantity': quantity, 'allowed': message is None, 'message': message})
    response['value'] = '9007199254740993'
    exact_count = namespace['get_screening_tickets_bought'](None, 77)
    guest_count = namespace['get_screening_tickets_bought'](None, None)
    response['error'] = True
    unavailable_count = namespace['get_screening_tickets_bought'](None, 77)
    pos = next(node for node in controller.body if isinstance(node, ast.ClassDef) and node.name == 'PosOrder')
    on_post = next(node for node in pos.body if isinstance(node, ast.FunctionDef) and node.name == 'on_post')
    marker = [node for node in ast.walk(on_post) if isinstance(node, ast.If) and any(
        isinstance(child, ast.Call) and isinstance(child.func, ast.Name) and child.func.id == 'SpidermanScreeningOrderModel'
        for child in ast.walk(node)) and isinstance(node.test, ast.Compare)]
    # The innermost exact marker branch is distinct from outer request branches.
    marker = min(marker, key=lambda node: len(list(ast.walk(node))))
    modes = []
    for unit_mode in (False, True):
        for quantity in (1, 2):
            settings.IS_LINE_ITEM_ENABLED = unit_mode
            order = SimpleNamespace(id=9007199254740993, store_disc_pg=0, tss_points_used=0, coupon_used=0,
                                    coupon_amt_used=0, cashback_used=0, voucher_used=0, voucher_amt_used=0, flag_id=0)
            product = {'prod_id': 390238, 'quantity': quantity, 'price': 25, 'spl_price': 0,
                       'invoice_gst': 0, 'gst': 0, 'jit_value': 'REGULAR', 'image': '', 'pre_gst_amt': 25 * quantity}
            lines = namespace['build_has_products_model'](order, product, False, is_pos=True, is_shopify_order=False)
            for index, line in enumerate(lines):
                line.id = 9007199254740994 + index
            markers = []
            ns = {'product': product, 'SCREENING_TICKET_SKU': 390238, 'order': order, 'user': {'user_id': 77},
                  'has_products_row': lines, 'SpidermanScreeningOrderModel': lambda **fields: fields,
                  'session': SimpleNamespace(flush=lambda: None, add_all=lambda rows: markers.extend(rows))}
            exec(compile(ast.Module(body=[marker], type_ignores=[]), '<pinned-pos-marker>', 'exec'), ns)
            modes.append({'unitMode': unit_mode, 'quantity': quantity,
                          'lines': [{'quantity': row.qty, 'productId': str(row.prod_id), 'subProductId': str(row.sub_prod_id)} for row in lines],
                          'markerCount': len(markers), 'markerLineIds': [str(row['has_product_id']) for row in markers]})
    filtered = screened_base_profile(assert_plain_profile)
    types = SimpleNamespace(PRODUCTS=1, GIFT_VOUCHERS=2, COMPLEMENTARY_PRODUCTS=3)
    class Cart:
        def __init__(self, quantity=2): self.quantity = quantity
        def get(self, kind): return [{'prod_id': 390238, 'quantity': self.quantity}] if kind == 1 else []
    plan = {'kind': 'offline', 'lines': [{'productId': '390238', 'quantity': 2}], 'originalTenderAmount': '50.00'}
    profile_cases = []
    for name, selected_base, cart, member, calculations in (
        ('original-screening', assert_plain_profile, Cart(), {}, {'total': 50}),
        ('qualified-screening', filtered, Cart(), {}, {'total': 50}),
        ('membership-retained', filtered, Cart(), {'390238': 1}, {'total': 50}),
        ('quantity-retained', filtered, Cart(1), {}, {'total': 50}),
        ('benefit-retained', filtered, Cart(), {}, {'total': 50, 'used_tss_money': 1}),
        ('tender-retained', filtered, Cart(), {}, {'total': 49}),
    ):
        settings.EXCLUSIVE_PRODUCT = member
        code = None
        try:
            selected_base(cart, types, settings, plan, calculations)
        except ImportReview as error:
            code = error.code
        profile_cases.append({'name': name, 'code': code})
    cart_checks = sum(1 for node in ast.walk(cart_controller) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                      and node.func.id == 'enforce_screening_ticket_limit')
    pos_checks = sum(1 for node in ast.walk(on_post) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                     and node.func.id == 'enforce_screening_ticket_limit')
    return {'source': SOURCE, 'limit': limit, 'counter': {'exact': str(exact_count), 'guest': guest_count,
            'readErrorFallback': unavailable_count, 'sql': queries[0]}, 'modes': modes, 'profiles': profile_cases,
            'sourceChecks': {'cart': cart_checks, 'pos': pos_checks}}


if __name__ == '__main__':
    try:
        print(json.dumps(run(json.loads(sys.stdin.read())), separators=(',', ':')))
    except Exception:
        # This fixture never prints an exception or source/customer payload.
        print('{"code":"SCREENING_ORACLE_FAILED"}')
        sys.exit(1)
