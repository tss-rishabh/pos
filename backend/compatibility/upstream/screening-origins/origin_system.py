"""Actual CSK authority/reference, source placement and payment recovery.

The original API key is checked by its original validator. It is never used as
a URL, Order transaction/cart secret, customer login token, or fake POS actor.
"""
import ast
import base64
import copy
import hashlib
import hmac
import json
import time
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit,urlunsplit
from uuid import UUID as NativeUUID
from sqlalchemy import text
import requests
from origin_contracts import PROOF,UUID,canonical,digest,fingerprint,identifier,fail
from origin_auth import authority_hash
from origin_ledger import read,insert,creation,payment
from native import one,rows,json_value
from writer_protocol import portable_hash
from origin_effects import seal_effects,open_effects
import origin_history

ACTIVE=ContextVar('screening_external_source_origin',default=None)
SERVICE='pos-screening-origin-system-service-v1'
AUTHORITY='pos-screening-origin-system-authority-v1'
SOURCE_HASH='88c4662949ba0adb6783d0f7a126948e4f7b52ac21ed15b2e7ad975f9a8a6d75'
UTILS_HASH='345681757ba778805bbc8fca0814761fc960409723a41fda03e4502b3c8ac443'


def service_record(api_details,revision,key):
    """Independent configuration publisher input; never called by a request."""
    if not isinstance(api_details,dict) or not isinstance(api_details.get('key'),str) or not api_details['key'] or not str(revision).isdigit() or int(revision)<1:fail('SCREENING_ORIGIN_SERVICE_UNQUALIFIED')
    data={'contract':SERVICE,'id':'csk','revision':str(revision),
          'credentialHash':digest(key,'system-credential',api_details['key']),
          'configurationHash':digest(key,'system-configuration',api_details),
          'sourceController':'controllers.external.OrderPlacement','active':True}
    return {'data':data,'proofHash':digest(key,'system-service',data)}


def current_service(session,key,api_details,lock=True):
    row=one(session,'SELECT id,data,proof_hash,revoked FROM pos_rewrite_screening_origin_services WHERE id=\'csk\' AND OCTET_LENGTH(data)<=16000'+(' FOR SHARE' if lock else ''))
    data=json_value(row['data'])
    if (not isinstance(data,dict) or set(data)!={'contract','id','revision','credentialHash','configurationHash','sourceController','active'}
            or data['contract']!=SERVICE or data['id']!='csk' or data['active'] is not True or row['revoked']!=0
            or data['sourceController']!='controllers.external.OrderPlacement' or not isinstance(data['revision'],str) or not data['revision'].isdigit() or int(data['revision'])<1
            or not hmac.compare_digest(digest(key,'system-service',data),row['proof_hash'])
            or not hmac.compare_digest(data['credentialHash'],digest(key,'system-credential',api_details['key']))
            or not hmac.compare_digest(data['configurationHash'],digest(key,'system-configuration',api_details))):fail('SCREENING_ORIGIN_SERVICE_REVOKED')
    return data


def reference(key,payload):
    raw=payload.get('order',{}).get('order_id')
    if not isinstance(raw,str) or not 1<=len(raw)<=255:fail('SCREENING_ORIGIN_REFERENCE_REQUIRED')
    value=digest(key,'system-reference',{'serviceId':'csk','reference':raw})
    return str(NativeUUID(bytes=bytes.fromhex(value[:32]),version=4)),value


def compile_placement(path,expected_hash,namespace,context):
    """Retain every source financial statement; replace only authority/effects.
    The source service used to create a reusable login JWT solely for its Go
    call. The purpose-specific Go envelope supersedes that unsafe token write.
    """
    raw=Path(path).read_bytes()
    if not expected_hash or hashlib.sha256(raw).hexdigest()!=expected_hash:fail('SCREENING_ORIGIN_SOURCE_UNVERIFIED')
    tree=ast.parse(raw.decode())
    original=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='place_order')
    function=copy.deepcopy(original);token_blocks=0;creation_calls=0;payment_calls=0;secret_references=0
    body=[]
    for node in function.body:
        if isinstance(node,ast.Try) and any(isinstance(call,ast.Call) and isinstance(call.func,ast.Name) and call.func.id in ('create_token','create_token512') for call in ast.walk(node)):
            token_blocks+=1;continue
        # Final metadata is applied transactionally with the job receipt after
        # the genuine Go result, not by replaying the original placement body.
        if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='order_attributes_row' for target in node.targets):continue
        if isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and ast.unparse(node.value.func)=='session.add' and ast.unparse(node.value.args[0])=='order_attributes_row':continue
        body.append(node)
    function.body=body
    class Hooks(ast.NodeTransformer):
        def visit_Call(self,node):
            nonlocal creation_calls,payment_calls
            if ast.unparse(node.func)=='Order().on_post':
                creation_calls+=1;node.func=ast.Name(id='_origin_create',ctx=ast.Load())
            elif ast.unparse(node.func)=='apply_payment':
                payment_calls+=1;node.func=ast.Name(id='_origin_payment',ctx=ast.Load())
            return self.generic_visit(node)
        def visit_Dict(self,node):
            nonlocal secret_references
            literals={key.value:index for index,key in enumerate(node.keys) if isinstance(key,ast.Constant) and isinstance(key.value,str)}
            name=node.values[literals['name']] if 'name' in literals else None
            if isinstance(name,ast.Constant) and name.value=='external_api' and 'key' in literals:
                secret_references+=1
                node.values[literals['key']]=ast.Call(func=ast.Name(id='_origin_service_reference',ctx=ast.Load()),args=[],keywords=[])
            return self.generic_visit(node)
    function=Hooks().visit(function)
    if (token_blocks,creation_calls,payment_calls,secret_references)!=(1,1,1,1):fail('SCREENING_ORIGIN_SOURCE_UNVERIFIED')
    values=dict(namespace)
    values.update(_origin_create=context.create,_origin_payment=context.submit_payment,_origin_service_reference=lambda:context.reference_hash)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),'<pinned-origin-system-placement>','exec'),values)
    return values['place_order']


class Context:
    def __init__(self,owner,command_id,reference_hash,payload,api_details,request,response,attempt_id):
        self.owner,self.command_id,self.reference_hash=owner,command_id,reference_hash
        self.payload,self.api_details,self.req,self.resp=payload,api_details,request,response
        self.cart=None;self.value=None;self.service=None
        self.attempt_id=attempt_id
    def authorize(self,session,req):
        if ACTIVE.get() is not self or req is not self.req:fail('SCREENING_ORIGIN_SERVICE_REQUIRED')
        self.service=current_service(session,self.owner.runtime.key,self.api_details)
        customer=identifier(req.context['user']['user_id'])
        native=one(session,'SELECT id,firstname,lastname,email,telephone,status,is_block,is_disabled,is_two_fa,tss_money,tss_points,cashback,is_cod_enable,fb_id,gender,birthdate FROM users WHERE id=:id FOR UPDATE',{'id':customer})
        if native['status']!=1 or native['is_block'] not in (None,0) or native['is_disabled'] not in (None,0):fail('SCREENING_ORIGIN_AUTH_REQUIRED')
        principal={'origin':'external-system','customerId':customer,'actorId':None,'storeId':None,'counterId':None,
            'serviceId':'csk','serviceRevision':self.service['revision'],'credentialHash':self.service['credentialHash'],
            'configurationHash':self.service['configurationHash'],
            'identityHash':digest(self.owner.runtime.key,'system-customer',{'id':customer,'email':native['email'],'telephone':native['telephone'],
                'status':native['status'],'isBlock':native['is_block'],'isDisabled':native['is_disabled'],'isTwoFa':native['is_two_fa']})}
        return native,principal,None
    def namespace(self):return 'external:csk:'+self.reference_hash
    def cart_hash(self):
        from system_preparation import copied
        return portable_hash(copied(self.cart.simple_obj(apply_wrappers_flag=False)))
    def assert_running(self,session,command):
        from system_preparation import assert_attempt
        assert_attempt(session,self)
        row=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR UPDATE',{'id':self.command_id})
        value=json_value(row['data'])
        if (value.get('commandId')!=self.command_id or value.get('state')!='SOURCE_RUNNING' or value.get('referenceHash')!=self.reference_hash
                or value.get('requestHash')!=portable_hash(self.payload) or not hmac.compare_digest(digest(self.owner.runtime.key,'system-job',value),row['proof_hash'])):fail('SCREENING_ORIGIN_SOURCE_DISPATCH_CLOSED')
        authority=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_authorities WHERE command_id=:id FOR SHARE',{'id':self.command_id})
        data=json_value(authority['data'])
        if (data.get('commandId')!=self.command_id or data.get('customerId')!=command['customerId'] or data.get('requestHash')!=command['requestHash']
                or data.get('referenceHash')!=command['referenceHash'] or not hmac.compare_digest(digest(self.owner.runtime.key,'system-authority',data),authority['proof_hash'])):fail()
        self.system_authority_hash=authority['proof_hash']
    def create(self,req,resp):
        if req is not self.req or resp is not self.resp or self.value is not None:fail()
        from origin_frame import request_hash,tickets
        self.cart=req.context['cart']
        # The original prefix only registers/updates customer/address/cart.
        # It has no Order yet. Finish that native work before the history HTTP.
        prefix=req.context['session']
        if any(getattr(model,'__tablename__',None) in ('orders','has_products','spiderman_screening_orders') for model in list(prefix.new)+list(prefix.dirty)):fail()
        prefix.commit();prefix.close()
        key=self.owner.runtime.key
        with self.owner.runtime.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,principal,_grant=self.authorize(session,req)
            prior=read(session,self.command_id,principal['customerId'],key)
            if prior is not None:fail('SCREENING_ORIGIN_RECONCILIATION_REQUIRED')
            from system_preparation import assert_attempt,copied
            assert_attempt(session,self)
            quantity=tickets(self.cart)
            if quantity not in (1,2):fail('SCREENING_ORIGIN_LIMIT')
            now=self.owner.runtime.clock();value={'contract':PROOF,'id':self.command_id,'origin':'external-system','customerId':principal['customerId'],
                'actorId':None,'storeId':None,'counterId':None,'namespaceHash':fingerprint(key,'namespace',self.namespace()),
                'requestHash':request_hash(req),'cartHash':self.cart_hash(),'referenceHash':self.reference_hash,'authorityHash':authority_hash(key,principal),
                'quantity':quantity,'lineItemsEnabled':self.owner.runtime.line_items,'markerRows':quantity if self.owner.runtime.line_items else 1,
                'phase':'PREPARED','orderId':None,'lines':[],'markers':[],'creationHash':None,'closureHash':None,
                'version':1,'createdAt':now,'updatedAt':now,'expiresAt':now+600000}
            insert(session,value,key)
            descriptor={'contract':AUTHORITY,'commandId':self.command_id,'customerId':value['customerId'],'requestHash':value['requestHash'],
                'referenceHash':self.reference_hash,'serviceId':'csk','serviceRevision':self.service['revision'],
                'credentialHash':self.service['credentialHash'],'configurationHash':self.service['configurationHash']}
            self.system_authority_hash=digest(key,'system-authority',descriptor)
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_authorities(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),
                {'id':self.command_id,'data':canonical(descriptor),'proof':self.system_authority_hash})
            snapshot=copied({'user':req.context['user'],'requestData':req.context['data'],'cart':self.cart.get_snapshot(),
                             'accessRoute':req.access_route,'originalPayload':self.payload})
            payload=[snapshot];payload_hash=hashlib.sha256(canonical(payload).encode()).hexdigest()
            saved={'contract':'pos-screening-system-preparation-v1','commandId':self.command_id,'customerId':value['customerId'],
                   'authorityHash':value['authorityHash'],'requestHash':value['requestHash'],'cartHash':value['cartHash'],
                   'referenceHash':value['referenceHash'],'payloadHash':payload_hash,'createdAt':now}
            encrypted=seal_effects(key,'system-preparation:'+self.command_id,payload)
            if len(encrypted)>1400000:fail('SCREENING_ORIGIN_PREPARATION_INVALID')
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_preparations(command_id,customer_id,data,proof_hash,payload,payload_hash) VALUES(:id,:customer,:data,:proof,:payload,:hash)'),
                {'id':self.command_id,'customer':value['customerId'],'data':canonical(saved),'proof':digest(key,'system-preparation',saved),'payload':encrypted,'hash':payload_hash})
        return self.execute_prepared()
    def execute_prepared(self):
        from origin_frame import request_hash
        from system_preparation import assert_attempt
        key=self.owner.runtime.key
        with self.owner.runtime.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,current,_grant=self.authorize(session,self.req)
            value=read(session,self.command_id,current['customerId'],key)
            assert_attempt(session,self)
            if (value is None or value['phase']!='PREPARED' or value['authorityHash']!=authority_hash(key,current)
                    or value['requestHash']!=request_hash(self.req) or value['cartHash']!=self.cart_hash()):fail('SCREENING_ORIGIN_SCOPE_CHANGED')
            witness=origin_history.head(session,value['customerId'])
        coupon_snapshot=None;selections=[];documents=[]
        if self.owner.runtime.coupons is not None:
            coupons=self.owner.runtime.coupons
            coupon_snapshot=coupons.snapshot(value['customerId'])
            from controllers.cart.Cart import ItemTypes
            meta={'items':copy.deepcopy(self.cart.get(ItemTypes.META))}
            with self.owner.runtime.sessions() as session,session.begin():
                session.connection(execution_options={'isolation_level':'READ COMMITTED'})
                _native,principal,_grant=self.authorize(session,self.req)
                if authority_hash(key,principal)!=value['authorityHash'] or read(session,value['id'],value['customerId'],key)!=value:fail()
                assert_attempt(session,self)
                selections=coupons.prepare(session,value,'customer',self.namespace(),coupon_snapshot,cart_meta=meta)
            documents=[self.owner.runtime.coupon_history_provider.read(coupons.request(value,item)) for item in selections]
        if self.owner.runtime.history_provider is None:fail('SCREENING_ORIGIN_HISTORY_REQUIRED')
        document=self.owner.runtime.history_provider.read(value,witness)
        with self.owner.runtime.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            _native,current,_grant=self.authorize(session,self.req)
            saved=read(session,self.command_id,value['customerId'],key)
            assert_attempt(session,self)
            if saved!=value or authority_hash(key,current)!=value['authorityHash']:fail('SCREENING_ORIGIN_SCOPE_CHANGED')
            origin_history.save(session,value,document,key,self.owner.runtime.clock())
            if self.owner.runtime.coupons is not None:self.owner.runtime.coupons.save(session,value,selections,documents,coupon_snapshot)
        self.value=value
        self.req.origin_headers['X-TSS-Screening-Command']=self.command_id
        self.req.origin_headers['X-TSS-Screening-Origin']='external-system'
        # Invoke the real already-auth-decorated source resource under its
        # distinct system context. The ordinary body/tax/stock helper is intact.
        return self.owner.order.on_post(self.req,self.resp)
    def submit_payment(self,result,_original_user):
        if self.value is None or str(result.get('order'))=='' or result.get('isValid') is not True:fail()
        return self.owner.payment(self.command_id,result,self.api_details)


class Request:
    def __init__(self,original,context):
        self.original,self.context=original,context;self.origin_headers={};self.params={};self.auth=None
        self.access_route=list(getattr(original,'access_route',[]) or [])
    def get_header(self,name):return self.origin_headers.get(name)
    def __getattr__(self,name):return getattr(self.original,name)


class Response:
    def __init__(self):self.text=None;self.status='200 OK';self.headers={}
    @property
    def body(self):return self.text
    @body.setter
    def body(self,value):self.text=value
    def set_header(self,name,value):self.headers[name]=value


class SystemOrders:
    def __init__(self,runtime,namespace,source_file,source_hash,payment_url,clock=None):
        self.runtime,self.namespace=runtime,namespace
        self.source_file,self.source_hash=source_file,source_hash
        self.clock=clock or runtime.clock;self.order=namespace['Order']()
        parsed=urlsplit(payment_url)
        if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:fail('SCREENING_ORIGIN_TRANSPORT_UNQUALIFIED')
        self.payment_base=urlunsplit((parsed.scheme,parsed.netloc,parsed.path.rstrip('/').rsplit('/',1)[0]+'/screening-origins/','',''))
    def authenticate(self,request):
        from controllers.external.external_api_utils import validate_api_key,validate_payload
        supplied=request.get_header('X-CSK-API-Key')
        details=validate_api_key(supplied)
        if not isinstance(details,dict) or not supplied:fail('SCREENING_ORIGIN_SERVICE_REQUIRED')
        with self.runtime.sessions() as session,session.begin():current_service(session,self.runtime.key,details)
        return details
    def on_post(self,req,resp):
        details=self.authenticate(req)
        payload=req.context['data']
        from controllers.external.external_api_utils import validate_payload
        validate_payload(payload,details)
        def secrets(value):
            if isinstance(value,dict):
                for name,item in value.items():
                    if str(name).lower() in ('token','jwt','authorization','api_key','apikey','password','secret','access_token','refresh_token'):fail('SCREENING_ORIGIN_REQUEST_INVALID')
                    secrets(item)
            elif isinstance(value,list):
                for item in value:secrets(item)
        secrets(payload)
        if not any(str(line.get('sku_id'))=='390238' for line in payload['order']['line_items']):fail('SCREENING_ORIGIN_NOT_SCREENING')
        command,reference_hash=reference(self.runtime.key,payload);request_hash=portable_hash(payload)
        from origin_effects import seal_effects
        import ipaddress
        access=list(req.access_route or [])
        if not access or len(access)>10 or any(not isinstance(ip,str) for ip in access):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        try:access=[str(ipaddress.ip_address(ip)) for ip in access]
        except ValueError:fail('SCREENING_ORIGIN_REQUEST_INVALID')
        saved_payload=[{'payload':payload,'accessRoute':access}]
        descriptor={'contract':'pos-screening-system-job-v1','commandId':command,'serviceId':'csk','referenceHash':reference_hash,
            'requestHash':request_hash,'state':'PREPARED','orderId':None,'updatedAt':self.clock()}
        with self.runtime.sessions() as session,session.begin():
            service=current_service(session,self.runtime.key,details)
            descriptor['serviceHash']=digest(self.runtime.key,'system-service',service)
            from system_successor import initialize,head
            existing_head=head(session,reference_hash,self.runtime.key)
            if existing_head is None and rows(session,'SELECT command_id FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR SHARE',{'id':command},2):fail('SCREENING_ORIGIN_REFERENCE_STATE_MISSING')
            active=existing_head or initialize(session,reference_hash,command,self.runtime.key,self.clock())
            command=active['activeCommandId'];descriptor['commandId']=command
            prior=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR UPDATE',{'id':command},2)
            if prior:
                old=json_value(prior[0]['data'])
                if old.get('requestHash')!=request_hash or old.get('referenceHash')!=reference_hash or not hmac.compare_digest(digest(self.runtime.key,'system-job',old),prior[0]['proof_hash']):fail('SCREENING_ORIGIN_REFERENCE_CONFLICT')
                descriptor=old
            else:
                if existing_head is not None:fail('SCREENING_ORIGIN_REFERENCE_STATE_MISSING')
                session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_jobs(command_id,data,proof_hash,payload,payload_hash) VALUES(:id,:data,:proof,:payload,:hash)'),
                    {'id':command,'data':canonical(descriptor),'proof':digest(self.runtime.key,'system-job',descriptor),
                     'payload':seal_effects(self.runtime.key,'system-job:'+command,saved_payload),'hash':hashlib.sha256(canonical(saved_payload).encode()).hexdigest()})
        resp.text=canonical(self.read(command,details));resp.status='202 Accepted';resp.set_header('Cache-Control','no-store')
    def run(self,command_id,original_request=None):
        from controllers.external.external_api_utils import validate_api_key
        details=validate_api_key(self.namespace['settings'].CSK_API_DETAILS['key'])
        from system_preparation import claim,pause
        claimed=claim(self,command_id,details)
        if claimed is None:
            with self.runtime.sessions() as session:
                row=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id',{'id':command_id})
                old=json_value(row['data'])
                if digest(self.runtime.key,'system-job',old)!=row['proof_hash']:fail()
            if old.get('state')=='SOURCE_RUNNING' and old.get('attemptExpiresAt',0)<=self.clock():pause(self,command_id,details,old.get('attemptId'),True)
            return self.recover(command_id,details)
        state,saved_payload,frozen=claimed;payload=saved_payload['payload']
        # Own source request/session; no native job lock crosses original calls.
        from middleware.CartMiddleware import CartFactory
        from controllers.priceList.PricelistManager import PricelistManager
        from origin_frame import LegacySession
        prefix=self.runtime.sessions();response=Response()
        context={'session':LegacySession(prefix),'user':None,'data':copy.deepcopy(payload)}
        if original_request is None:original_request=SimpleNamespace(access_route=saved_payload['accessRoute'])
        request=Request(original_request,context);context['cart']=CartFactory.empty_cart();context['cart'].context=context
        context['pricelist_manager']=PricelistManager(context)
        context['pricelist_manager'].set_strict_pricelist([self.namespace['settings'].CSK_PRICELIST])
        invocation=Context(self,command_id,state['referenceHash'],payload,details,request,response,state['attemptId'])
        method=compile_placement(self.source_file,self.source_hash,self.namespace,invocation)
        token=ACTIVE.set(invocation)
        try:
            if frozen is None:method(request,response,copy.deepcopy(payload),details)
            else:
                _metadata,snapshot=frozen
                context['user']=copy.deepcopy(snapshot['user']);context['data']=copy.deepcopy(snapshot['requestData'])
                context['cart'].restore(copy.deepcopy(snapshot['cart']));invocation.cart=context['cart']
                invocation.execute_prepared()
                invocation.submit_payment(json.loads(response.body),context['user'])
            # Retain the original metadata insertion with the job status. Its
            # native transaction begins only AFTER Go transport returned.
            prefix.commit();self.finalize_metadata(command_id,details)
            return self.read(command_id,details)
        except Exception:
            prefix.rollback()
            pause(self,command_id,details,state['attemptId'])
            return self.read(command_id,details)
        finally:ACTIVE.reset(token);prefix.close()
    def worker_candidates(self,limit=25):
        if type(limit) is not int or not 1<=limit<=100:fail('SCREENING_ORIGIN_REQUEST_INVALID')
        with self.runtime.sessions() as session:
            result=rows(session,"SELECT j.command_id FROM pos_rewrite_screening_origin_system_jobs j LEFT JOIN pos_rewrite_screening_origin_creations c ON c.command_id=j.command_id LEFT JOIN pos_rewrite_screening_origin_commands o ON o.id=j.command_id WHERE j.state IN ('PREPARED','SOURCE_READY') OR (j.state='SOURCE_RUNNING' AND (o.phase IS NULL OR o.phase<>'REJECTED') AND (c.command_id IS NOT NULL OR CAST(JSON_UNQUOTE(JSON_EXTRACT(j.data,'$.attemptExpiresAt')) AS UNSIGNED)<=:now)) OR (c.command_id IS NOT NULL AND j.state='PAYMENT_SENDING') ORDER BY j.updated_at_ms,j.command_id LIMIT :limit",{'now':self.clock(),'limit':limit},limit+1)
        return [row['command_id'] for row in result]
    def read(self,command_id,details):
        with self.runtime.sessions() as session,session.begin():
            current_service(session,self.runtime.key,details)
            job=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id',{'id':command_id})
            state=json_value(job['data'])
            if not hmac.compare_digest(digest(self.runtime.key,'system-job',state),job['proof_hash']):fail()
            candidates=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id},2)
            if candidates:
                value=read(session,command_id,str(candidates[0]['customer_id']),self.runtime.key)
                if value['phase'] in ('BOUND','COUNTED'):
                    source=creation(session,value,self.runtime.key)
                    state={**state,'orderId':value['orderId'],'state':'ORDER_CREATED'}
                    payments=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_payments WHERE command_id=:id FOR SHARE',{'id':command_id},2)
                    if payments:
                        payment(session,value,self.runtime.key);state['state']='COMPLETE'
                elif value['phase']=='REJECTED':state={**state,'state':'REJECTED'}
            result={'commandId':command_id,'phase':state['state'],'orderId':state['orderId']}
            from system_successor import head
            current=head(session,state['referenceHash'],self.runtime.key,lock=False)
            if current is not None:result['referenceVersion']=current['version']
            if state.get('successorId') is not None:result['successorCommandId']=state['successorId']
            return result
    def finalize_metadata(self,command_id,details):
        # Original build_order_attributes_model(priority2,EXTERNAL_API) runs
        # once, transactionally with its receipt, after the source placement.
        with self.runtime.sessions() as session,session.begin():
            current_service(session,self.runtime.key,details)
            hint=one(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id})
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':hint['customer_id']})
            value=read(session,command_id,str(hint['customer_id']),self.runtime.key)
            source=creation(session,value,self.runtime.key)
            one(session,'SELECT id FROM orders WHERE id=:id FOR UPDATE',{'id':source['orderId']})
            prior=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_metadata WHERE command_id=:id FOR UPDATE',{'id':command_id},2)
            if prior:
                saved=json_value(prior[0]['data'])
                if saved.get('creationHash')!=value['creationHash'] or not hmac.compare_digest(digest(self.runtime.key,'system-metadata',saved),prior[0]['proof_hash']):fail()
                return
            record=self.namespace['build_order_attributes_model'](self.namespace['Box']({'id':int(source['orderId'])}),priority=2,
                priority_reason=self.namespace['PriorityReasons'].EXTERNAL_API)
            session.add(record);session.flush()
            proof={'contract':'pos-screening-system-metadata-v1','commandId':command_id,'orderId':source['orderId'],
                   'creationHash':value['creationHash'],'createdAt':self.clock()}
            session.execute(text('INSERT INTO pos_rewrite_screening_origin_system_metadata(command_id,order_id,data,proof_hash) VALUES(:id,:order,:data,:proof)'),
                {'id':command_id,'order':source['orderId'],'data':canonical(proof),'proof':digest(self.runtime.key,'system-metadata',proof)})
    def recover(self,command_id,details):
        # Accepted system jobs may continue their FIRST native-fenced payment
        # stage. Once PAYMENT_SENDING exists, payment() performs GET only.
        with self.runtime.sessions() as session,session.begin():
            current_service(session,self.runtime.key,details)
            hints=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id},2)
            source=None
            if hints:
                value=read(session,command_id,str(hints[0]['customer_id']),self.runtime.key)
                if value['phase'] in ('BOUND','COUNTED'):source=creation(session,value,self.runtime.key)
        if source is not None:
            self.payment(command_id,{'order':int(source['orderId']),'method':source['method'],'isValid':True,'name':'placed_order'},details)
            self.finalize_metadata(command_id,details)
        return self.read(command_id,details)
    def close(self,command_id,details):
        # A command tombstone wins under the same customer/command/job locks as
        # final creation. A late original prefix can no longer create an Order.
        from origin_ledger import save
        key=self.runtime.key
        with self.runtime.sessions() as session,session.begin():
            session.connection(execution_options={'isolation_level':'READ COMMITTED'})
            current_service(session,key,details)
            hints=rows(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id},2)
            value=None
            if hints:
                customer=str(hints[0]['customer_id']);one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':customer})
                value=read(session,command_id,customer,key)
            row=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR UPDATE',{'id':command_id})
            state=json_value(row['data'])
            if not hmac.compare_digest(digest(key,'system-job',state),row['proof_hash']):fail()
            if value is None and rows(session,'SELECT id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id},2):fail('SCREENING_ORIGIN_CLOSE_SCOPE_CHANGED')
            if state['state']=='REJECTED':return {'commandId':command_id,'phase':'REJECTED','orderId':None}
            if state['state'] not in ('PREPARED','SOURCE_RUNNING','SOURCE_READY','PREPARATION_PAUSED','AUTHORITY_PAUSED') or value is not None and value['phase']!='PREPARED':fail('SCREENING_ORIGIN_CANNOT_CLOSE')
            for table in ('pos_rewrite_screening_origin_creations','pos_rewrite_screening_origin_payments','pos_rewrite_screening_origin_effects','pos_rewrite_screening_origin_system_metadata'):
                if rows(session,'SELECT command_id FROM '+table+' WHERE command_id=:id FOR SHARE',{'id':command_id},2):fail('SCREENING_ORIGIN_CANNOT_CLOSE')
            if value is not None:
                now=self.clock();proof={'contract':'pos-screening-origin-closure-v1','commandId':command_id,'origin':'external-system',
                    'customerId':value['customerId'],'requestHash':value['requestHash'],'cartHash':value['cartHash'],'authorityHash':value['authorityHash'],
                    'code':'SCREENING_ORIGIN_SYSTEM_CLOSED_NO_ORDER','noFinancialEffects':True,'createdAt':now}
                seal=digest(key,'closure',proof)
                session.execute(text('INSERT INTO pos_rewrite_screening_origin_closures(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),
                    {'id':command_id,'data':canonical(proof),'proof':seal})
                save(session,{**value,'phase':'REJECTED','closureHash':seal},key,now)
            state={**state,'state':'REJECTED','updatedAt':self.clock()}
            session.execute(text('UPDATE pos_rewrite_screening_origin_system_jobs SET data=:data,proof_hash=:proof WHERE command_id=:id'),
                {'id':command_id,'data':canonical(state),'proof':digest(key,'system-job',state)})
        return {'commandId':command_id,'phase':'REJECTED','orderId':None}
    def on_get(self,req,resp,command_id):
        if not UUID.fullmatch(command_id):fail()
        details=self.authenticate(req);resp.text=canonical(self.read(command_id,details));resp.set_header('Cache-Control','no-store')
    def payment(self,command_id,body,details):
        key=self.runtime.key
        with self.runtime.sessions() as session,session.begin():
            current_service(session,key,details)
            hint=one(session,'SELECT customer_id FROM pos_rewrite_screening_origin_commands WHERE id=:id',{'id':command_id})
            one(session,'SELECT id FROM users WHERE id=:id FOR UPDATE',{'id':hint['customer_id']})
            value=read(session,command_id,str(hint['customer_id']),key)
            source=creation(session,value,key)
            if str(body['order'])!=source['orderId'] or body['method']!=source['method']:fail()
            saved=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_system_jobs WHERE command_id=:id FOR UPDATE',{'id':command_id})
            state=json_value(saved['data'])
            if not hmac.compare_digest(digest(key,'system-job',state),saved['proof_hash']):fail()
            may_post=state['state']=='SOURCE_RUNNING'
            if may_post:
                state={**state,'state':'PAYMENT_SENDING','orderId':source['orderId'],'updatedAt':self.clock()}
                session.execute(text('UPDATE pos_rewrite_screening_origin_system_jobs SET data=:data,proof_hash=:proof WHERE command_id=:id'),
                    {'id':command_id,'data':canonical(state),'proof':digest(key,'system-job',state)})
        now=self.clock();cap={'contract':'pos-screening-origin-payment-submission-v1','commandId':command_id,'orderId':source['orderId'],
            'customerId':source['customerId'],'creationHash':value['creationHash'],'requestHash':source['requestHash'],'referenceHash':source['referenceHash'],
            'authorityHash':source['authorityHash'],'paymentRequestHash':digest(key,'payment-request',body),'issuedAt':now,'expiresAt':now+60000}
        def authorization(purpose):return base64.urlsafe_b64encode(canonical({'data':cap,'proofHash':digest(key,purpose,cap)}).encode()).decode().rstrip('=')
        target=self.payment_base+command_id+'/payment'
        headers={'Content-Type':'application/json','X-TSS-Screening-Command':command_id,'X-TSS-Screening-Payment-Authorization':authorization('payment-read')}
        # GET-only after any recorded dispatch/unknown. A fresh native Go attempt
        # is the sole payment dispatcher; status/HTTP200 alone never completes.
        result=requests.get(target,headers=headers,timeout=(5,20),allow_redirects=False,verify=True)
        if result.status_code==404 and may_post:
            headers['X-TSS-Screening-Payment-Authorization']=authorization('payment-submission')
            result=requests.post(target,json=body,headers=headers,timeout=(5,30),allow_redirects=False,verify=True)
        if result.status_code not in (200,201,202):fail('SCREENING_ORIGIN_PAYMENT_RECONCILIATION_REQUIRED')
        return result


class SystemClose:
    def __init__(self,system):self.system=system
    def on_post(self,req,resp,command_id):
        if not UUID.fullmatch(command_id) or req.context.get('data') not in (None,{}):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        details=self.system.authenticate(req);resp.text=canonical(self.system.close(command_id,details));resp.set_header('Cache-Control','no-store')

class SystemResume:
    def __init__(self,system):self.system=system
    def on_post(self,req,resp,command_id):
        if not UUID.fullmatch(command_id) or req.context.get('data') not in (None,{}):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        from system_preparation import resume
        details=self.system.authenticate(req);resp.text=canonical(resume(self.system,command_id,details));resp.set_header('Cache-Control','no-store')

class SystemSuccessor:
    def __init__(self,system):self.system=system
    def on_post(self,req,resp,command_id):
        import os
        from system_successor import successor,CONTRACT
        if os.environ.get('POS_SCREENING_ORIGIN_SYSTEM_SUCCESSOR_CONTRACT')!=CONTRACT:fail('SCREENING_ORIGIN_SUCCESSOR_UNAVAILABLE')
        if not UUID.fullmatch(command_id):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        details=self.system.authenticate(req);resp.text=canonical(successor(self.system,command_id,details,req.context.get('data')));resp.set_header('Cache-Control','no-store')
    def on_get(self,req,resp,command_id,successor_id):
        from system_successor import receipt
        if not UUID.fullmatch(command_id) or not UUID.fullmatch(successor_id):fail('SCREENING_ORIGIN_REQUEST_INVALID')
        self.system.authenticate(req)
        found=receipt(self.system,command_id,successor_id)
        resp.set_header('Cache-Control','no-store')
        if found is None:resp.status='404 Not Found';resp.text=canonical({'code':'SCREENING_ORIGIN_SUCCESSOR_NOT_FOUND'});return
        resp.text=canonical(found)
