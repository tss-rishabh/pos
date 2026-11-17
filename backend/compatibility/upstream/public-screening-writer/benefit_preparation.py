"""Private rollback-only public Cart/Validate/Processing producer.

It authenticates the already prepared public nonce, never creates an order
dispatch checkpoint, and cannot invoke PosOrder/payment/Go or a publisher.
"""
import copy
import hmac
import importlib
import json
import re
from types import SimpleNamespace
from protocol import digest,ImportReview
from native_authority import rows
from writer_protocol import verify,fail,portable_hash,quote_snapshot,ScreeningWriterError
from source_frame import _Frame
from source_runtime import compile_class
from public_membership_history import NeedMembershipHistory,PreparedPublicMembershipHistory
from order_preparation import read_only_source
from cart_preparation import read_only_preview

CONTRACT='pos-public-screening-benefit-preparation-v1'
PATH='/internal/pos/public-screening/preparations'


def options(env,other_keys=()):
    selected=env.get('POS_PUBLIC_SCREENING_PREPARATION_CONTRACT')
    secret=env.get('POS_PUBLIC_SCREENING_PREPARATION_KEY','')
    if selected in (None,'') and secret in (None,''):return None
    if (selected!=CONTRACT or not isinstance(secret,str) or not re.fullmatch(r'[!-~]{32,4096}',secret)
            or secret in other_keys):fail('SCREENING_PREPARATION_UNAVAILABLE')
    return {'contract':CONTRACT,'key':secret}


class Preparation:
    def __init__(self,owner,settings,source_key,history_key):
        self.owner,self.settings,self.source_key,self.history_key=owner,settings,source_key,history_key
        cart_module=importlib.import_module('controllers.CartController')
        self.cart=compile_class(owner.root,'controllers/CartController.py','Cart',dict(vars(cart_module)))()
        checkout=importlib.import_module('controllers.CheckoutController')
        self.validate=compile_class(owner.root,'controllers/CheckoutController.py','ValidateCheckout',dict(vars(checkout)))()
        order=importlib.import_module('controllers.OrderController')
        self.process=compile_class(owner.root,'controllers/OrderController.py','ProcessingOrder',dict(vars(order)))()
        self.middleware=importlib.import_module('middleware.CartMiddleware')

    def run(self,body):
        if (not isinstance(body,dict) or not {'capability','payload'}.issubset(body)
                or set(body)-{'capability','payload','membershipHistory'}):fail('SCREENING_PREPARATION_UNAVAILABLE')
        cap=verify(body['capability'],self.owner.secret,self.owner.clock())
        if cap.get('benefitsContract')!='pos-node-screening-benefits-v1' or portable_hash(body['payload'])!=cap['requestHash']:fail()
        history=None
        if 'membershipHistory' in body:
            history=PreparedPublicMembershipHistory(body['membershipHistory'],cap,self.history_key,self.settings,self.owner.clock)
        req=SimpleNamespace(context={},params={},method='POST',path=self.settings.POS_API_PREFIX+'/order',
            headers={},access_route=[],remote_addr=None,user_agent=None,uri=PATH,url=PATH,referer=None,
            get_header=lambda *_args,**_kwargs:None,get_param=lambda _name,default=None,**_kwargs:default)
        frame=_Frame(self.owner,req,cap)
        outcome='ready';scope=None;head=None
        try:
            frame.open(preview=True,history=history)
            user=frame.benefit_state.user
            # A public preview restores the actual server-owned cart, using the
            # existing empty persistence handler installed by public Bootstrap.
            req.context={'session':frame.source,'session_r':frame.source,'user':user,
                'data':copy.deepcopy(body['payload']),'is_pos':True,'store_id':int(cap['storeId']),
                'active_cart':None,'pos_rewrite_fresh_customer':{'subject':cap['customerId'],'loaded':True}}
            resp=SimpleNamespace(status='200 OK',body='',text='',set_header=lambda *_args:None)
            with read_only_source(frame.session),read_only_preview():
                req.context['pricelist_manager']=self.middleware.PricelistManager(req.context)
                req.context['cart']=self.middleware.PosCartFactory.instantiate(None,user,req.context,
                    store_id=int(cap['storeId']),is_pos=True)
                req.context['data']={**body['payload'],'payload':{'operation':'get'}}
                try:
                    self.cart.on_post(req,resp)
                    req.context['data']=copy.deepcopy(body['payload'])
                    self.validate.on_post(req,resp)
                    self.process.on_post(req,resp)
                    projected=self.owner.project(req.context['cart'],user,req,None)
                    if portable_hash(quote_snapshot(projected))!=cap['cartHash']:outcome='quote-changed'
                except NeedMembershipHistory as needed:
                    outcome='need-history';scope=needed.scope;head=needed.head
            # Validate the current projection after the strict read guard is
            # removed. This releases no tentative ticket or native claim.
            frame.exit_source(True)
        finally:
            frame.abort()  # Always native rollback, including ready/NeedHistory.
        now=self.owner.clock()
        if now>=cap['expiresAt']:fail('SCREENING_WRITER_EXPIRED')
        value={'contract':CONTRACT,'operationId':cap['operationId'],'requestHash':cap['requestHash'],
            'cartHash':cap['cartHash'],'outcome':outcome,
            'membershipHistoryHash':None if history is None else portable_hash(body['membershipHistory']),
            'issuedAt':now,'expiresAt':cap['expiresAt']}
        if scope is not None:value.update(historyScope=scope,head=head)
        return {'data':value,'proofHash':digest(self.source_key,'public-screening-benefit-preparation',value)}

    def handle(self,req,resp,configuration):
        supplied=req.get_header('X-POS-Screening-Preparation-Key') or ''
        if (req.method!='POST' or req.query_string or (req.content_type or '').split(';',1)[0]!='application/json'
                or not isinstance(supplied,str) or len(supplied)>4096
                or not hmac.compare_digest(configuration['key'],supplied)):
            fail('SCREENING_PREPARATION_UNAUTHORIZED')
        length=req.content_length
        if type(length) is not int or not 1<=length<=1200000:fail('SCREENING_PREPARATION_UNAVAILABLE')
        raw=req.bounded_stream.read(length+1)
        if len(raw)!=length:fail()
        def unique(pairs):
            data={}
            for name,value in pairs:
                if name in data:fail()
                data[name]=value
            return data
        try:body=json.loads(raw.decode('utf-8'),object_pairs_hook=unique)
        except (ValueError,UnicodeError):fail()
        result=self.run(body)
        resp.status='200 OK';resp.content_type='application/json'
        resp.text=json.dumps(result,separators=(',',':'));resp.complete=True
