"""Pinned old lifecycle scheduling/payload ASTs, with inert DB/HTTP/task doubles.

This executes selected source methods, not Django endpoints or real transports.
"""
import ast
import asyncio
import datetime as real_datetime
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

root=Path(__file__).resolve().parents[4]/'backend-pos-web'
revision='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
def source(file):
    text=subprocess.check_output(['git','-C',str(root),'show',revision+':'+file],text=True)
    return ast.parse(text)
helpers=source('helpers/helpers.py')
views=source('order/views.py')
tasks=source('core/tasks.py')
inventory=source('helpers/inventory_helper.py')
def function(tree,name,scope,class_name=None):
    parent=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==class_name) if class_name else tree
    selected=next(node for node in parent.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name==name)
    selected.decorator_list=[]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[selected],type_ignores=[])),'<pinned-local-delivery-oracle>','exec'),scope)
    return scope[name]
class Query:
    def __init__(self,rows):self.rows=rows
    def __bool__(self):return bool(self.rows)
    def __iter__(self):return iter(self.rows)
    def first(self):return self.rows[0] if self.rows else None
    def filter(self,**_kwargs):return self
    def update(self,**values):
        for row in self.rows:
            for key,value in values.items():setattr(row,key,value)

def run(case):
    if case['kind']=='exception-date':
        report=source('report/datatables/hyperlocal_report_datatable.py')
        cls=next(node for node in report.body if isinstance(node,ast.ClassDef) and node.name=='AjaxHyperlocalOrdersDataListView')
        method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
        expression=next(node for node in ast.walk(method) if isinstance(node,ast.Dict) and any(isinstance(key,ast.Constant) and key.value=='delivery_exception_date' for key in node.keys))
        value=next(value for key,value in zip(expression.keys,expression.values) if isinstance(key,ast.Constant) and key.value=='delivery_exception_date')
        compiled=compile(ast.fix_missing_locations(ast.Expression(body=value)),'<pinned-exception-date-formatter>','eval')
        return [eval(compiled,{'obj':SimpleNamespace(delivery_exception_date=real_datetime.datetime.fromisoformat(value) if value is not None else None)}) for value in case['values']]
    if case['kind']=='hold':
        product=SimpleNamespace(stock=case['stock'])
        held=Query([SimpleNamespace(stock=case['held'])] if case.get('held') is not None else [])
        def create(**values):
            row=SimpleNamespace(**values)
            held.rows.append(row)
            return row
        held.create=create
        logs=[];projections=[];syncs=[]
        def inward(_product,_store,quantity,*_args):product.stock+=quantity
        scope={'Helpers':SimpleNamespace(get_store_type=lambda _store:'STORE',sync_pos_inventory=lambda *args,**kwargs:projections.append({'args':args,'kwargs':kwargs}),sync_pos_product=lambda ids:syncs.append(ids)),
            'ProductStore':SimpleNamespace(objects=Query([product])),
            'HoldStockStore':SimpleNamespace(objects=held),
            'Store':SimpleNamespace(objects=Query([SimpleNamespace(store_name='Fixture',location_code='FIXTURE')])),
            'add_to_hold_stock_log':lambda *args:logs.append(args),
            'inward_product_to_store':inward,'logger':SimpleNamespace(exception=lambda *_args:None)}
        method=function(inventory,case['action'],scope,'HoldStockHelperClass')
        result=method(10,1,case['quantity'],0,extra_message='Fixture lifecycle reservation',**({'order_push':case.get('consume',False)} if case['action']=='unhold_stock' else {}))
        return {'result':result,'stock':product.stock,'held':held.first().stock if held else None,'logs':logs,'projections':projections,'syncs':syncs}
    if case['kind']=='transfer':
        order=SimpleNamespace(location_type='SW',location_id=1,is_split_order=case.get('split',1),next_location_ids=case['nextIds'],is_transfer=case.get('transferred',0))
        lines=[SimpleNamespace(product=SimpleNamespace(id=10+index),qty=index+1,platform=platform) for index,platform in enumerate([4,4,1])]
        held=[];notices=[];jobs=[];audits=[];slack=[]
        now=real_datetime.datetime.fromisoformat(case['now'])
        class TransferDateTime(real_datetime.datetime):
            @classmethod
            def now(cls,*_args,**_kwargs):return now
        datetime=SimpleNamespace(datetime=TransferDateTime)
        buffer_scope={'datetime':datetime}
        get_buffer=function(helpers,'get_buffer_second',buffer_scope,'Helpers')
        scope={'Order':SimpleNamespace(objects=Query([order])),
            'HyperlocalOrderLog':SimpleNamespace(objects=Query([])),
            'HasProduct':SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs:Query([line for line in lines if 'order_platform__id' not in kwargs or line.platform==kwargs['order_platform__id']]))),
            'HoldStockHelperClass':SimpleNamespace(hold_stock=lambda *args,**kwargs:held.append({'kind':'hold','args':args,'kwargs':kwargs}),unhold_stock=lambda *args,**kwargs:held.append({'kind':'release','args':args,'kwargs':kwargs})),
            'OrderAddon':SimpleNamespace(objects=Query([SimpleNamespace(order_transferred_timestamp=None)])),
            'Helpers':SimpleNamespace(transaction_logger=lambda *args:audits.append(args),get_buffer_second=get_buffer,get_order_creation_buffer_time=lambda:case.get('buffer',3600),slack_text_notification=lambda *args,**kwargs:slack.append({'args':args,'kwargs':kwargs})),
            'create_order_notification_sync':lambda *args,**kwargs:notices.append({'args':args,'kwargs':kwargs}),
            'auto_hl_order_to_online':SimpleNamespace(apply_async=lambda **kwargs:jobs.append(kwargs)),
            'HYPERLOCAL_CUT_OFF_SWITCH':case.get('cutoff',False),'HYPERLOCAL_CUT_OFF_TIME':'17:00','datetime':datetime,'json':json,'logger':SimpleNamespace(info=lambda *_args:None,exception=lambda *_args:None)}
        result=function(views,'auto_hl_order_transfer',scope)(case['orderId'],SimpleNamespace(first_name='Fixture',last_name='Manager'),reason='Fixture reason',is_auto=case.get('automatic',False),reason_dropdown='Fixture category')
        return {'result':result,'transferred':order.is_transfer,'held':held,'notices':notices,'jobs':jobs,'audits':audits,'slack':slack}
    if case['kind']=='payload':
        calls=[];slack=[]
        def post(url,json=None,headers=None,**_kwargs):
            calls.append({'url':url,'headers':headers or {},'body':__import__('json').dumps(json)})
            return SimpleNamespace(status_code=200)
        def request(method,url,headers=None,data=None,**_kwargs):
            calls.append({'url':url,'headers':headers or {},'body':data})
            return SimpleNamespace(status_code=200)
        helper=SimpleNamespace(create_token=lambda *_args:('fixture-token',None),slack_text_notification=lambda message:slack.append(message))
        scope={'requests':SimpleNamespace(post=post,request=request),'json':json,'Helpers':helper,'TSS_OBERVER_URL':'https://observer.example.test/','TSS_OBERVER_APP_ID':'fixture-observer','TSS_OBERVER_APP_KEY':'fixture-observer-key','MAIN_API_V2_URL':'https://api.example.test/','ORDER_PRODUCER_URL':'https://producer.example.test/','ORDER_PRODUCER_APP_ID':'fixture-producer','ORDER_PRODUCER_APP_KEY':'fixture-producer-key','MJML_HOST':'https://mail.example.test/','logger':SimpleNamespace(error=lambda *_args:None),
            'HasProduct':SimpleNamespace(objects=Query([SimpleNamespace(product=SimpleNamespace(id=int(value))) for value in case.get('products',[])])),
            'HyperlocalFdLog':SimpleNamespace(objects=Query([]))}
        if case['method']=='new_order_create_communication':method=function(tasks,case['method'],scope)
        else:method=function(helpers,case['method'],scope,'Helpers')
        method(*case['args'])
        return {'calls':calls,'slack':slack}
    if case['kind']=='round':
        return [round(value,2) for value in case['values']]
    now=real_datetime.datetime.fromisoformat(case['now'])
    class FrozenDateTime(real_datetime.datetime):
        @classmethod
        def now(cls,*_args,**_kwargs):return now
    datetime=SimpleNamespace(datetime=FrozenDateTime,timedelta=real_datetime.timedelta)
    buffer_scope={'datetime':datetime}
    get_buffer=function(helpers,'get_buffer_second',buffer_scope,'Helpers')
    if case['kind']=='arrival':
        order=SimpleNamespace(start_timeslot=real_datetime.datetime.fromisoformat(case['orderStart']),is_split_order=case.get('split',1))
        addon=SimpleNamespace(order_success_timestamp=None)
        slots=Query([SimpleNamespace(start_timeslot=real_datetime.time.fromisoformat(case['slotStart']))] if case.get('slotStart') else [])
        scope={'datetime':datetime,'Order':SimpleNamespace(objects=Query([order])),'OrderAddon':SimpleNamespace(objects=Query([addon])),'PosHyperlocalSlot':SimpleNamespace(objects=slots)}
        advance=function(views,'check_advance_order',scope,'AutoHlOrderView')(None,case['orderId'],case['storeId'])
        jobs=[];notices=[];holds=[]
        async def check_auth(*_args):return True
        async def check_advance(*_args):return advance
        async def hold(*args):holds.append(args)
        async def order_slots(*_args):return order.start_timeslot.date()
        async def audit(*_args):return None
        def notice(*args,**kwargs):notices.append({'args':args,'kwargs':kwargs});return None
        def task(name):return SimpleNamespace(apply_async=lambda **kwargs:jobs.append({'name':name,**kwargs}))
        scope={'datetime':datetime,'JsonResponse':lambda value:value,'asyncio':SimpleNamespace(get_event_loop=lambda:SimpleNamespace(create_task=lambda _value:None)),
            'Helpers':SimpleNamespace(get_buffer_second=get_buffer,get_order_creation_buffer_time=lambda:case.get('buffer',3600)),
            'advance_order_notification':task('advance-notification'),'auto_hl_order_transfer':task('auto-transfer'),
            'HYPERLOCAL_CUT_OFF_SWITCH':case.get('cutoff',True),'HYPERLOCAL_CUT_OFF_TIME':case.get('cutoffTime','17:00'),'logger':SimpleNamespace(info=lambda *_args:None,exception=lambda *_args:None)}
        body=SimpleNamespace(check_auth=check_auth,check_advance_order=check_advance,hold_stock=hold,get_order_slots=order_slots,transaction_logging=audit,order_notification=notice)
        request=SimpleNamespace(POST={'order_id':case['orderId'],'location_id':case['storeId'],'is_notify':case.get('notify',True)},headers={'APPID':'fixture','APPKEY':'fixture-key'})
        result=asyncio.run(function(views,'post',scope,'AutoHlOrderView')(body,request))
        return {'advance':advance[0],'successTimestamp':addon.order_success_timestamp.isoformat(sep=' ') if addon.order_success_timestamp else None,'jobs':jobs,'notices':notices,'holds':holds,'result':result}
    raise ValueError('Unsupported source case')
json.dump([run(case) for case in json.load(sys.stdin)],sys.stdout,ensure_ascii=True)
