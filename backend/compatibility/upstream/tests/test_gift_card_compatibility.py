import ast
import copy
from datetime import datetime
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import prepare_gift_patch
import prepare_patches


class BadRequest(Exception):
    pass


class ValidationException(Exception):
    pass


def declarations(source, names, scope):
    nodes = [node for node in ast.parse(source).body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    if len(nodes) != len(names):
        raise AssertionError('Missing isolated source declaration')
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), '<pinned-gift-contract>', 'exec'), scope)
    return scope


def helpers():
    source = (ROOT/'payload/controllers/cart/pos_gift_card.py').read_text()
    scope = {'re': re, 'falcon': SimpleNamespace(HTTPBadRequest=BadRequest)}
    names = [node.name for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)]
    return declarations(source, names, scope)


def product():
    return dict(id=80, parent_prod_id=0, prod_stock=100, category_id=1, images=[], images_new={}, images_b=[], categories='1',
        prod_price=500, prod_spl_price=100, prod_spl_price_percent=20, prod_is_cod=0, prod_jit_value='REGULAR', prod_extra_price=0,
        is_printable=0, prod_gst=0, prod_prod_type=8, prod_added_by=0, artist_name='', artist_slug='', product='Fixture gift card', parent_available_size=[])


class GiftCardCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prepare_gift_patch.build()
        prepare_patches.build()
        cls.paths = ['controllers/cart/initializers/initializers.py', 'controllers/cart/Cart.py', 'controllers/cart/validators/Validators.py', 'controllers/OrderController.py']
        cls.before = {path: prepare_patches.original('api-v2', path) for path in cls.paths}
        with tempfile.TemporaryDirectory(prefix='pos-gift-contract-') as temporary:
            folder = Path(temporary)
            for path, value in {**cls.before, 'controllers/ExchangeOrderController.py': prepare_patches.original('api-v2', 'controllers/ExchangeOrderController.py')}.items():
                file = folder/path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(value)
            for name in ['api-v2-pos-gift-card.patch', 'api-v2-pos-exchange.patch']:
                patch = ROOT/'patches'/name
                subprocess.run(['git', 'apply', '--check', str(patch)], cwd=folder, check=True, capture_output=True)
                subprocess.run(['git', 'apply', str(patch)], cwd=folder, check=True, capture_output=True)
            refund_patch = ROOT/'offline-cash-pricing/patches/refund-by-hp-id.patch'
            subprocess.run(['git','apply','--check',str(refund_patch)],cwd=folder,check=True,capture_output=True)
            subprocess.run(['git','apply',str(refund_patch)],cwd=folder,check=True,capture_output=True)
            cls.after = {path: (folder/path).read_text() for path in cls.paths}

    def initialize(self, item, is_pos=True, patched=True):
        scope = helpers()
        scope.update(Initializer=object, SessionR=SimpleNamespace(execute=lambda *args, **kwargs: SimpleNamespace(fetchone=product)),
            prepare_db_product=lambda *args: None, prepare_product_variant=lambda *args: None, datetime=datetime, logger=SimpleNamespace(debug=lambda *args: None))
        path = 'controllers/cart/initializers/initializers.py'
        declarations((self.after if patched else self.before)[path], ['GiftVoucherInitializer'], scope)
        return scope['GiftVoucherInitializer']().initialize({'is_pos': is_pos}, copy.deepcopy(item))

    def item(self, value=None, identifier='9007199254740993'):
        details = {'pos_gift_id': identifier}
        if value is not None:
            details['gvprice'] = value
        return {'prod_id': 80, 'prod_type': 8, 'quantity': 1, 'is_pos': True, 'custom_data': details, 'gv_id': identifier}

    def test_every_hunk_applies_and_both_api_patches_compose(self):
        for path, source in self.after.items():
            compile(source, path, 'exec')
        repository, commit = prepare_patches.TARGETS['api-v2']
        self.assertEqual(subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repository, text=True).strip(), commit)

    def test_default_denomination_and_online_initialization_keep_source_output(self):
        item = {'prod_id': 80, 'prod_type': 8, 'quantity': 1, 'gv_id': '161126010203'}
        for is_pos in [False, True]:
            self.assertEqual(self.initialize(item, is_pos), self.initialize(item, is_pos, patched=False))

    def test_original_request_face_value_persists_through_repeated_rehydration(self):
        for value in [1, 1234, 10000]:
            with self.subTest(value=value):
                item = self.item(value)
                original = self.initialize(item, patched=False)
                self.assertEqual(original['gvamount'], 500)
                patched = self.initialize(item)
                self.assertEqual((patched['price'], patched['gvamount'], patched['spl_price'], patched['spl_price_percent'], patched['custom_price']), (value, value, 0, 0, True))
                self.assertEqual(self.initialize(patched), patched)
                self.assertEqual(patched['gst'], original['gst'])
                self.assertEqual(patched['invoice_gst'], original['invoice_gst'])
        legacy = {'prod_id': 80, 'prod_type': 8, 'quantity': 1, 'gv_id': '161126010203', 'custom_data': {'gvprice': 1234}}
        self.assertEqual(self.initialize(legacy)['gvamount'], 1234)

    def test_invalid_values_non_pos_and_forged_flags_never_establish_custom_pricing(self):
        for value in [False, True, 0, -1, 10001, 1.5, '1234', {}, []]:
            with self.subTest(value=value):
                with self.assertRaises(BadRequest):
                    self.initialize(self.item(value))
        with self.assertRaises(BadRequest):
            self.initialize(self.item(1234), is_pos=False)
        plain = {'prod_id': 80, 'prod_type': 8, 'quantity': 1, 'gv_id': '161126010203', 'custom_price': True, 'price': 1, 'gvamount': 10000}
        loaded = self.initialize(plain)
        self.assertEqual((loaded['price'], loaded['gvamount']), (500, 500))
        self.assertNotIn('custom_price', loaded)

    def test_exact_large_item_ids_prevent_same_second_collisions_and_reject_mutated_identity(self):
        scope = helpers()
        scope['datetime'] = datetime
        declarations(self.after['controllers/cart/Cart.py'], ['gift_voucher_indexer'], scope)
        ids = ['9007199254740993', '9007199254740994', '9223372036854775807']
        self.assertEqual([scope['gift_voucher_indexer'](self.item(identifier=value)) for value in ids], ids)
        for value in ['0', '01', '9223372036854775808', 9007199254740993, 'not-an-id']:
            with self.subTest(value=value):
                with self.assertRaises(BadRequest):
                    scope['gift_voucher_indexer'](self.item(identifier=value))
        changed = self.item()
        changed['gv_id'] = '8001'
        with self.assertRaises(BadRequest):
            scope['gift_voucher_indexer'](changed)

    def test_pos_accepts_distinct_cards_of_one_sku_while_online_and_duplicate_identity_remain_rejected(self):
        scope = helpers()
        scope.update(Validator=object, ValidationException=ValidationException, datetime=datetime)
        declarations(self.after['controllers/cart/validators/Validators.py'], ['GiftVoucherValidator'], scope)
        existing = self.item(identifier='9007199254740993')
        cart = SimpleNamespace(context={'is_pos': True}, get_c=lambda name: [existing])
        scope['GiftVoucherValidator']().validate(cart, self.item(identifier='9007199254740994'))
        with self.assertRaises(ValidationException):
            scope['GiftVoucherValidator']().validate(cart, self.item())
        cart.context['is_pos'] = False
        with self.assertRaises(ValidationException):
            scope['GiftVoucherValidator']().validate(cart, self.item(identifier='9007199254740994'))

    def test_source_total_and_gift_voucher_model_use_the_confirmed_face_amount(self):
        item = self.initialize(self.item(1234))
        source = prepare_patches.original('api-v2', 'controllers/cart/wrappers/CalculationsWrapper.py')
        tree = ast.parse(source)
        loop = next(node for node in ast.walk(tree) if isinstance(node, ast.For) and isinstance(node.iter, ast.Name) and node.iter.id == 'gift_vouchers' and any(isinstance(child, ast.AugAssign) for child in node.body))
        scope = {'gift_vouchers': [item], 'calculations': {'total': 0, 'products_total': 0, 'main_sub_total': 0}, 'selected_products_count': 0}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[loop], type_ignores=[])), '<source-gift-total>', 'exec'), scope)
        self.assertEqual(scope['calculations'], {'total': 1234, 'products_total': 1234, 'main_sub_total': 1234})
        scope.update(get_gift_cards=lambda serial: (True, 1, 'GC-FIXTURE'), GiftVoucherModal=lambda **kwargs: kwargs, datetime=datetime)
        declarations(prepare_patches.original('api-v2', 'libs/OrderHelper.py'), ['build_gift_voucher_model'], scope)
        voucher = scope['build_gift_voucher_model'](item, {'user_id': 1001}, SimpleNamespace(id=5001), is_pos=True, serial_no=990111, start_date='11/17/2026', end_date='02/15/2027')
        self.assertEqual((voucher['voucher_value'], voucher['voucher_initial_value'], voucher['gift_card_srno']), (1234, 1234, 990111))


if __name__ == '__main__':
    unittest.main()
