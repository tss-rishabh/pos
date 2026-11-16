import ast
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_pos_compatibility', ROOT / 'prepare_patches.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class BadRequest(Exception): pass
class Unavailable(Exception): pass
class ReachedStock(Exception): pass


def patched_file(target, filename):
    original = prepare.original(target, filename)
    with tempfile.TemporaryDirectory(prefix='pos-compatibility-patch-') as temporary:
        folder = Path(temporary)
        file = folder / filename
        file.parent.mkdir(parents=True)
        file.write_text(original)
        patch = ROOT / 'patches' / ('api-v2-pos-exchange.patch' if target == 'api-v2' else 'payments-pos-exchange.patch')
        subprocess.run(['git', 'apply', '--check', str(patch)], cwd=folder, check=True, capture_output=True)
        subprocess.run(['git', 'apply', str(patch)], cwd=folder, check=True, capture_output=True)
        return file.read_text()


class CompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prepare.build()
        cls.api = patched_file('api-v2', 'controllers/ExchangeOrderController.py')
        cls.payments = patched_file('payments', 'juspay/Order.go')

    def guards(self, live=None, proof=False, incomplete=False, orphan=False):
        tree = ast.parse(self.api)
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == '_pos_exchange_stock_proof')
        original = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'PosExchangeOrder')
        methods = []
        for method in original.body:
            if not isinstance(method, ast.FunctionDef): continue
            method.decorator_list = []
            if method.name == '_process_exchange':
                prefix = []
                for statement in method.body:
                    if isinstance(statement, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'stock_row' for target in statement.targets): break
                    prefix.append(statement)
                prefix.append(ast.Raise(exc=ast.Call(func=ast.Name(id='ReachedStock', ctx=ast.Load()), args=[], keywords=[]), cause=None))
                method.body = prefix
            methods.append(method)
        selected = ast.ClassDef(name='PosExchangeOrder', bases=[], keywords=[], decorator_list=[], body=methods)
        calls = []
        def fetch_one(session, query, parameters=None, to_dict=False):
            calls.append((session, query, parameters))
            if query == 'parent-query': return {'parent_prod_id':100}
            if 'SELECT hp.id AS has_product_id' in query: return {'product_status':'EXCHANGE_INITIATED'}
            if 'FROM pos_rewrite_exchange_stock_confirmations' in query: return {'order_id':9901} if proof else None
            if 'SELECT eol.order_id, os.id AS order_store_id' in query: return live
            if 'SELECT e.order_id FROM exchange_order_log' in query: return {'order_id':9901} if incomplete else None
            if 'SELECT o.id FROM orders o LEFT JOIN exchange_order_log' in query: return {'id':9901} if orphan else None
            raise AssertionError('Unexpected isolated guard query')
        scope = {'json':json,'fetchOne':fetch_one,'FETCH_PARENT_PRODUCT_ID':'parent-query','show_button_for_my_order':lambda *args,**kwargs:(False,True,None,''),'NON_EXCHANGEABLE_PRODUCTS':[], 'falcon':SimpleNamespace(HTTPBadRequest=BadRequest,HTTPServiceUnavailable=Unavailable), 'ReachedStock':ReachedStock,'logger':SimpleNamespace(info=lambda *args:None,warning=lambda *args:None,error=lambda *args:None)}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[helper,selected],type_ignores=[])), '<patched-pos-exchange-guards>', 'exec'),scope)
        request = SimpleNamespace(context={'session':'writer','session_r':'reader'})
        context = dict(admin_user_id=777,salesperson_id=5,order_id=9001,has_product_id=9101,prod_id=10,exchange_prod_id=11,exchange_parent_prod_id=100,size='L',store_id=1,counter_id=3)
        return scope, request, context, calls

    def test_patch_hunks_apply_to_exact_pinned_sources_without_editing_them(self):
        for target,(repository,commit) in prepare.TARGETS.items():
            self.assertEqual(subprocess.check_output(['git','rev-parse','HEAD'],cwd=repository,text=True).strip(),commit)
        self.assertIn('if tryConfirmPOSExchange(c, &o)',self.payments)
        self.assertLess(self.payments.index('if tryConfirmPOSExchange(c, &o)'),self.payments.index('// Express-Parent-Order'))

    def test_scoped_proven_child_preserves_success_payload(self):
        scope,request,context,calls=self.guards(live={'order_id':9901,'order_store_id':1,'child_store_id':1,'child_counter_id':3,'child_prod_id':11},proof=True)
        response=SimpleNamespace(text='')
        scope['PosExchangeOrder']()._process_exchange(request,response,context)
        self.assertEqual(json.loads(response.text),{'status':'SUCCESS','new_order_id':9901})
        proof_call=next(call for call in calls if 'FROM pos_rewrite_exchange_stock_confirmations' in call[1])
        self.assertEqual(proof_call[0],'writer');self.assertEqual(proof_call[2],{**context,'child_id':9901})

    def test_other_store_counter_size_and_online_child_never_reuse(self):
        base={'order_id':9901,'order_store_id':1,'child_store_id':1,'child_counter_id':3,'child_prod_id':11}
        for changed in [{'child_store_id':2},{'child_counter_id':4},{'child_prod_id':12},{'order_store_id':None}]:
            with self.subTest(changed=changed):
                scope,request,context,_=self.guards(live={**base,**changed},proof=True)
                with self.assertRaises(BadRequest):scope['PosExchangeOrder']()._process_exchange(request,SimpleNamespace(text=''),context)

    def test_paid_child_without_committed_stock_proof_never_reports_success(self):
        scope,request,context,_=self.guards(live={'order_id':9901,'order_store_id':1,'child_store_id':1,'child_counter_id':3,'child_prod_id':11})
        with self.assertRaises(Unavailable):scope['PosExchangeOrder']()._process_exchange(request,SimpleNamespace(text=''),context)

    def test_incomplete_and_orphan_children_block_new_order_creation(self):
        for data in [{'incomplete':True},{'orphan':True}]:
            scope,request,context,_=self.guards(**data)
            with self.assertRaises(Unavailable):scope['PosExchangeOrder']()._process_exchange(request,SimpleNamespace(text=''),context)

    def test_clean_request_can_reach_the_live_stock_guard(self):
        scope,request,context,_=self.guards()
        with self.assertRaises(ReachedStock):scope['PosExchangeOrder']()._process_exchange(request,SimpleNamespace(text=''),context)

    def test_unavailable_mutex_fails_before_any_exchange_work(self):
        scope,request,context,_=self.guards()
        def unavailable(*args,**kwargs):raise RuntimeError('fixture unavailable')
        scope['redis_object']=SimpleNamespace(set=unavailable,delete=lambda *args:None)
        request.context['data']={**context,'has_prod_id':context['has_product_id']}
        with self.assertRaises(Unavailable):scope['PosExchangeOrder']().on_post(request,SimpleNamespace(text=''))


if __name__=='__main__':unittest.main()
