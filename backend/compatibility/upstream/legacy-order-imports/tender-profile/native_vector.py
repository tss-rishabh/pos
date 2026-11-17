"""Exact source constructors/refunds/dated settlement on disposable MySQL only.

The post-confirmation statuses are explicitly seeded, not a new claim that this
oracle dispatched Go stock/coupon effects. No provider, Redis or task is called.
"""
import ast
import copy
import importlib.util
import json
import sys
import types
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from sqlalchemy import create_engine,event,text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
from source_tender import VECTORS,calculated,csv_calls,checked,WEB,API,settings
from source_runtime import SilentLogger
from transaction import private_session,normalize_source_sentinels,guard_private_statement,guard_private_commit
from native_source_driver import NativePipeline,K
import native_source_driver
from source_refunds import source_refund_projection
import source_refunds
from effects import CAPTURE


def json_safe(value):
    if isinstance(value,dict):return {key:json_safe(item) for key,item in value.items()}
    if isinstance(value,list):return [json_safe(item) for item in value]
    if type(value) is int and abs(value)>9007199254740991:return str(value)
    if isinstance(value,(str,int,float,bool)) or value is None:return value
    return str(value)


def native_row(session,sql,params=None):
    return dict(session.execute(text(sql),params or {}).mappings().one())


def insert(session,table,values):
    # The table/columns originate only from the pinned source ORM calls below.
    session.execute(text('INSERT INTO `'+table+'`('+','.join('`'+name+'`' for name in values)+') VALUES('+','.join(':'+name for name in values)+')'),values)


def settle_original(session,order_id,cash_received):
    captures=[]
    class Cursor:
        def execute(self,sql):session.execute(text(sql))
    class Objects:
        def __init__(self,table,filters=None):self.table=table;self.filters=filters or {}
        def filter(self,**values):return Objects(self.table,values)
        def first(self):
            if self.table=='order_status':return SimpleNamespace(order_status='DELIVERED')
            row=native_row(session,'SELECT order_status,payment_status,created_at FROM orders WHERE id=:id',self.filters)
            return SimpleNamespace(order_statuses=SimpleNamespace(id=row['order_status']),payment_statuses=SimpleNamespace(id=row['payment_status']))
        def __bool__(self):return False
        def update(self,**values):
            session.execute(text('UPDATE `'+self.table+'` SET '+','.join('`'+key+'`=:v_'+key for key in values)+' WHERE '+
                ' AND '.join('`'+key+'`=:w_'+key for key in self.filters)),
                {**{'v_'+key:value for key,value in values.items()},**{'w_'+key:value for key,value in self.filters.items()}})
        def create(self,**values):
            values['pay_dict']=json.dumps(values['pay_dict'],separators=(',',':'))
            values.update(created_at='2026-06-15 12:34:00',updated_at='2026-06-15 12:34:00')
            insert(session,self.table,values)
    class Comments:
        def __init__(self,**values):self.values=values
        def save(self):
            insert(session,'comments',{**self.values,'created_at':'2026-06-15 12:34:00','updated_at':'2026-06-15 12:34:00','has_product_id':0,'prod_id':0})
    tree,path=checked('web:helpers/helpers.py')
    cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='Helpers')
    methods=[node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name in {'complete_order','transaction_logger'}]
    namespace={'Order':SimpleNamespace(objects=Objects('orders')),'OrderStore':SimpleNamespace(objects=Objects('order_stores')),
        'PosTransactionLog':SimpleNamespace(objects=Objects('pos_transaction_logs')),'GiftVoucher':SimpleNamespace(objects=Objects('gift_vouchers')),
        'OrderStatus':SimpleNamespace(objects=Objects('order_status')),'Comments':Comments,'logger':SilentLogger(),
        'connections':{'mysql_db':SimpleNamespace(cursor=Cursor)}}
    isolated=ast.Module(body=[ast.ClassDef(name='Helpers',bases=[],keywords=[],body=methods,decorator_list=[])],type_ignores=[])
    ast.fix_missing_locations(isolated)
    exec(compile(isolated,path,'exec'),namespace)
    helpers=namespace['Helpers']
    helpers.push_order_kinesis=lambda order:captures.append(['producer',order])
    helpers.push_for_em=lambda order:captures.append(['membership-check',order])
    close=types.ModuleType('report.day_close_services')
    close.mark_stale=lambda *_args:captures.append(['close',*_args])
    close.order_close_date=lambda _order:'2026-06-15'
    sys.modules['report']=types.ModuleType('report');sys.modules['report.day_close_services']=close
    reference=native_row(session,'SELECT order_ref_no FROM orders WHERE id=:id',{'id':order_id})['order_ref_no']
    helpers.complete_order(order_id,reference,'Synthetic tender evidence',cash_received['cash'],
        cash_received['cashReceived'],cash_received['manualOther'],1,1,others=cash_received['others'],custom_date=cash_received['date'])
    return captures


def run(value):
    url=make_url(value['url'])
    if (url.host not in ('127.0.0.1','localhost') or not url.database.startswith('pos_rewrite_import_runtime_') or
        len(url.database)!=len('pos_rewrite_import_runtime_')+12 or url.query):raise RuntimeError('Disposable source fixture required.')
    vector=next(row for row in VECTORS if row['id']==value['vector'])
    line_items=value.get('lineItems',False)
    payment=value.get('payment','cash')
    cart=calculated(vector,line_items)
    native_source_driver.Cart=lambda _plan:SimpleNamespace(
        products=copy.deepcopy(cart.products),meta=copy.deepcopy(cart.meta),
        get=lambda kind:copy.deepcopy(cart.products) if kind is K.PRODUCTS else [],
        get_item=lambda kind,query:cart.meta.get(query['name']) if kind is K.META else None,
        update=lambda operation:cart.meta.update({operation['data']['name']:operation['data']}),
        re_init=lambda:SimpleNamespace(persist=lambda:None),persist=lambda:None)
    plan={'kind':'offline','createdAt':'2026-06-15 12:00:00','originalTenderAmount':str(sum(float(price)*qty for price,qty in vector['lines'])),
        'lines':[{'productId':str(9007199254740993+i),'quantity':qty,'unitPrice':price} for i,(price,qty) in enumerate(vector['lines'])]}
    def original_diagnostic_admission(_cart,_types,_settings,supplied,_calculations):
        # This child-only oracle measures the OLD source mismatch/coupon
        # behavior, before the rewrite's approved refusal. It never dispatches
        # Go/provider effects or produces an import acceptance receipt.
        if supplied is not plan:
            raise RuntimeError('Original diagnostic scope changed.')
    native_source_driver.assert_plain_profile=original_diagnostic_admission
    pipeline=NativePipeline(str(API),None);pipeline.settings.IS_LINE_ITEM_ENABLED=int(line_items)
    original_compile=native_source_driver.compile_class
    def with_member_attributes(root,path,name,namespace):
        if name=='PosOrder':
            tree=ast.parse((API/'models/Order.py').read_bytes())
            model=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='OrderAttributesModel')
            exec(compile(ast.Module(body=[model],type_ignores=[]),'<pinned-member-order-attribute>','exec'),namespace)
            helper_tree,helper_path=checked('api:libs/OrderHelper.py')
            function=next(node for node in helper_tree.body if isinstance(node,ast.FunctionDef) and node.name=='build_order_attributes_model')
            exec(compile(ast.Module(body=[function],type_ignores=[]),helper_path,'exec'),namespace)
        return original_compile(root,path,name,namespace)
    native_source_driver.compile_class=with_member_attributes
    engine=create_engine(url.set(drivername='mysql+pymysql'),echo=False,hide_parameters=True)
    event.listen(Session,'before_flush',normalize_source_sentinels);event.listen(Session,'before_commit',guard_private_commit)
    event.listen(engine,'before_cursor_execute',guard_private_statement)
    with Session(engine) as session,session.begin():
        user=dict(session.execute(text('SELECT * FROM users WHERE id=77')).mappings().one())
        user.update(user_id=77,is_exclusive=bool(vector.get('couponPercent')),batch='A')
        token=CAPTURE.set([])
        try:
            with private_session(session) as source:
                order_id,_cart=pipeline.order_pipeline(source,user,plan,{'scope':{'actorId':'1','storeId':'1','counterId':'2'}})
        finally:CAPTURE.reset(token)
        order_id=int(order_id)
        header=native_row(session,'SELECT * FROM orders WHERE id=:id',{'id':order_id})
        hp=[dict(row) for row in session.execute(text('SELECT * FROM has_products WHERE order_id=:id ORDER BY id'),{'id':order_id}).mappings()]
        original_projection=source_refunds.RefundProjection
        class NativeCouponProjection(original_projection):
            def fetch_one(self,source,query,to_dict=False):
                if source is not self or query!='Select voucher_type from coupons where id = 222' or not to_dict:
                    raise RuntimeError('Unexpected coupon source read.')
                return native_row(session,query)
        source_refunds.RefundProjection=NativeCouponProjection
        try:
            original,original_logs,_message,original_coherent=source_refund_projection(API,header,hp,reject_inconsistent=False,profile='source-v1')
            approved,approved_logs,_message,approved_coherent=source_refund_projection(API,header,hp,reject_inconsistent=False,profile='pos-refund-per-hp-v1')
        finally:source_refunds.RefundProjection=original_projection
        # Explicit boundary seed only; no stock/wallet/coupon confirmation is claimed.
        session.execute(text('UPDATE orders SET payment_status=1,order_status=1 WHERE id=:id'),{'id':order_id})
        session.execute(text("UPDATE has_products SET status='PLACED' WHERE order_id=:id"),{'id':order_id})
        tender=csv_calls(vector,payment)
        captures=settle_original(session,order_id,tender)
        observed=native_row(session,"SELECT id,CAST(pay_amt AS CHAR) AS payable,CAST(fraction_value AS CHAR) AS fraction,CAST(order_amt AS CHAR) AS amount,CAST(coupon_amt_used AS CHAR) AS coupon_amount,ref_flag,order_status,payment_status,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at,JSON_OBJECT('fraction_value',fraction_value) AS native_fraction_json FROM orders WHERE id=:id",{'id':order_id})
        counter=native_row(session,'SELECT CAST(offline_payment AS CHAR) AS cash,CAST(offline_payment_recieved AS CHAR) AS received,CAST(online_payment AS CHAR) AS online,CAST(online_other_payment AS CHAR) AS manual_other,CAST(offline_payment_recieved-offline_payment AS CHAR) AS change_amount FROM order_stores WHERE order_id=:id',{'id':order_id})
        lines=[dict(row) for row in session.execute(text('SELECT id,prod_id,qty,status,price,disc,gst,pre_gst_amt,final_payable,amount_to_be_refunded,fraction_value FROM has_products WHERE order_id=:id ORDER BY id'),{'id':order_id}).mappings()]
        ledger=native_row(session,"SELECT order_status,payment_status,pay_dict,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s') AS created_at FROM pos_transaction_logs WHERE order_id=:id",{'id':order_id})
        if isinstance(ledger['pay_dict'],str):ledger['pay_dict']=json.loads(ledger['pay_dict'])
        query_tree,query_path=checked('web:report/day_close_queries.py');queries={}
        exec(compile(query_tree,query_path,'exec'),queries)
        close_row=dict(session.connection().exec_driver_sql(queries['COLLECTION_SQL'],(1,'2026-06-15 00:00:00','2026-06-16 00:00:00')).mappings().one())
        service_tree,service_path=checked('web:report/day_close_services.py')
        class SnapshotCursor:
            def __enter__(self):return self
            def __exit__(self,*_args):return None
            def execute(self,query,params):self.result=session.connection().exec_driver_sql(query,tuple(params))
            def fetchone(self):return tuple(self.result.fetchone())
        import datetime as datetime_module
        service={'Decimal':Decimal,'datetime':datetime_module,'COLLECTION_SQL':queries['COLLECTION_SQL'],
            'CASH_REFUND_SQL':queries['CASH_REFUND_SQL'],'READ_DB_ALIAS':'fixture',
            'connections':{'fixture':SimpleNamespace(cursor=SnapshotCursor)}}
        selected=[node for node in service_tree.body if isinstance(node,ast.FunctionDef) and node.name in {'day_bounds','_money','compute_snapshot'}]
        exec(compile(ast.Module(body=selected,type_ignores=[]),service_path,'exec'),service)
        snapshot=service['compute_snapshot'](1,datetime.strptime('2026-06-15','%Y-%m-%d').date())
        ledger_tree,ledger_path=checked('web:report/cash_balance_services.py')
        ledger_code={'day_close':SimpleNamespace(compute_snapshot=lambda *_args:snapshot)}
        selected=[node for node in ledger_tree.body if isinstance(node,ast.FunctionDef) and node.name in {'expected_cash','_live_sales','_base_row','_closed_row'}]
        exec(compile(ast.Module(body=selected,type_ignores=[]),ledger_path,'exec'),ledger_code)
        zero=Decimal('0.00')
        hypothetical=SimpleNamespace(cash_system=snapshot['cash'],cash_refund_system=snapshot['cash_refund'],cash_manual_punched=zero,
            cash_manual_created=zero,cash_actual=snapshot['cash'],cash_difference=zero,banking_amount=zero,status='CLOSED')
        closed=ledger_code['_closed_row'](SimpleNamespace(id=1,store_name='Fixture'),datetime_module.date(2026,6,15),zero,hypothetical,None)
        cash_ledger={'liveSales':ledger_code['_live_sales'](1,datetime_module.date(2026,6,15)),
            'hypotheticalClosedSales':closed['sales_cash'],'hypotheticalClosingBalance':closed['closing_balance']}
        dsr_tree,dsr_path=checked('web:report/report_queries.py');reports={}
        exec(compile(dsr_tree,dsr_path,'exec'),reports)
        base=reports['daily_store_base_query']('store_orders',1,'0')
        query=reports['daily_store_rollup_query'](base,'store_orders','0','0')
        dsr_rows=[dict(row) for row in session.connection().exec_driver_sql(query,(1,'2026-06-15 00:00:00','2026-06-15 23:59:59')).mappings()]
        return json_safe({'vector':vector['id'],'lineItems':line_items,'payment':payment,'sourceTender':tender,
            'sourceRows':[{'productId':str(9007199254740993+i),'quantity':qty,'unitPrice':price} for i,(price,qty) in enumerate(vector['lines'])],
            'calculations':cart.meta['calculations'],'order':observed,'counter':counter,'lines':lines,'ledger':ledger,
            'refundOriginal':{'rows':original,'logs':original_logs,'coherent':original_coherent},
            'refundApproved':{'rows':approved,'logs':approved_logs,'coherent':approved_coherent},
            'dayClose':close_row,'dayCloseSnapshot':snapshot,'cashLedger':cash_ledger,'dsr':dsr_rows,'capturedEffects':captures,'confirmationBoundary':'seeded-source-post-confirmation'})


if __name__=='__main__':
    try:result=run(json.load(sys.stdin))
    except Exception as error:
        import traceback
        native_error=getattr(error,'orig',None);args=getattr(native_error,'args',())
        result={'oracleError':{'type':type(error).__name__,'code':getattr(error,'code',None),
            'nativeCode':args[0] if args and type(args[0]) is int else None,
            'frames':[Path(row.filename).name+':'+str(row.lineno) for row in traceback.extract_tb(error.__traceback__)][-5:]}}
    print(json.dumps(result,separators=(',',':'),allow_nan=False))
