"""Purpose-scoped compilation of pinned coupon/POS-freebie source functions.

No application bootstrap, source edit, network or database connection. Callers
supply their existing transaction and a PRELOADED qualified history document.
"""
import ast
import copy
import hashlib
import re
import sys
import warnings
from pathlib import Path
from protocol import ImportReview

PINS = {
    'models/Order.py': 'd9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5',
    'controllers/CartController.py': '22604e22405c778f9fd756fb277f8bd0d026ccbd29d4eca84363427f48403072',
    'controllers/CatalogController.py': '5dcf3d5db2d1bea2001b0e1d8349b02725b11482e831a7355b6eaaf343de400e',
    'controllers/cart/Cart.py': '1f9eff0f1a4ea66f3cac8903d3c1cb9a5b39e2a3babd6dd6c8dcf192de7defd3',
    'controllers/cart/initializers/MetaInitializers.py': 'e631cbac8c1f2f50e9692fdc128c15d0d1eefac64a21556201068a81e75d4e9f',
    'controllers/cart/validators/CouponValidation.py': 'e2d45aabb1a0b51215ce62f8e87532829d01708b97ab2ae3ac1ffc20dadda303',
    'controllers/cart/wrappers/CouponWrapper.py': '9aed9f8d0f853cad5364a1a6336f709a6fd3b7245cf1da24b4b2f7a9bbed94c1',
    'controllers/cart/wrappers/PosFreebieWrapper.py': 'b7c85c54a1cd9a9e6208abb3aa66daaababb3c7038af6306e2fe6fbc9bcbd9e2',
    'libs/helper.py': '4070e7da46499c8041c6831777b0403b2ffbf9d30911551da2da9ef0575b7766',
    'libs/OrderHelper.py': 'a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46',
    'libs/FreebieGrantHelper.py': '27c90149bb46aefd08f20ec080a9b36b141bee9e5edb27a8ab5c92003e14a463',
    'controllers/OrderController.py': '821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad',
}


class BenefitReview(ImportReview):
    def __init__(self, code='ORDER_IMPORT_BENEFIT_PROOF_INVALID'):
        self.code = code if isinstance(code,str) and re.fullmatch(r'ORDER_IMPORT_[A-Z0-9_]{1,45}',code) else 'ORDER_IMPORT_BENEFIT_PROOF_INVALID'
        transaction = sys.modules.get('transaction')
        if transaction is not None and hasattr(transaction, 'VIOLATION'):
            transaction.VIOLATION.set(True)
        super().__init__(self.code)


def checked(root, relative):
    try:
        raw = (Path(root) / relative).read_bytes()
        if hashlib.sha256(raw).hexdigest() != PINS[relative]:
            raise ValueError()
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', SyntaxWarning)
            return ast.parse(raw)
    except (OSError, KeyError, ValueError, SyntaxError):
        raise BenefitReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED') from None


def compile_functions(root, relative, names, namespace):
    tree = checked(root, relative)
    nodes = [copy.deepcopy(node) for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if len(nodes) != len(names):
        raise BenefitReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    for node in nodes:
        node.decorator_list = []
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<pinned-import-benefit>', 'exec'), namespace)
    return namespace


def compile_class(root, relative, name, namespace):
    nodes = [copy.deepcopy(node) for node in checked(root, relative).body if isinstance(node, ast.ClassDef) and node.name == name]
    if len(nodes) != 1:
        raise BenefitReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    for method in nodes[0].body:
        if isinstance(method, ast.FunctionDef):
            method.decorator_list = []
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<pinned-import-benefit>', 'exec'), namespace)
    return namespace[name]


def source_pos_selection(root, product_id, existing=None):
    """Execute ONLY the original Cart.add prod_type4 branch; no invented free gift.

    The caller must prove product_id is in the immutable CSV and has type4 in
    its CURRENT catalog row before calling. Repeated CSV qty still selects one.
    """
    tree = checked(root, 'controllers/CartController.py')
    target = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Cart')
    method = next(node for node in target.body if isinstance(node, ast.FunctionDef) and node.name == 'on_post')
    additions = [node for node in ast.walk(method) if isinstance(node, ast.If) and
                 ast.unparse(node.test) == "payload['operation'] == 'add'"]
    if len(additions) != 1:
        raise BenefitReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    blocks = [node for node in ast.walk(additions[0]) if isinstance(node, ast.If) and
              ast.unparse(node.test) == "product_details_db and product_details_db.get('prod_type') == 4"]
    if len(blocks) != 1:
        raise BenefitReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    class Cart:
        def __init__(self): self.meta = copy.deepcopy(existing)
        def get_item(self, *_args): return self.meta
        def update(self, payload): self.meta = copy.deepcopy(payload['data'])
    cart = Cart()
    namespace = {'product_details_db': {'prod_type': 4}, 'is_pos': True, 'cart': cart,
                 'ItemTypes': type('Types', (), {'META': 'meta'}),
                 'product_data': {'prod_id': product_id}, 'is_pos_freebie_add': False}
    exec(compile(ast.Module(body=[copy.deepcopy(blocks[0])], type_ignores=[]), '<pinned-CSV-POS-selection>', 'exec'), namespace)
    if namespace['is_pos_freebie_add'] is not True:
        raise BenefitReview()
    return cart.meta


def source_pos_wrappers(root, namespace):
    ns = dict(namespace)
    compile_functions(root, 'controllers/cart/wrappers/PosFreebieWrapper.py', {'get_pos_freebie_products'}, ns)
    return compile_class(root, 'controllers/cart/wrappers/PosFreebieWrapper.py', 'PosFreebieWrapper', ns)()


def compile_coupon(root, namespace):
    """All eligibility and arithmetic remain source code, including literal
    monthly/lot joins and the original per-item fixed/percentage/BOGO behavior.
    Session/SessionR/fetch/fetchOne MUST be the bounded history replay facade.
    Redis must be a scoped supplied guard/claim adapter, never an empty stub.
    """
    ns = dict(namespace)
    for relative, names in [
        ('libs/helper.py', {'check_birthday_month', 'get_birthday_coupon_details', 'fallback_for_redis_key',
                            'set_coupon_redis', 'validate_birthday_coupon', 'validate_employee_coupon'}),
        ('libs/OrderHelper.py', {'get_auto_apply_coupon', 'orders_count_using_birthday_coupon',
                                'allowed_coupon_usage', 'auto_apply_birthday_coupon'}),
        ('controllers/cart/initializers/MetaInitializers.py', {'get_valid_coupon', 'validate_coupon_count',
                                                            'get_coupon_cats', 'get_coupon_products', 'set_attributes_for_coupon'}),
        ('controllers/cart/validators/CouponValidation.py', {'cat_validator', 'single_cat_validator', 'multi_cat_validator',
             'product_validator', 'default_validator', 'validation_factory', 'apply_coupon', 'check_country_eligibility'}),
        ('controllers/cart/wrappers/CouponWrapper.py', {'calculate_coupon_discount'}),
    ]:
        compile_functions(root, relative, names, ns)
    return ns


def source_coupon_deduction(root, namespace):
    """A literal source oracle/alternative qualification hook only. The real
    offline path consumes in Go: never invoke this in addition to Go deduction.
    """
    return compile_functions(root, 'controllers/OrderController.py', {'coupon_deduction'}, dict(namespace))['coupon_deduction']


def strict_pos_grants(root, namespace):
    """Replace only the source's catch-and-log with transaction failure.

    The source treats the grant audit as best-effort. A qualified import must
    not commit a FREEBIE without its actual per-HP POS_MANUAL provenance.
    """
    tree = checked(root, 'libs/FreebieGrantHelper.py')
    node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'persist_pos_freebie_grants')
    node = copy.deepcopy(node)
    handlers = [n for n in ast.walk(node) if isinstance(n, ast.ExceptHandler)]
    if len(handlers) != 1:
        raise BenefitReview('ORDER_IMPORT_SOURCE_REVISION_UNVERIFIED')
    handlers[0].body = [ast.Raise(exc=ast.Call(func=ast.Name(id='BenefitReview', ctx=ast.Load()), args=[], keywords=[]), cause=None)]
    ns = dict(namespace, BenefitReview=BenefitReview)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<qualified-POS-grants>', 'exec'), ns)
    return ns['persist_pos_freebie_grants']


def qualified_has_products(original):
    """Correct only the selected free aggregate branch's missing GST key.

    PosFreebieWrapper does not supply gst. The original helper explicitly sets
    free invoice_gst=0; its per-unit branch already uses .get('gst',0), while
    aggregate accesses ['gst'] and crashes. Never overwrite a supplied rate or
    normalize an ordinary product; all source arithmetic remains delegated.
    """
    def build(order,product,is_exclusive,is_free=False,is_pos=False,calc=None,
              is_shopify_order=False,gift_voucher_id=0,ref_no=0,platform_id=1,is_express=0):
        if is_free is True and 'gst' not in product:
            product={**product,'gst':0}
        return original(order,product,is_exclusive,is_free=is_free,is_pos=is_pos,calc=calc,
            is_shopify_order=is_shopify_order,gift_voucher_id=gift_voucher_id,ref_no=ref_no,
            platform_id=platform_id,is_express=is_express)
    return build
