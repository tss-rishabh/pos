"""Pinned original shop calculator/template versus the selected-row correction.

Controlled ORM/SELECT results only. No native joins, database or provider calls.
"""
import ast
import base64
from copy import deepcopy
import datetime
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import falcon
from num2words import num2words

ROOT=Path(__file__).resolve().parents[2]
def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
oracle=load(ROOT/'tools/invoice-documents/source-oracle.py','online_oracle_helpers')
builder=load(ROOT/'compatibility/upstream/invoice-documents/prepare.py','express_build')
files=builder.generated_files()
native=ModuleType('pos_invoice_documents_native')
exec(compile(files['pos_invoice_documents_native.py'],'reviewed-native','exec'),native.__dict__)
sys.modules['pos_invoice_documents_native']=native
scoped=ModuleType('pos_invoice_documents_scoped')
exec(compile(files['pos_invoice_documents_scoped.py'],'reviewed-scoped','exec'),scoped.__dict__)

class Field:
    def __init__(self,name):self.name=name
    def __eq__(self,value):return (self.name,value)
class Query:
    def __init__(self,reader,model):self.reader=reader;self.table=model.__tablename__;self.filters={}
    def filter(self,*conditions):
        for condition in conditions:
            if isinstance(condition,tuple):self.filters[condition[0]]=condition[1]
        return self
    def filter_by(self,**values):self.filters.update(values);return self
    def first(self):
        if self.table=='orders':return SimpleNamespace(**deepcopy(self.reader.order))
        if self.table=='has_addresses':return SimpleNamespace(firstname='Fixture',lastname='Person',address1='Fixture road',address2='',address3='',address4='',flat='',city='Fixture city',postcode='000000',phone_no='0000000000',zone_id=1,country_id=1)
        if self.table=='order_stores':
            rows=[row for row in self.reader.mappings if all(row.get(key)==value for key,value in self.filters.items())]
            return SimpleNamespace(**deepcopy(rows[0])) if rows else None
        if self.table=='stores':
            return SimpleNamespace(id=self.filters.get('id',1),category='IN_HOUSE',franchise_id=None,cin_number='',address='Fixture store',gstin='GSTIN-STORE-'+str(self.filters.get('id',1)),gst_arn='ARN-FIXTURE',email='fixture@example.test',phone='0000000000',store_name='Fixture store',short_name='FX')
        return None
class Reader(oracle.Reader):
    def __init__(self,order,rows,points,gifts,mappings):
        super().__init__(order,rows);self.points=points;self.gifts=gifts;self.mappings=mappings
    def execute(self,statement,parameters=None):
        query=' '.join(str(statement).lower().split())
        if 'from order_point_cashback' in query:
            selected={int(value) for value in scoped.selected_ids()} if 'has_product_id in (' in query else None
            return oracle.Result([{'total_hp_point_credited':sum(amount for identifier,amount in self.points if selected is None or identifier in selected)}])
        if 'from gift_vouchers' in query:
            selected={int(value) for value in scoped.selected_ids()} if 'hp.id in (' in query else None
            return oracle.Result([row for row in self.gifts if selected is None or row['fixture_hp_id'] in selected])
        return super().execute(statement,parameters)
    def query(self,model):return Query(self,model)
    def expunge(self,_value):pass

def execute(code,rows,selected,mappings,points,gifts,store_discount,corrected):
    order={'id':12345,'user_id':777,'has_address_id':1,'is_new_calculation':3,'pay_amt':150.75,'fraction_value':0.25,'cod_charges':0,'gifting_charges':0,'shipping_amt':0,'hl_charges':0,'express_charges':4,'coupon_amt_used':0,'tss_points_used':0,'tss_money_used':0,'voucher_amt_used':0,'voucher_used':0,'coupon_used':0,'parent_order_id':0,'zone_id':'Maharashtra','courier':1,'payment_method':3,'ref_flag':0,'created_at':datetime.datetime(2026,11,16,10),'order_ref_no':'FIXTURE-EXPRESS','store_disc_pg':store_discount}
    reader=Reader(order,rows,points,gifts,mappings)
    renderer=oracle.Templates({'Invoicer/index-shop.html':oracle.source('templates/Invoicer/index-shop.html')})
    models={}
    for name,table in [('OrderModel','orders'),('OrderStoreModel','order_stores'),('StoreModel','stores'),('Address','has_addresses'),('PosFranchise','pos_franchise'),('PosTerminalTransaction','pos_terminal_transactions'),('Coupon','coupons')]:
        models[name]=type(name,(),{'__tablename__':table,**{key:Field(key) for key in ['id','order_id','store_id','is_active','platform']}})
    namespace={'math':math,'num2words':num2words,'SessionR':scoped.SelectedReader(reader) if corrected else reader,'text':lambda value:value,'logger':SimpleNamespace(**{key:lambda *_args,**_kwargs:None for key in ['debug','info','warning','error']}),'template_env':renderer,'falcon':falcon,'settings':SimpleNamespace(POS_INVOICE_KEY='fixture-key',NPS_HOST_URL='https://feedback.example.test',SKIP_COMPLEMENTARY_PRODUCT_STATUSES=['CANCELLED']),'FREEBIE_PRODUCT_TYPE':4,'selected_ids':scoped.selected_ids,'selected_rows':scoped.selected_rows,'selected_is_split':scoped.selected_is_split,'selected_store_id':scoped.selected_store_id,'require_invoice_scope':lambda *_args:{'service_key':'fixture-key'},'feedback_url':lambda _id:'https://feedback.example.test','clear_invoice_scope':lambda:None,'stamp_invoice_response':lambda *_args:None,'create_token':lambda *_args:(b'fixture-only',None),**models}
    definitions=ast.Module(body=[node for node in ast.parse(code).body if isinstance(node,(ast.FunctionDef,ast.ClassDef))],type_ignores=[])
    exec(compile(definitions,'pinned-selected-shop','exec'),namespace)
    namespace['get_base64_barcode']=lambda _id:'data:image/png;base64,aA=='
    namespace['generate_qr_base64']=lambda _url:'data:image/png;base64,aA=='
    value={'ids':[str(identifier) for identifier in selected],'storeId':'1','is_split':len(selected)<len({row['rowid'] for row in rows})}
    token=scoped._active.set(value)
    try:
        parameters={'order_id':'12345','pos_token':'fixture-key','has_product_ids':','.join(map(str,selected))}
        request=SimpleNamespace(context={'session':reader,'session_r':reader},get_param=lambda name:parameters.get(name))
        response=SimpleNamespace(text=None,content_type=None)
        namespace['PosInvoiceShop']().on_get(request,response)
        return {'html':response.text,'context':renderer.context}
    finally:scoped._active.reset(token)

def run():
    original=oracle.source('controllers/InvoiceController.py');candidate=files['controllers/PosExpressInvoiceController.py'];normal_mapping={'id':1,'order_id':12345,'store_id':1,'counter_id':3,'order_invoice':'FIXTURE/1','offline_payment':0,'offline_payment_recieved':0,'online_payment':150,'online_other_payment':0}
    cases=[]
    vectors=[('same-store-duplicate-SKU',[oracle.line(201,order_id=12345,order_platform_id=5),oracle.line(202,order_id=12345,order_platform_id=5)],[201,202],[normal_mapping],[(201,1),(202,2)],[],0,True),('split-distinct-SKU',[oracle.line(201,order_id=12345,order_platform_id=5),oracle.line(202,order_id=12345,prod_id=67,order_platform_id=5)],[201],[normal_mapping],[(201,1)],[],0,True),('split-SKU-privacy',[oracle.line(201,order_id=12345,qty=1,price=50,pre_gst_amt=47.62,store_disc_pg=5,order_platform_id=5),oracle.line(202,order_id=12345,qty=2,price=100,pre_gst_amt=95.24,store_disc_pg=50,order_platform_id=5)],[201],[{**normal_mapping,'store_id':2,'order_invoice':'FOREIGN/2'},normal_mapping],[(201,1),(202,99)],[{'fixture_hp_id':202,'gift_voucher_id':99,'order_platform_id':5,'voucher_initial_value':500}],55,False)]
    for name,rows,selected,mappings,points,gifts,discount,equal in vectors:
        old=execute(original,rows,selected,mappings,points,gifts,discount,False);new=execute(candidate,rows,selected,mappings,points,gifts,discount,True)
        if equal and old['html']!=new['html']:raise AssertionError('Source-normal selected invoice output changed')
        context=new['context']
        cases.append({'name':name,'sameHtml':old['html']==new['html'],'sourceHash':hashlib.sha256(old['html'].encode()).hexdigest(),'candidateHash':hashlib.sha256(new['html'].encode()).hexdigest(),'sourceQuantity':old['context']['additional']['total_items'],'selectedQuantity':context['additional']['total_items'],'sourcePrice':old['context']['additional']['cart_total'],'selectedPrice':context['additional']['cart_total'],'sourcePoints':old['context']['discount_points'],'selectedPoints':context['discount_points'],'sourceGiftRows':len(old['context']['gift_vouchers']),'selectedGiftRows':len(context['gift_vouchers']),'selectedGstin':context['additional']['gstin'],'selectedStoreDiscount':context['order'].store_disc_pg,'additional':context['additional'],'html':new['html']})
    return {'sourceCommit':oracle.PIN,'scope':'literal original shop methods/full template and selected candidate on controlled query results; not provider qualification','cases':cases}

if __name__=='__main__':print(json.dumps(run(),default=str))
