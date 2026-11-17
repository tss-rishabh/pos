"""Disposable fixture runner: literal PosOrder body +real native transaction.

Only source catalog/cache/delivery I/O is synthetic. Source constructors,
default application, order/reference/HP writes and approved refund function
execute from pinned source bytes. Never imports the original main/settings.
"""
import ast
import datetime
import enum
import hashlib
import json
import random
import sys
from decimal import Decimal,ROUND_HALF_UP
from pathlib import Path
from types import SimpleNamespace
from sqlalchemy import create_engine,text,event,Table,MetaData,bindparam
from sqlalchemy.orm import Session,sessionmaker,registry
from sqlalchemy.engine import make_url

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent/'offline-cash-pricing'))
from source_template import source_functions,source_models
from source_refunds import refund_tree,CORRECTED_CONTROLLER_SHA256
from source_runtime import compile_class,SilentLogger
from transaction import normalize_source_sentinels,guard_private_statement,guard_private_commit
from receiver import Receiver
from effects import Tasks
from protocol import ImportReview


class K(enum.Enum):
    PRODUCTS=1;META=2;GIFT_VOUCHERS=3;COMPLEMENTARY_PRODUCTS=4


class Cart:
    def __init__(self,plan):
        total=sum(float(row['unitPrice'])*row['quantity'] for row in plan['lines'])
        self.products=[{'prod_id':int(row['productId']),'quantity':row['quantity'],'price':float(row['unitPrice']),
            'spl_price':0,'invoice_gst':0,'gst':0,'pre_gst_amt':float(row['unitPrice'])*row['quantity'],
            'gender_type':0,'jit_value':'REGULAR','images_new':'','categories':[], 'prod_type':1,
            'cashback_earned':0,'exclusive_savings':0} for row in plan['lines']]
        self.meta={'calculations':{'main_sub_total':total,'sub_total':total,'total':int(total),'rounding_off':total-int(total),
            'used_reward_points':0,'used_tss_money':0,'used_tss_points':0,'gift_voucher_value':0,'coupon_discount':0,
            'hl_charges':0,'gift_wrap_amount':0,'shipping_charges':0,'app_discount':0,'cod_charges':0,'app_cashback':0}}
    def get(self,kind):
        return self.products if kind is K.PRODUCTS else []
    def get_item(self,kind,query):
        return self.meta.get(query['name']) if kind is K.META else None
    def update(self,value):
        self.meta[value['data']['name']]=value['data'];return self
    def re_init(self):return self
    def persist(self):return self


class Executor:
    def __init__(self,session):self.session=session
    def select(self,query,parameters,*,limit):
        statement=text(query)
        for key,value in parameters.items():
            if isinstance(value,(list,tuple)):statement=statement.bindparams(bindparam(key,expanding=True))
        result=self.session.execute(statement,parameters)
        values=[dict(row) for row in result.mappings().fetchmany(limit)]
        if len(values)==limit:raise ImportReview('ORDER_IMPORT_RESULT_TOO_LARGE')
        return values


class NativePipeline:
    def __init__(self,root,mode):
        self.root=Path(root);self.mode=mode
        self.settings=SimpleNamespace(IS_LINE_ITEM_ENABLED=False,EXCLUSIVE_PRICELISTS=[1],
            POS_CASHBACK_QUEUE='fixture-cashback',WAREHOUSE_ASSIGN_QUEUE='fixture-warehouse',EXCLUSIVE_PRODUCT={},EXCLUSIVE_UPGRADE_PRODUCT={})
        self.controller_hash=CORRECTED_CONTROLLER_SHA256
        from fixture_broker import FixtureBroker
        self.tasks=FixtureBroker(mode)
    def order_pipeline(self,session,user,plan,capability):
        executor=Executor(session)
        namespace,_=source_functions(self.root,vars(self.settings),executor,[row['productId'] for row in plan['lines']])
        if self.mode!='original-model':
            from model_compat import install_model_codec,verify_physical_columns
            verify_physical_columns(session.session.connection())
            install_model_codec(namespace['OrderModel'],namespace['OrderStoreModel'],namespace['HasProductModel'])
        def fetch_one(_session,query,params=None,to_dict=False):
            result=session.execute(query,params or {}).mappings().first()
            return dict(result) if result else {}
        def fetch(_session,query,params=None,to_dict=False):
            return [dict(row) for row in session.execute(query,params or {}).mappings().all()]
        namespace.update(Session=session,fetchOne=fetch_one,fetch=fetch,ItemTypes=K)
        status_tree=ast.parse((Path(self.root)/'constants/StatusEnum.py').read_text())
        statuses=[node for node in status_tree.body if isinstance(node,ast.ClassDef) and node.name in {'_IntEnum','PaymentStatus','PaymentMethod'}]
        exec(compile(ast.Module(body=statuses,type_ignores=[]),'<pinned-payment-status>','exec'),namespace)
        parsed=ast.parse((Path(self.root)/'libs/OrderHelper.py').read_text())
        shopify=next(node for node in parsed.body if isinstance(node,ast.FunctionDef) and node.name=='shopify_build_order_model')
        exec(compile(ast.Module(body=[shopify],type_ignores=[]),'<pinned-shopify-constructor>','exec'),namespace)
        # Original FlagHistory and OrderAddressMapping constructors are used.
        import sqlalchemy
        from sqlalchemy.orm import declarative_base
        globals_=dict(vars(sqlalchemy));globals_.update(Base=declarative_base(),datetime=datetime)
        flag_tree=ast.parse((Path(self.root)/'models/FlagHistory.py').read_text())
        flag=next(node for node in flag_tree.body if isinstance(node,ast.ClassDef) and node.name=='FlagHistoryModel')
        exec(compile(ast.Module(body=[flag],type_ignores=[]),'<pinned-flag-model>','exec'),globals_)
        models=namespace['OrderModel'].__table__.metadata
        # Resolving a ForeignKey needs only metadata, not alternate constructors.
        for name in ('users','products','stores','store_counters'):
            if name not in models.tables:Table(name,models,autoload_with=session.session.connection())
        model_tree=ast.parse((Path(self.root)/'models/Order.py').read_text())
        address=next(node for node in model_tree.body if isinstance(node,ast.ClassDef) and node.name=='OrderAddressMappingModel')
        exec(compile(ast.Module(body=[address],type_ignores=[]),'<pinned-address-mapping>','exec'),namespace)
        namespace.update(FlagHistoryModel=globals_['FlagHistoryModel'],
            # The fixture pre-existing exact source address is read only.
            build_address_model=lambda *_args:(None,88),
            get_valid_gift_vouchers=lambda *_args:set(),get_exclusive_product=lambda *_args:None,
            get_exclusive_upgrade_product=lambda *_args:None,fetch_cashback=lambda value:value['cashback'],
            fetch_tss_points=lambda value:value['tss_points'],fetch_tss_money=lambda value:value['tss_money'],
            get_app_cashback_data_status=lambda:{'app_cashback_data':None,'web_cashback_data':None},
            logger=SilentLogger(),tasks=Tasks(),SCREENING_TICKET_SKU=390238,json=json,text=text,
            datetime=datetime.datetime,Decimal=Decimal,ROUND_HALF_UP=ROUND_HALF_UP,math=__import__('math'),
            redis_object=SimpleNamespace(exists=lambda *_args:False),
            settings=self.settings,ValidateCheckout=lambda:SimpleNamespace(on_post=lambda *_args:None))
        reference_tree=ast.parse((Path(self.root)/'libs/OrderRef.py').read_text())
        ref=next(node for node in reference_tree.body if isinstance(node,ast.ClassDef) and node.name=='UniqueOrderRefNo')
        namespace['random']=random
        exec(compile(ast.Module(body=[ref],type_ignores=[]),'<pinned-reference>','exec'),namespace)
        _,refund_ast=refund_tree(self.root,'pos-refund-per-hp-v1')
        refund=[node for node in refund_ast.body if isinstance(node,ast.FunctionDef) and node.name in {'_round2','_distribute_amount_to_be_refunded','amount_to_be_refunded_calculation'}]
        def source_order(_session,order_id,_user):
            return dict(session.execute('SELECT * FROM orders WHERE id=:id',{'id':order_id}).mappings().one())
        namespace.update(fetch_order=source_order)
        exec(compile(ast.Module(body=refund,type_ignores=[]),'<pinned-approved-refund>','exec'),namespace)
        order=compile_class(self.root,'controllers/OrderController.py','PosOrder',namespace)()
        cart=Cart(plan)
        if self.mode in ('correction-calculator','correction-current-discount'):
            import os
            os.environ['POS_LEGACY_IMPORT_SOURCE_ROOT']=str(self.root)
            sys.path.insert(0,str(HERE/'tender-profile'))
            from source_tender import calculated
            original=calculated({'id':'source-correction','lines':[(row['unitPrice'],row['quantity']) for row in plan['lines']],
                                 'gst':0,'appPercent':5 if self.mode=='correction-current-discount' else 0})
            # Execute the pinned source calculator. The native constructor uses
            # this fixture's catalog shape, with source-calculated money fields.
            cart.meta['calculations']=original.meta['calculations']
        from profiles import assert_plain_profile
        assert_plain_profile(cart,K,self.settings,plan,cart.meta['calculations'])
        from protocol import source_custom_data
        req=SimpleNamespace(context={'session':session,'session_r':session,'cart':cart,'user':user,
            'data':{'is_pos':True,'store_id':int(capability['scope']['storeId']),'counter_id':int(capability['scope']['counterId']),
                    'admin_user_id':int(capability['scope']['actorId']),'id':14 if plan['kind']=='offline' else 15,
                    'payment_method':'coc' if plan['kind']=='offline' else 'shopify','custom_data':source_custom_data(plan),
                    'custom_created_at':plan['createdAt']}},params={},get_header=lambda *_a,**_k:None)
        resp=SimpleNamespace(body='',text='',status='200 OK')
        order.on_post(req,resp)
        if self.mode=='visibility-barrier':
            import time
            print('SOURCE_FLUSHED',flush=True)
            time.sleep(1.5)
        if self.mode=='late-failure':raise ImportReview('ORDER_IMPORT_FIXTURE_LATE_FAILURE')
        return str(json.loads(resp.body)['order']),cart
    def publication_intents(self,order_id):
        namespace={'tasks':Tasks(),'settings':SimpleNamespace(CELERY_KINESIS_ORDER_QUEUE='fixture-kinesis',
            NETCORE_EVENTS_QUEUE='fixture-engagement',POST_ORDER_SHADOW_ENABLED=False)}
        source=compile_class(self.root,'controllers/KinesisProducer.py','SyncOrderById',namespace)()
        from effects import CAPTURE
        values=[];token=CAPTURE.set(values)
        try:source.on_post(SimpleNamespace(context={'data':{'payload':int(order_id)}}),SimpleNamespace(text=''))
        finally:CAPTURE.reset(token)
        return values


if __name__=='__main__':
    value=json.loads(sys.stdin.read())
    url=make_url(value['url'])
    if (url.host not in ('127.0.0.1','localhost') or not url.database.startswith('pos_rewrite_import_runtime_') or
        len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):
        raise RuntimeError('Disposable localhost source fixture required')
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    event.listen(Session,'before_flush',normalize_source_sentinels)
    event.listen(Session,'before_commit',guard_private_commit)
    event.listen(engine,'before_cursor_execute',guard_private_statement)
    pipeline=NativePipeline(value['sourceRoot'],value.get('mode'))
    service=Receiver(sessionmaker(bind=engine,expire_on_commit=False),pipeline,value['authKey'],value['proofKey'],clock=lambda:value['now'],correction_contract=value.get('correctionContract'))
    original=pipeline.order_pipeline
    failure=[]
    def checked(*args):
        try:return original(*args)
        except Exception as error:
            import traceback
            import re
            original_error=getattr(error,'orig',None)
            error_args=getattr(original_error,'args',())
            native_code=error_args[0] if error_args and type(error_args[0]) is int else None
            message=str(error_args[1]) if len(error_args)>1 else str(error)
            column=re.search(r"(?:for column\s+|Field\s+|^)'?([a-z_]+)'",message)
            failure.append({'type':type(error).__name__,'nativeCode':native_code,
                'column':column.group(1) if column else None,
                'metadata':getattr(error,'metadata',None),
                'frames':[Path(row.filename).name+':'+str(row.lineno) for row in traceback.extract_tb(error.__traceback__)][:8]})
            raise
    pipeline.order_pipeline=checked
    try:result=getattr(service,value.get('phase','order'))(value['operationId'],value['body'])
    except ImportReview as error:result={'code':error.code}
    result['fixtureFailures']=failure
    if value.get('phase')=='publication':result['queueCalls']=len(pipeline.tasks.accepted)
    print(json.dumps(result,separators=(',',':')))
