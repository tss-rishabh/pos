"""Execute actual source scheduled report methods against in-memory protocol fixtures only."""
import ast
import datetime as real_dt
import json
from pathlib import Path
from types import SimpleNamespace
import sys
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/views.py'
tree=ast.parse(source.read_text());cases=json.load(sys.stdin)['cases'];results=[]
availability_class=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='HyperlocalAvailabilityReport')
availability_method=next(node for node in availability_class.body if isinstance(node,ast.FunctionDef) and node.name=='get_count')
availability_start=next(index for index,node in enumerate(availability_method.body) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='store_fault' for target in node.targets))
availability_reduce=ast.FunctionDef(name='reduce_availability',args=ast.arguments(posonlyargs=[],args=[ast.arg(arg='data')],kwonlyargs=[],kw_defaults=[],defaults=[]),body=availability_method.body[availability_start:],decorator_list=[])
availability_scope={};exec(compile(ast.fix_missing_locations(ast.Module(body=[availability_reduce],type_ignores=[])),str(source),'exec'),availability_scope)
class Query(list):
    def using(self,*args):return self
    def filter(self,**kwargs):
        def matches(row):
            for key,value in kwargs.items():
                field,*operation=key.split('__');actual=getattr(row,field,None);operation=operation[0] if operation else 'eq'
                if operation=='eq' and actual!=value:return False
                if operation=='in' and actual not in value:return False
                if operation=='gt' and (actual is None or actual<=value):return False
                if operation=='gte' and (actual is None or actual<value):return False
                if operation=='lte' and (actual is None or actual>value):return False
            return True
        return Query(row for row in self if matches(row))
    def exclude(self,**kwargs):
        removed=self.filter(**kwargs);return Query(row for row in self if row not in removed)
    def count(self):return len(self)
    def exists(self):return bool(self)
    def first(self):return sorted(self,key=lambda row:getattr(row,'id',0))[0] if self else None
    def values_list(self,field,flat=False):return Query(getattr(row,field) if flat else (getattr(row,field),) for row in self)
for case in cases:
    now=real_dt.datetime.fromisoformat(case['now'].replace('Z','+00:00'));local=now.astimezone(real_dt.timezone(real_dt.timedelta(hours=5,minutes=30))).replace(tzinfo=None)
    class Clock(real_dt.datetime):
        @classmethod
        def now(cls,*args):return local
        @classmethod
        def today(cls):return local
        @classmethod
        def utcnow(cls):return now.replace(tzinfo=None)
    sent=[];updates=[]
    helpers=SimpleNamespace(check_report_api_key=lambda _:None,slack_text_notification=lambda text:sent.append({'target':'main','text':text}),slack_demo_server_text_notification=lambda text:sent.append({'target':'demo','text':text}))
    scope={'datetime':SimpleNamespace(datetime=Clock,timedelta=real_dt.timedelta),'json':json,'Helpers':helpers,'HttpResponse':lambda value,**kwargs:json.loads(value),'DAYS_BEFORE_FOR_MIN_MAX':1,'READ_DB_ALIAS':'fixture'}
    kind=case['kind'];classname={'hyperlocal-performance':'StoreHyperlocalRecord','hyperlocal-summary':'HyperlocalSlackReport','hyperlocal-store-status':'HyperlocalStoreStatusReport','hyperlocal-availability':'HyperlocalAvailabilityReport','hyperlocal-delivery-delays':'HyperlocalDeliveryReport','hyperlocal-cancellations':'HyperlocalCancellationReport','crm-tickets':'CrmTicketStatus'}[kind]
    original=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==classname)
    methods=[node for node in original.body if isinstance(node,ast.FunctionDef) and node.name in ['get','get_time_for_min_max','update_decline_count']]
    node=ast.ClassDef(name=classname,bases=[],keywords=[],body=methods,decorator_list=[])
    def objects(name,records):scope[name]=SimpleNamespace(objects=Query(SimpleNamespace(**value) for value in records))
    stores=[{'id':int(value['id']),'store_name':value['name'],'type':value['type']} for value in case.get('stores',[])];slots=[{'id':int(value['id']),'store_id':int(value['storeId']),'weekday':value['weekday'],'is_avail':int(value['available']),'start_timeslot':real_dt.time.fromisoformat(value['start']),'end_timeslot':real_dt.time.fromisoformat(value['end'])} for value in case.get('slots',[])]
    objects('Store',stores);objects('PosHyperlocalSlot',slots)
    if kind=='hyperlocal-summary':
        orders=[];logs=[]
        for index,row in enumerate(case['rows']):
            orders.append({'id':int(row['orderId']),'location_id':int(row['storeId']),'location_type':'SW','created_at':local.replace(hour=0,minute=0,second=0)-real_dt.timedelta(days=1),'order_statuses':3,'is_transfer':row['isTransfer'],'next_location_ids':json.dumps([int(value) for value in row['nextStoreIds']])})
            logs.append({'id':index+1,'order_id':int(row['orderId']),'updated_at':local.replace(hour=12,minute=0,second=0)-real_dt.timedelta(days=1),'action':row['action'],'main_location_id':int(row['mainStoreId']) if row['mainStoreId'] else None})
        objects('Order',orders);objects('HyperlocalOrderLog',logs)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),str(source),'exec'),scope);instance=scope[classname]()
    request=SimpleNamespace(GET={key:str(int(value)) for key,value in {'no_of_previous_days':case.get('previousDays',1),'send_report_to_slack':case.get('sendToSlack',True),'include_completed_ticket':case.get('includeCompleted',False)}.items()})
    if kind=='hyperlocal-performance':
        records=[{'CreatedAt':Clock.fromisoformat(row['createdAt']),'AcceptedAt':Clock.fromisoformat(row['acceptedAt']),'StoreID':int(row['storeId']) if row['storeId'] else None,'StoreName':row['storeName']} for row in case['rows']];availability={}
        for slot in slots:availability.setdefault(slot['store_id'],{})[slot['weekday']]={'start_timeslot':slot['start_timeslot'],'end_timeslot':slot['end_timeslot']}
        instance.get_data=lambda **_: (records,availability)
    elif kind=='hyperlocal-delivery-delays':instance.get_data=lambda **_: [{'OrderId':row['orderId'],'TotalDelay':row['totalDelay']} for row in case['rows']]
    elif kind=='hyperlocal-cancellations':instance.get_data=lambda **_: [{'StoreName':row['storeName'],'OrderID':row['orderId'],'Reason':row['reason'],'Comment':row['comment'],'ConvertedAt':Clock.fromisoformat(row['convertedAt'])} for row in case['rows']]
    elif kind=='hyperlocal-availability':
        valid=[row for row in case['rows'] if row['cartType']=='VALID' and row['storeAvailability']=='NOT_GUILTY' and row['stockThreshold']=='NOT_GUILTY' and row['slotVisible']]
        def counts(*_):
            groups={}
            for row in case['rows']:
                key=(row['cartType'],row['stockThreshold'],row['storeAvailability'],int(row['slotVisible']))
                value=groups.setdefault(key,{'count':0,'cart_type':key[0],'stock_threshold':key[1],'store_availability':key[2],'is_slot_visible':key[3],'order_ids':''})
                value['count']+=1;value['order_ids']+=(',' if value['order_ids'] else '')+row['orderId']
            return availability_scope['reduce_availability'](list(groups.values()))
        instance.get_count=counts
        platform={int(row['orderId']):row['isApp'] for row in case['orders']+case['rows']}
        instance.get_platform_count_by_id=lambda ids:(sum(platform.get(int(value),False) for value in set(ids) if str(value).isdigit() and int(value) in platform),sum(not platform.get(int(value),False) for value in set(ids) if str(value).isdigit() and int(value) in platform))
        objects('Order',[{'id':int(row['orderId']),'location_id':2,'location_type':'SW','created_at':local.replace(hour=12,minute=0,second=0)-real_dt.timedelta(days=1),'order_statuses':3} for row in case['orders']])
    elif kind=='crm-tickets':
        status={'NEW':0,'OPEN':2,'PENDING':3,'RESOLVED':4,'CLOSED':5,'UNKNOWN':99};tickets={row['ticketId']:row for row in case['rows']}
        instance.crm_ticket_details=lambda **_: [{'order_id':row['orderId'],'fd_ticket_id':row['ticketId']} for row in case['rows']]
        instance.ticket_data_update_sql=lambda ticket,current,age:updates.append({'ticketId':ticket,'status':current,'age':str(age)})
        scope.update({'FRESHDESK_TICKET_URL':'https://fixture.example.test/tickets','FRESHDESK_BASIC_AUTH_USERNAME':'fixture','FRESHDESK_BASIC_AUTH_PASSWORD':'fixture','requests':SimpleNamespace(get=lambda url,**_:SimpleNamespace(json=lambda:{'status':status[tickets[url.rsplit('/',1)[1]]['status']],'created_at':tickets[url.rsplit('/',1)[1]]['createdAt']}))})
    instance.get(request);results.append({'messages':sent,'updates':updates})
json.dump(results,sys.stdout)
