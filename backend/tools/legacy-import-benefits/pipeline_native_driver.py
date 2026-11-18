"""Selected source benefits in the actual private preparation/order receiver.

Reuses the catalog→Cart→Validate→Processing→PosOrder native fixture. Catalog
Mongo/pricelist and the nonpersisted cart store are declared fixture I/O; the
coupon initializer/wrapper/calculator, source methods, SQL/order/HP/refund/grant
writes, head triggers/fence and receiver transactions are actual pinned code.
No history is obtained from native SQL; tests supply a sealed synthetic BQ doc.
"""
import ast
import copy
from datetime import datetime
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
from sqlalchemy import text

BACKEND=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(BACKEND/'tools/source-runtime-acceptance'))
sys.path.insert(0,str(BACKEND/'compatibility/upstream/public-screening-writer'))
sys.path.insert(0,str(BACKEND/'compatibility/upstream/legacy-order-imports/benefit-profile'))
from pipeline_native_driver import run
from benefit_runtime import SourceBenefits,ACTIVE,dispatcher
from benefit_source import compile_class,checked,strict_pos_grants,qualified_has_products
from benefit_codec import install_complementary_codec
from benefit_history_heads import NativeCouponHistoryHeads
from transaction import CURRENT
from source_oracle import Cache
import native_source_driver as native
from source_fixture import K


def install(value,source,literal,writer,engine):
    from source_template import source_models
    selected=value['body']['capability'].get('benefitContracts',{})
    environment={
        'POS_LEGACY_IMPORT_PROOF_KEY':value['proofKey'],
        'POS_LEGACY_IMPORT_COUPON_GUARD_KEY':value['guardKey'],
        'POS_LEGACY_IMPORT_BIRTHDAY_GUARD_CONTRACT':'pos-csv-birthday-cooperative-guard-v1',
    }
    if selected.get('automaticCoupon'):environment['POS_LEGACY_IMPORT_AUTOMATIC_COUPON_CONTRACT']=selected['automaticCoupon']
    if selected.get('complementary'):environment['POS_LEGACY_IMPORT_COMPLEMENTARY_CONTRACT']=selected['complementary']
    os.environ.update(environment)
    os.environ['POS_LEGACY_IMPORT_COUPON_HISTORY_KEY']=value['historyKey']
    # Only source eligibility is frozen. Native coupon validity still uses the
    # literal current DB CONVERT_TZ(now()) check, not this test clock.
    point=datetime.fromisoformat(value.get('point','2026-06-15 12:00:00'))
    writer.settings.BIRTHDAY_MESSAGE='birthday';writer.settings.EMPLOYEE_COUPON_DOMAIN_MAP={}
    writer.settings.REDIS_COUPON_EXPIRY_IN_SEC=600
    models=source_models(source)
    benefits=SourceBenefits(source,writer.settings,Cache(active=value.get('couponActive',True)),K,ValueError,
        heads=NativeCouponHistoryHeads(value['proofKey']),environment=environment,
        clock=lambda:value['now'],point_factory=lambda:point,zone='Asia/Kolkata',has_product_model=models['HasProductModel'])
    literal.benefits=benefits
    errors=value.setdefault('sourceErrors',[])
    def capture_error(error):
        import traceback
        errors.append({'type':type(error).__name__,'name':getattr(error,'name',None),
            'code':getattr(error,'code',None),
            'frames':[Path(row.filename).name+':'+str(row.lineno) for row in traceback.extract_tb(error.__traceback__)]})
    class Diagnostic:
        def __getattr__(self,_name):
            def emit(*_args,**_kwargs):
                error=sys.exc_info()[1]
                if error is not None and _name in ('error','critical'):capture_error(error)
            return emit
    for name in ('native','capture'):
        delegated=getattr(benefits,name)
        def check(*args,_delegated=delegated,**kwargs):
            try:return _delegated(*args,**kwargs)
            except Exception as error:capture_error(error);raise
        setattr(benefits,name,check)
    globals_=literal.cart_reader.source.on_post.__func__.__globals__
    globals_['logger']=Diagnostic()
    globals_.update(get_auto_apply_coupon=dispatcher('get_auto_apply_coupon'),
                    auto_apply_birthday_coupon=dispatcher('auto_apply_birthday_coupon'))
    free_ids=set(value.get('freeProducts',[]))
    globals_['get_product_details_db']=lambda sku:{'id':sku,'prod_type':4 if str(sku) in free_ids else 1,'parent_prod_id':0}
    # The original synthetic catalog helper needs one independent document per
    # selected product; it still executes the same literal catalog method.
    if len(value['body']['plan']['lines'])>1:
        from test_catalog_pipeline import actual_catalog
        catalogues={line['productId']:actual_catalog(source,literal,[],sku=int(line['productId']),
                    prod_type=4 if line['productId'] in free_ids else 1)
                    for line in value['body']['plan']['lines']}
        class Catalog:
            def on_post(self,req,resp):
                line=next(line for line in value['body']['plan']['lines']
                    if str(line['productId'])==str(req.context['data']['barcode']))
                return catalogues[line['productId']].on_post(req,resp)
        # Fixture GTINs intentionally equal lossless product IDs.
        literal.product=Catalog()
    initializer=compile_class(source,'controllers/cart/initializers/MetaInitializers.py','MetaInitializer',{
        'Initializer':object,'get_valid_coupon':dispatcher('get_valid_coupon'),
        'set_attributes_for_coupon':dispatcher('set_attributes_for_coupon'),
        'ValidationException':ValueError,'logger':native.SilentLogger()})()
    coupon_wrapper=compile_class(source,'controllers/cart/wrappers/CouponWrapper.py','CouponWrapper',{
        'Wrapper':object,'ValidationException':ValueError,'ItemTypes':K,
        'apply_coupon':dispatcher('apply_coupon'),'logger':native.SilentLogger()})()
    original_empty=literal.cart_factory.empty_cart
    def empty(**kwargs):
        cart=original_empty(**kwargs);cart.is_pos=True
        original_update=cart.update;original_apply=cart.apply_wrappers;original_get=cart.get
        cart.complementary=[]
        cart.get=lambda kind:cart.complementary if kind==K.COMPLEMENTARY_PRODUCTS else original_get(kind)
        def update(payload):
            if payload['type']=='meta' and payload['data'].get('name')=='coupon':
                payload={**payload,'data':initializer.initialize(cart.context,copy.deepcopy(payload['data']))}
            answer=original_update(payload)
            if payload['type']=='meta' and payload['data'].get('name') in ('coupon','pos_freebies'):cart.apply_wrappers()
            return answer
        def wrappers():
            selection=cart.get_item(K.META,{'name':'pos_freebies'})
            if selection and selection.get('items'):
                from benefit_source import source_pos_wrappers
                store=SimpleNamespace(items=[])
                cart.get_store=lambda _kind:store
                source_pos_wrappers(source,{'SessionR':cart.context['session'],'Wrapper':object,'ItemTypes':K,'json':json}).apply(cart)
                cart.complementary=store.items
            if cart.get_item(K.META,{'name':'coupon'}):coupon_wrapper.apply(cart)
            original_apply()
        cart.update=update;cart.apply_wrappers=wrappers
        cart.calculator.apply.__globals__['calculate_coupon_discount']=dispatcher('calculate_coupon_discount')
        return cart
    literal.cart_factory=SimpleNamespace(empty_cart=empty)
    native.assert_plain_profile=lambda cart,types,settings,plan,calc:ACTIVE.get().admit(cart,types,settings,calc)
    original_compile=native.compile_class
    def compile_native(root,path,name,namespace):
        if name=='PosOrder':namespace['logger']=Diagnostic()
        if name=='PosOrder' and selected.get('complementary'):
            namespace['build_has_products_model']=qualified_has_products(namespace['build_has_products_model'])
            install_complementary_codec(CURRENT.get(),namespace['HasProductModel'],selected['complementary'])
            # This exact source model is bound to the current order metadata.
            # Resolve its products/users references without fabricating rows.
            tree=checked(source,'models/Order.py')
            nodes=[node for node in tree.body if isinstance(node,ast.ClassDef)
                   and node.name in {'FreebieGrantLevel','FreebieGrantStatus','OrderFreebieModel'}]
            model_ns=dict(namespace);model_ns['datetime']=SimpleNamespace(datetime=SimpleNamespace(now=lambda:point))
            import sqlalchemy
            model_ns.update(vars(sqlalchemy))
            # source_functions retains the source Base in its namespace.
            exec(compile(ast.Module(body=nodes,type_ignores=[]),'<actual-freebie-model>','exec'),model_ns)
            namespace['persist_pos_freebie_grants']=strict_pos_grants(source,{
                'OrderFreebieModel':model_ns['OrderFreebieModel'],'FreebieGrantLevel':model_ns['FreebieGrantLevel'],
                'FreebieGrantStatus':model_ns['FreebieGrantStatus'],'datetime':SimpleNamespace(now=lambda:point),
                'logger':native.SilentLogger()})
        actual=original_compile(root,path,name,namespace)
        if name!='PosOrder':return actual
        class Actual(actual):
            def on_post(self,req,resp):
                try:result=super().on_post(req,resp)
                except Exception as error:capture_error(error);raise
                if value.get('lateClockAdvance'):value['now']+=value['lateClockAdvance']
                return result
        return Actual
    native.compile_class=compile_native
    if value.get('changedControls'):
        # A competing committed source change after prefetch, before entry.
        with engine.begin() as connection:connection.execute(text('UPDATE coupons SET voucher_val=voucher_val+1 WHERE id=222'))


if __name__=='__main__':
    try:
        value=json.loads(sys.stdin.read());result=run(value,customize=install)
        if value.get('sourceErrors'):result['sourceErrors']=value['sourceErrors']
        print(json.dumps(result,separators=(',',':')))
    except Exception as error:
        import traceback
        print(json.dumps({'code':getattr(error,'code','BENEFIT_PIPELINE_FIXTURE_FAILED'),
            'frames':[Path(row.filename).name+':'+str(row.lineno) for row in traceback.extract_tb(error.__traceback__)]},separators=(',',':')))
