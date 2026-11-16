"""Execute selected original checkout methods without importing Django or making I/O."""
import ast
import datetime
import json
from pathlib import Path
from types import SimpleNamespace
import sys

ROOT = Path(__file__).resolve().parents[4] / 'backend-pos-web'


def selected_class(file, name, methods):
    source = (ROOT / file).read_text()
    original = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == name)
    node = ast.ClassDef(name=name, bases=[], keywords=[], decorator_list=[], body=[n for n in original.body if isinstance(n, ast.FunctionDef) and n.name in methods])
    return compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(ROOT / file), 'exec')


class Captured(dict):
    def json(self): return dict(self)


class Query:
    def __init__(self, value=None, count=0): self.value, self.number = value, count
    def first(self): return self.value
    def exists(self): return self.number > 0
    def count(self): return self.number


def payloads():
    api = 'https://api.example.test/'
    scope = {'MIGRATION_TO_API_V2': True, 'MAIN_API_V2_URL': api, 'API_V2_URL': api, 'PAYMENT_MICROSERVICE_ORDER_URL': api + 'payment-confirm',
             'requests': SimpleNamespace(post=lambda url, **kwargs: Captured(path=url.removeprefix(api), payload=kwargs['json'])),
             'redis_instance': SimpleNamespace(get=lambda key: None), 'MUser': SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(SimpleNamespace(id=777))))}
    classes = {'AjaxWalletView': ['wallet'], 'AjaxPgDiscountView': ['pg_disc'], 'AjaxStoreDiscountPGView': ['store_disc_pg'], 'AjaxaExclusiveBenefitsView': ['store_exclusive'], 'AjaxGiftVoucherView': ['gift_voucher'], 'AjaxCouponView': ['coupon'], 'AjaxSyncCartView': ['sync_cart'], 'AjaxOrderView': ['order', 'orders']}
    for name, methods in classes.items(): exec(selected_class('order/views.py', name, methods), scope)
    output = []
    for end_user in (False, True):
        cart = {'products': {'items': []}}
        output += [scope['AjaxWalletView']().wallet('fixture', 1, 2, end_user, cart, 1, 0, 12.34, 1),
                   scope['AjaxPgDiscountView']().pg_disc('fixture', 1, 2, end_user, cart, 25.5, 1),
                   scope['AjaxStoreDiscountPGView']().store_disc_pg('fixture', 1, 2, end_user, cart, 13.25, 0),
                   scope['AjaxaExclusiveBenefitsView']().store_exclusive('fixture', 1, 2, end_user, 1),
                   scope['AjaxGiftVoucherView']().gift_voucher('fixture', 1, 2, end_user, 'GC-fixture', '123456'),
                   scope['AjaxCouponView']().coupon('fixture', 1, 2, end_user, cart, 'COUPON'),
                   scope['AjaxOrderView']().order('fixture', 1, 2, 'coc', 44, end_user, counter_id=3, gc_data={}),
                   scope['AjaxOrderView']().order('fixture', 1, 2, 'prepaid', 44, end_user, counter_id=3, gc_data={}),
                   scope['AjaxOrderView']().orders('fixture', 5001, 'coc', True, 'Fixture', 1)]
    output.append(scope['AjaxSyncCartView']().sync_cart({'products': {'items': []}}, 'target-token', 1, 2))
    return output


def helpers(cases):
    scope = {'datetime': datetime}
    exec(selected_class('helpers/helpers.py', 'Helpers', ['get_financial_year', 'get_transaction_id']), scope)
    fiscal = [scope['Helpers'].get_financial_year(datetime.datetime.fromisoformat(value)) for value in cases['dates']]
    identifiers = []
    for case in cases['transactions']:
        scope['PosTerminalTransaction'] = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(count=case['pine'])))
        scope['PosPaytmTransaction'] = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(count=(1 if case['active'] else 0) if kwargs.get('is_active') else case['paytm'])))
        identifiers.append(scope['Helpers'].get_transaction_id(case['orderId'], case['reference']))
    return {'fiscal': fiscal, 'transactions': identifiers}


def refunds(cases):
    scope = {'json': json, 'HttpResponse': lambda body, **kwargs: json.loads(body), 'messages': SimpleNamespace(error=lambda *args: None)}
    exec(selected_class('order/views.py', 'AjaxGetPayAmtView', ['post']), scope)
    output = []
    for case in cases:
        order = SimpleNamespace(payment_methods_id=3 if case['prepaid'] else 14, parent_order_id=1 if case['exchangeOrder'] else 0, is_parent_express=False)
        amount = SimpleNamespace(amount_to_be_refunded=case['amount'], tss_money_used=case['walletUsed'], gift_voucher_amount=case['giftVoucherUsed'])
        scope['Order'] = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(order)))
        scope['AmountToBeRefundedLog'] = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(amount)))
        request = SimpleNamespace(POST={'product_id': '1001', 'order_id': '5001'}, user=SimpleNamespace(role=1 if case['superAdmin'] else 5))
        output.append(scope['AjaxGetPayAmtView']().post(request))
    return output


def terminal_payloads():
    calls, checksums = [], []
    machine = SimpleNamespace(imei_no='fixture-imei', merchant_store_pos_code='fixture-store', merchant_id='fixture-merchant', security_token='fixture-secret', client_id='fixture-client', merchant_key='fixture-key-1234', paytm_mid='fixture-mid', paytm_tid='fixture-tid', channel_id='fixture-channel')
    def post(url, **kwargs):
        calls.append({'path': url.removeprefix('https://provider.example.test/'), 'payload': kwargs.get('json') or json.loads(kwargs['data'])})
        return SimpleNamespace(status_code=200, json=lambda: {'ResponseCode': 2, 'ResponseMessage': 'FIXTURE', 'PlutusTransactionReferenceID': 'PLUTUS', 'body': {'resultInfo': {'resultCodeId': '0002'}}}, text='fixture')
    def signature(body, key):
        checksums.append(body)
        return 'fixture-checksum'
    noop=lambda *args, **kwargs: None
    scope={'requests':SimpleNamespace(post=post), 'json':json,'datetime':SimpleNamespace(datetime=SimpleNamespace(now=lambda:datetime.datetime(2026,11,16,12,0,0))), 'PINELAB_URL':'https://provider.example.test/','AUTO_CANCEL_DURATION_IN_MINUTES':5,'PAYTM_UAT_URL':'https://provider.example.test','PAYTM_PROD_URL':'https://provider.example.test','logger':SimpleNamespace(debug=noop,info=noop,warning=noop,error=noop), 'paytmchecksum':SimpleNamespace(generateSignature=signature)}
    scope['PosMachine']=scope['PosPaytmMachine']=SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs:Query(machine)))
    scope['PosTerminalTransaction']=SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs:Query(SimpleNamespace(store_pos_code='fixture-store'))))
    exec(selected_class('helpers/terminal_helpers.py','TerminalHelper',['upload_billed_transaction','get_transaction_status','cancel_transaction']),scope)
    exec(selected_class('helpers/terminal_helpers.py','PaytmHelper',['create_paytm_checksum','create_paytm_payment_request']),scope)
    helper=scope['TerminalHelper']
    helper.upload_billed_transaction('FIXTURE8002',59.95,40,100,'fixture',1,8002,1,44,payment_mode_id=1)
    helper.get_transaction_status('FIXTURE8002',59.95,40,100,'PLUTUS',8002,1,44)
    for force in (False,True):helper.cancel_transaction('FIXTURE8002',59.95,40,100,'PLUTUS',8002,1,44,force=force)
    for mode in ('CARD','QR'):scope['PaytmHelper'].create_paytm_payment_request('FIXTURE8002',59.95,40,100,'fixture',1003 if mode=='CARD' else 1004,8002,1,44,paytm_payment_mode=mode,payment_mode_id=2)
    return {'calls':calls,'checksums':checksums}


def inbound_payloads():
    captured=[]
    def request(method,url,**kwargs):
        captured.append(json.loads(kwargs['data']['RequestBody']))
        return SimpleNamespace(status_code=200,text='fixture',json=lambda:{'responseMessage':'Success','requestStatus':{'status':'Success'}})
    noop=lambda *args,**kwargs:None
    scope={'json':json,'DjangoJSONEncoder':json.JSONEncoder,'requests':SimpleNamespace(request=request),'VINCULUM_RETURN_URL':'https://warehouse.example.test/','VINCULUM_TRANSPORTER_CODE':'fixture-transporter','VINCULUM_API_OWNER':'fixture-owner','VINCULUM_API_KEY':'fixture-key','logger':SimpleNamespace(info=noop,warning=noop)}
    exec(selected_class('helpers/helpers.py','Helpers',['create_return_at_vinculum']),scope)
    for exchange in (False,True):scope['Helpers'].create_return_at_vinculum(location_code='FST1',order_id=9001,tracking_no=9001,return_date='16/11/2026 12:00:00',customer_name='Fixture',customer_address1='Fixture address',customer_address2='',customer_state=19,customer_city='Fixture city',customer_pincode='400001',customer_email='',remarks='Size issue:Fixture',sku=10,has_product_id=9101,return_qty=2,return_reason='Size issue',category='Replacement' if exchange else None)
    return captured


def exchange_payload():
    tree=ast.parse((ROOT/'order/views.py').read_text())
    original=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='AjaxProductExchangeView')
    value=next(node.value for node in ast.walk(original) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='exchange_api_payload' for target in node.targets))
    scope=dict(order_id=9001,has_prod_id=9101,old_prod_id=10,new_prod_id=11,exchange_parent_prod_id=100,new_size='L',store_id=1,counter_id=3,saleable=0,reason_id=1,sub_reason_id=0,comment='Fixture',admin_user_id=777,salesperson_id=5)
    return eval(compile(ast.fix_missing_locations(ast.Expression(value)),str(ROOT/'order/views.py'),'eval'),scope)


def discount_policy(cases):
    captured, output = [], []
    scope = {'Store': SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: Query(SimpleNamespace(store_name='Fixture')))),
             'redis_instance': SimpleNamespace(exists=lambda key: False), 'tasks': SimpleNamespace(send_pg_disc_otp=lambda *args: captured.append(args)), 'JsonResponse': lambda data: data}
    exec(selected_class('order/views.py', 'AjaxPGDiscOTPSend', ['post']), scope)
    for case in cases:
        scope.update(PG_DISC_STORE_MANAGER_PERCENTAGE=case['thresholds'], SEND_OTP_TO_ALL_MANAGERS=case['sendAll'])
        request = SimpleNamespace(POST={'user_id':'44','tab_id':'1','store_id':case['storeId'],'counter_id':'3','pg_discount':case['amount'],'total_amount':case['productsTotal'],'user_name':'Fixture'})
        result = scope['AjaxPGDiscOTPSend']().post(request)
        emails = captured[-1][-1] or []
        output.append({'emails': emails, 'fallback': not emails and bool(case['sendAll']), 'exempt': result['status'] == 202})
    return output


def gift_cart_controls():
    captured=[]
    api='https://api.example.test/'
    scope={'MIGRATION_TO_API_V2':True,'MAIN_API_V2_URL':api,'API_V2_URL':api,'CreateOrderView':SimpleNamespace(get_user_cart=lambda *args,**kwargs:{'products':{'items':[]}}),'requests':SimpleNamespace(post=lambda url,**kwargs:Captured(path=url.removeprefix(api),payload=kwargs['json']))}
    exec(selected_class('order/views.py','AjaxCartView',['delete_from_cart','add_to_cart']),scope)
    for customer in (False,True):
        view=scope['AjaxCartView']()
        for platform in ('remove-coupon','remove-gf'):captured.append(view.delete_from_cart('fixture',0,1,2,platform,0,customer))
        captured.append(view.add_to_cart('fixture',10,1,'8900000000010',2,customer,{'gvprice':1234}))
    return captured


def order_sms_payload():
    source=(ROOT/'core/tasks.py').read_text()
    node=next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=='send_sms')
    node.decorator_list=[]
    captured=[]
    scope={'MIGRATION_TO_API_V2':True,'MAIN_API_V2_URL':'https://api.example.test/','API_V2_URL':'https://api.example.test/','requests':SimpleNamespace(post=lambda url,**kwargs:(captured.append({'url':url,'payload':kwargs['json']}) or SimpleNamespace(status_code=200)))}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),str(ROOT/'core/tasks.py'),'exec'),scope)
    scope['send_sms'](8401)
    return captured


def customer_registration_payloads():
    captured=[]
    def post(url, **kwargs):
        captured.append({'path':url.removeprefix('https://api.example.test/'),'payload':kwargs['json']})
        return SimpleNamespace(status_code=200,json=lambda:{'user_id':88001})
    scope={'json':json,'HttpResponse':lambda body,**kwargs:json.loads(body),'MIGRATION_TO_API_V2':True,'MAIN_API_V2_URL':'https://api.example.test/','API_V2_URL':'https://api.example.test/','requests':SimpleNamespace(post=post),'Q':lambda **kwargs:kwargs,'MUser':SimpleNamespace(objects=SimpleNamespace(filter=lambda *args,**kwargs:Query()))}
    exec(selected_class('order/views.py','AjaxUserRegisterView',['post','user_register']),scope)
    for email,kind,gstin in [('', 'B2C', ''),('fixture@example.com','B2B','29ABCDE1234F1Z5')]:
        view=scope['AjaxUserRegisterView']()
        view.verify_otp=lambda *args:True
        request=SimpleNamespace(POST={'name':'Fixture Customer','mobile':'9000000001','email':email,'dob':'1990-01-02','customer_type':kind,'gstin':gstin,'store_id':'1','platform':'VERIFY','otp':'111111','self_verify':'0'})
        view.post(request)
    return captured


def registration_otp_payloads():
    captured=[]
    def get(url,**kwargs):
        captured.append({'url':url,'payload':kwargs['params']})
        return SimpleNamespace(text='success | fixture')
    noop=lambda *args,**kwargs:None
    scope={'requests':SimpleNamespace(get=get),'logger':SimpleNamespace(info=noop,error=noop,exception=noop),'random':SimpleNamespace(randint=lambda *args:1),'redis_instance':SimpleNamespace(exists=lambda key:False,set=noop),'LOGIN_OTP_EXPIRY':600,'WHATSAPP_OTP_FALLBACK_DELAY_TIME':20,'GUPSHUP_SMS_USER_ID':'fixture-sms-user','GUPSHUP_SMS_PASSWORD':'fixture-sms-secret','GUPSHUP_WHATSAPP_USER_ID':'fixture-wa-user','GUPSHUP_WHATSAPP_PASSWORD':'fixture-wa-secret','WHATSAPP_GUPSHUP_API_URL':'https://whatsapp.example.test/'}
    exec(selected_class('helpers/helpers.py','Helpers',['send_via_whatsapp']),scope)
    scope['Helpers']._mask_phone=noop
    scope['Helpers'].spawn_whatsapp_otp_fallback=noop
    exec(selected_class('order/views.py','AjaxUserRegisterView',['send_otp']),scope)
    scope['AjaxUserRegisterView']().send_otp('9000000001')
    scope['Helpers'].send_via_whatsapp('111111','9000000001')
    return captured


def clear_customer_state():
    deleted=[]
    scope={'json':json,'HttpResponse':lambda body,**kwargs:json.loads(body),'MUser':SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs:Query(SimpleNamespace(id=777)))),'redis_instance':SimpleNamespace(delete=lambda key:deleted.append(key),scan_iter=lambda pattern:['1_2','1_2_10'])}
    exec(selected_class('order/views.py','AjaxCartView',['post']),scope)
    view=scope['AjaxCartView']()
    request=SimpleNamespace(POST={'product_id':'0','store_id':'1','tab_id':'2','qty':'0','opr':'clear','user_id':'1001','auth_token':'fixture','end_user':'1'},user=SimpleNamespace(id=44))
    view.request=request
    view.clear_cart=lambda *args,**kwargs:SimpleNamespace(status_code=200,json=lambda:{'products':{'items':[]},'giftvouchers':{'items':[]}})
    result=view.post(request)
    return {'deleted':deleted,'status':result['status'],'count':result['extra']['total_item_cart']}


if __name__ == '__main__':
    data = json.load(sys.stdin)
    if data['operation'] == 'payloads': result = payloads()
    elif data['operation'] == 'helpers': result = helpers(data)
    elif data['operation'] == 'refunds': result = refunds(data['cases'])
    elif data['operation'] == 'terminal_payloads': result = terminal_payloads()
    elif data['operation'] == 'inbound_payloads': result = inbound_payloads()
    elif data['operation'] == 'exchange_payload': result = exchange_payload()
    elif data['operation'] == 'discount_policy': result = discount_policy(data['cases'])
    elif data['operation'] == 'gift_cart_controls': result = gift_cart_controls()
    elif data['operation'] == 'order_sms_payload': result = order_sms_payload()
    elif data['operation'] == 'customer_registration_payloads': result = customer_registration_payloads()
    elif data['operation'] == 'registration_otp_payloads': result = registration_otp_payloads()
    elif data['operation'] == 'clear_customer_state': result = clear_customer_state()
    else: raise ValueError('Unsupported oracle operation')
    json.dump(result, sys.stdout, allow_nan=False)
