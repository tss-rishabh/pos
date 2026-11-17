"""Actual Catalog/Cart/Validate/Processing source classes in the private path.

Only catalog/Mongo/pricelist data and the in-memory fixture cart store are
synthetic. The literal calculator and request/control flow are executed; this
is not certification of every original product initializer/wrapper profile.
"""
import ast
import copy
import hashlib
import io
import json
import os
import sys
import unittest
import uuid
import warnings
from pathlib import Path
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(ROOT/'tools/legacy-import-preparation'))
from source_fixture import pipeline,compile_class,pinned_source
from source_runtime import SourceRuntime,SilentLogger
from transaction import CURRENT,VIOLATION
from effects import CAPTURE
from cart_tracking import compile_helper
from protocol import ImportReview

SOURCE=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT',ROOT.parent.parent/'backend-tss-api_v2'))


class Rows:
    def __init__(self,values):self.values=values
    def fetchall(self):return self.values


class Queries:
    def __init__(self):self.writes=[]
    def execute(self,sql,params=None):
        if str(sql)=='SELECT gtin FROM products_gs1 WHERE product_id=:id ORDER BY id LIMIT 2':return Rows([(str(params['id']),)])
        if 'FROM user_upi_apps' in str(sql):return Rows([])
        raise AssertionError('Unexpected fixture SQL')
    def flush(self):pass
    def commit(self):self.flush()


def actual_catalog(root,result,trace,mode='normal',sku=100):
    for path,expected in {
        'controllers/priceList/PricelistManager.py':'86ad9c5335e73d157f2fb49ded98991103d443b254b2777562812f6b6281b127',
        'controllers/ClimesController.py':'5f836deeba7f6e7a21de66bbe968fb5c12b34a6694984eacefedf64477ffd784',
    }.items():
        if hashlib.sha256((root/path).read_bytes()).hexdigest()!=expected:raise AssertionError('Pinned catalog fixture dependency changed')
    namespace={'json':json,'logger':SilentLogger(),'settings':SimpleNamespace(SIZE_LIST=[],EXCLUSIVE_PRICELISTS=[]),
               'falcon':SimpleNamespace(HTTP_BAD_REQUEST='400 Bad Request',HTTP_NOT_FOUND='404 Not Found'),
               'FETCH_POS_PRODUCTS_FROM_REDIS':False,'ItemTypes':result.item_types,
               'get_product_slug':lambda _s,barcode:{'product_slug':'fixture-product','selected_variant_id':0,'parent_prod_id':0},
               'apply_pricelist':lambda *_a:None,'is_price_inclusive_gst':lambda *_a:True,
               'Cart':lambda:result.cart_reader,'insert_pos_data_into_redis':lambda *_a:None}
    document={'id':sku,'product_slug':'fixture-product','prod_type':1,'variant':[],'is_del':0,
              'store_stock':[{'Store_id':1,'Stock':99,'is_avail':1,'is_del':0}],
              'images':'[]','price':25,'spl_price':0,'exclusive_price':0,'prod_qty':99,'product':'Fixture product',
              'category':'Fixture category','cat':[],'firstname':'Fixture artist','gst':0}
    namespace['PosmongoDb']=SimpleNamespace(productsv2=SimpleNamespace(find_one=lambda _query:copy.deepcopy(document)))
    # Exact pinned source utility functions, not a reimplementation.
    tree=ast.parse((root/'controllers/CatalogController.py').read_bytes())
    functions=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ('pdp_data','prepare_payload_for_cart')]
    pricing=ast.parse((root/'controllers/priceList/PricelistManager.py').read_bytes())
    guard=next(node for node in pricing.body if isinstance(node,ast.ClassDef) and node.name=='PriceGuard')
    exec(compile(ast.Module(body=[guard,*functions],type_ignores=[]),'<literal-private-catalog-helpers>','exec'),namespace)
    source=compile_class(root,'controllers/CatalogController.py','PosProductDetail',namespace)()
    class Step:
        def on_post(self,req,resp):
            trace.append('catalog')
            if mode=='missing-param':del req.get_param
            return source.on_post(req,resp)
    return Step()


def fixture_add_io(root,result):
    globals_=result.cart_reader.source.on_post.__func__.__globals__
    with warnings.catch_warnings():
        warnings.simplefilter('ignore',SyntaxWarning)
        helpers=ast.parse((root/'libs/helper.py').read_bytes())
    enrich=next(node for node in helpers.body if isinstance(node,ast.FunctionDef) and node.name=='enrich_combo_fields')
    local={'get_parent_prod_id_for_variant':lambda _id:None,'get_combo_info_for_product':lambda _id:(None,None)}
    exec(compile(ast.Module(body=[enrich],type_ignores=[]),'<literal-combo-enrichment>','exec'),local)
    globals_.update(enrich_combo_fields=local['enrich_combo_fields'],SCREENING_TICKET_SKU=390238,
                    get_product_details_db=lambda sku:{'id':sku,'prod_type':1,'parent_prod_id':0},VALIDATE_CART_PRODUCTS=False)
    globals_['settings'].EXCLUSIVE_PRODUCT={};globals_['settings'].EXCLUSIVE_UPGRADE_PRODUCT={}
    climes=compile_class(root,'controllers/ClimesController.py','ClimesIdCreate',{'uuid':uuid,'logger':SilentLogger()})
    globals_['ClimesIdCreate']=climes
    original=result.cart_factory.empty_cart
    def empty(**kwargs):
        cart=original(**kwargs)
        cart.get_item_c=lambda payload:next((item for item in cart.products if item['prod_id']==payload['data']['prod_id']),None)
        return cart
    result.cart_factory=SimpleNamespace(empty_cart=empty)


class CatalogPipeline(unittest.TestCase):
    def test_actual_auto_add_uses_owned_falcon_param_contract_and_captures_processing_event(self):
        trace=[];plan={'kind':'offline','createdAt':'2026-06-15 12:00:00','lines':[{'productId':'100','quantity':2,'unitPrice':'25.00','sourceRows':[2]}],'originalTenderAmount':'50.00'}
        # The source helper classes below are pinned at their exact native
        # source root. No original controller module or external client loads.
        with pinned_source(SOURCE) as root:
            result=pipeline(root,plan,trace)
            result.product=actual_catalog(SOURCE,result,trace)
            fixture_add_io(SOURCE,result)
            helpers=compile_helper(SOURCE,SimpleNamespace(CART_PROCESS_ORDER_TRACK=True),tuple('user_cart_track_'+str(i) for i in range(10)),SilentLogger())
            result.process.source.on_post.__func__.__globals__['push_process_order_event']=helpers['push_process_order_event']
            user={'user_id':77,'firstname':'Fixture','lastname':'Customer','telephone':'9999999999','email':'fixture@example.test','is_exclusive':True}
            cap={'scope':{'actorId':'1','storeId':'1','counterId':'2'},'namespace':'pos-import-v1:11111111-1111-4111-8111-111111111111','preparationContract':'pos-import-order-preparation-v1'}
            session=Queries();effects=[];tokens=(CURRENT.set(session),CAPTURE.set(effects),VIOLATION.set(False))
            try:
                with result.membership.scope(session,user,plan,cap):
                    _req,_resp,cart,_base=result._cart_pipeline(session,user,plan,cap)
                self.assertEqual(cart.products[0]['quantity'],2)
                self.assertEqual(cart.meta['calculations']['total'],50)
                self.assertEqual(trace.count('catalog'),2)
                self.assertEqual([row['call']['name'] for row in effects],['process_abandon_cart_data'])
                self.assertEqual(effects[0]['call']['args'][0]['no_of_items'],2)
                self.assertFalse(VIOLATION.get())
            finally:CURRENT.reset(tokens[0]);CAPTURE.reset(tokens[1]);VIOLATION.reset(tokens[2])


if __name__=='__main__':unittest.main()
