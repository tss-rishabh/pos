"""Genuine pre-command cart coupon previews; no Order or birthday claim writes.

The origin owner supplies authenticated preview context and runs this scope
inside its owned rollback transaction. Missing BQ documents unwind SQL before
its source provider is called. No fake command or historical zero is accepted.
"""
import copy
import hmac
import json
from contextlib import contextmanager
from datetime import datetime
from zoneinfo import ZoneInfo
from origin_contracts import digest,unsafe
from origin_coupon_source import ACTIVE,CouponScope,OriginalCouponReplay,settings_namespace
from origin_coupon_cache import SnapshotCache
from benefit_controls import CurrentConfigurationCache
from benefit_receipts import current_coupon_control,current_coupon_assignments
from benefit_source import compile_coupon
from benefit_history import Rows
from native import rows
from preview_contracts import preview as qualify_preview

CONTRACT='pos-screening-origin-coupon-preview-v1'


class NeedCouponPreview(BaseException):
    def __init__(self,request):self.request=copy.deepcopy(request)


def qualified(document,request,key,now):
    fields={'contract','preview','previewProof','selection','witness','generationId','publication','facts',
            'reader','complete','fetchedAt','expiresAt','signature'}
    if (not isinstance(document,dict) or set(document)!=fields or document['contract']!=CONTRACT
            or any(document[name]!=request[name] for name in ('preview','previewProof','selection','witness'))
            or document['reader']!='bigquery' or document['complete'] is not True
            or type(document['fetchedAt']) is not int or type(document['expiresAt']) is not int
            or not document['fetchedAt']<=now<document['expiresAt']<=min(document['fetchedAt']+60000,request['preview']['expiresAt'])
            or not isinstance(document['signature'],str)
            or not hmac.compare_digest(document['signature'],digest(key,'coupon-preview',{name:value for name,value in document.items() if name!='signature'}))):
        unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_REQUIRED')
    return copy.deepcopy(document)


class PreviewCache:
    def __init__(self,owner,session,preview,snapshot):
        self.owner,self.session,self.preview=owner,session,preview
        self.snapshot=copy.deepcopy(snapshot);self.config=CurrentConfigurationCache(SnapshotCache(snapshot['config']));self.applied=False
    def exists(self,name):
        if name=='welcome_coupon':return name in self.snapshot['config']
        if name=='birthday_coupon_'+self.preview['customerId']:
            guards=rows(self.session,'SELECT expires_at_ms FROM pos_rewrite_import_birthday_guards WHERE customer_id=:customer LIMIT 2 FOR SHARE',{'customer':self.preview['customerId']},2)
            if len(guards)>1:unsafe()
            return self.applied or self.snapshot['legacyPresent'] or bool(guards and int(guards[0]['expires_at_ms'])>self.owner.clock())
        if name.startswith('birthday_coupon_'):unsafe()
        return self.config.exists(name)
    def get(self,name):
        if name=='welcome_coupon':
            value=self.snapshot['config'].get(name);return value.encode() if isinstance(value,str) else value
        if name=='birthday_coupon_'+self.preview['customerId']:return b'{"is_applied":true}' if self.exists(name) else None
        return self.config.get(name)
    def set(self,name,value,ex=None):
        if name!='birthday_coupon_'+self.preview['customerId']:return self.config.set(name,value,ex)
        if type(ex) is not int or not 1<=ex<=2592000 or json.loads(value)!={'is_applied':True}:unsafe()
        self.applied=True;return True


class MissingCouponReader:
    """Only the pinned original initial coupon SELECT, backed by real SQL.

    A missing native code takes the original ValidationException branch. This
    facade cannot answer a historical query or fabricate a coupon/control row.
    """
    SELECT="select id as coupon_id, voucher_type as type, disc_apply_items as min_quantity, min_order_amt as min_amount, voucher_code, voucher_val as discount, voucher_valid_for as valid_for, id, platform, voucher_percentage_max_val, for_new_user, user_specific, buyable_quantity, free_quantity, is_applicable_on_discounted_products, voucher_mxn_type, no_times_allowed, coupon_lot_no, message from coupons where is_deleted = 0 and voucher_type != 3 and (convert_tz(now(), 'utc', 'asia/kolkata') between start_date and end_date) and voucher_code = :coupon"
    def __init__(self,session,code):self.session,self.code=session,code
    def execute(self,query,parameters=None,*,params=None):
        if params is not None:
            if parameters is not None:unsafe()
            parameters=params
        if ' '.join(str(query).split()).lower()!=self.SELECT or parameters!={'coupon':self.code}:unsafe('SCREENING_ORIGIN_COUPON_CURRENT_QUERY_UNQUALIFIED')
        values=rows(self.session,str(query).strip().rstrip(';')+' LIMIT 2 FOR SHARE',parameters,2)
        if values:unsafe('SCREENING_ORIGIN_COUPON_SCOPE_CHANGED')
        return Rows(values)
    def fetch_one(self,*_args,**_kwargs):unsafe()
    def fetch(self,*_args,**_kwargs):unsafe()


def preview_document(coupons,preview,proof,selection,documents):
    if not selection['requiresHistory']:return None
    request={'preview':preview,'previewProof':proof,'selection':{name:selection[name] for name in
        ('couponId','configurationHash','originConfigurationHash','couponInputHash','asOf','sourceTimeZone')},'witness':selection['witness']}
    document=documents.get(digest(coupons.key,'coupon-preview-request',request))
    if document is None:raise NeedCouponPreview(request)
    return qualified(document,request,coupons.key,coupons.clock())


class PreviewCouponScope(CouponScope):
    def __init__(self,owner,session,preview,kind,selections,checked,snapshot,*,preview_proof,namespace,documents,at):
        self.owner,self.session,self.customer_id,self.kind=owner,session,preview['customerId'],kind
        self.preview,self.preview_proof,self.namespace,self.documents,self.at=preview,preview_proof,namespace,documents,at
        self.snapshot=copy.deepcopy(snapshot);self.settings={'PREPAID_AMT_DEDUCTION':owner.prepaid}
        self.cache=PreviewCache(owner,session,preview,snapshot);self.entries={};self.active=None;self.validated=False;self.welcome_consent=None
        for selection,document in zip(selections,checked):self._add(selection,document)
    def _add(self,selection,document):
        if selection['couponId'] in self.entries:return
        if len(self.entries)>=4:unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_LIMIT')
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        coupon=current_coupon_control(self.session,selection['couponId']);assignments=current_coupon_assignments(self.session,self.customer_id,selection['couponId'])
        replay=OriginalCouponReplay({'scope':{'customerId':self.customer_id,'couponId':selection['couponId'],'asOf':selection['asOf']},
            **(document['facts'] if document is not None else {})},self.session,coupon,assignments,requires_history=selection['requiresHistory'])
        namespace=compile_coupon(self.owner.root,settings_namespace(self.owner.coupon_settings,self.at,
            replay,self.cache,ValidationException,ItemTypes,self.consent))
        self.entries[selection['couponId']]={'selection':selection,'document':document,'namespace':namespace,'replay':replay,'validated':False}
    def choose(self,coupon_id):
        coupon_id=str(coupon_id)
        if coupon_id not in self.entries:
            if len(self.entries)>=4:unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_LIMIT')
            current=current_coupon_control(self.session,coupon_id)
            # Incoming mutation can select B after original hydration selected
            # A. Resolve B from native controls at the same frozen preview time;
            # no pending Order or command is invented to request its facts.
            selected=self.owner.select(self.session,self.preview,self.kind,self.namespace,self.snapshot,
                cart_meta={'items':[{'name':'coupon','coupon':current['voucher_code']}]},point_value=self.at)
            if not any(item['couponId']==coupon_id for item in selected):unsafe('SCREENING_ORIGIN_COUPON_UNBOUND')
            if len(set(self.entries)|{item['couponId'] for item in selected})>4:unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_LIMIT')
            for selection in selected:
                if selection['couponId'] not in self.entries:
                    document=preview_document(self.owner,self.preview,self.preview_proof,selection,self.documents)
                    self._add(selection,document)
        return super().choose(coupon_id)
    def get_valid_coupon(self,_session,code,platform,user,db_fetch=True,is_pos=False):
        if not db_fetch or not user or str(user['user_id'])!=self.customer_id or bool(is_pos)!=(self.kind=='pos'):unsafe()
        matches=rows(self.session,'SELECT id,voucher_code FROM coupons WHERE voucher_code=:code LIMIT 2 FOR SHARE',{'code':code},2)
        if matches:return super().get_valid_coupon(_session,code,platform,user,db_fetch=db_fetch,is_pos=is_pos)
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        reader=MissingCouponReader(self.session,code)
        namespace=compile_coupon(self.owner.root,settings_namespace(self.owner.coupon_settings,self.at,reader,self.cache,ValidationException,ItemTypes,self.consent))
        return namespace['get_valid_coupon'](reader,code,platform,user,db_fetch=True,is_pos=is_pos)
    def validate_after_native(self):unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_ORDER_FORBIDDEN')
    def assert_current(self):
        if self.owner.clock()>=self.preview['expiresAt']:unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_EXPIRED')
        for entry in self.entries.values():
            selection=entry['selection'];at=datetime.strptime(selection['asOf'],'%Y-%m-%d %H:%M:%S')
            if (not 0<=self.owner.clock()-int(at.replace(tzinfo=ZoneInfo(self.owner.zone)).timestamp()*1000)<60000
                    or at.date()!=self.owner._point().date()):unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_EXPIRED')
            document=entry['document']
            if document is not None:
                qualified(document,{name:document[name] for name in ('preview','previewProof','selection','witness')},self.owner.key,self.owner.clock())
            if self.owner.heads.capture(self.session,self.customer_id,selection['couponId'])!=selection['witness']:unsafe('SCREENING_ORIGIN_COUPON_HEAD_CHANGED')


@contextmanager
def coupon_preview_scope(coupons,session,preview,preview_proof,kind,namespace,snapshot,documents,*,cart_meta=None):
    from transaction import CURRENT
    if CURRENT.get() is not None or ACTIVE.get() is not None:unsafe('SCREENING_ORIGIN_COUPON_SQL_SCOPE')
    qualify_preview(preview)
    if (not isinstance(preview,dict) or preview.get('contract')!='pos-screening-origin-preview-v1'
            or not preview['issuedAt']<=coupons.clock()<preview['expiresAt']
            or not hmac.compare_digest(preview_proof,digest(coupons.key,'preview-context',preview))):unsafe('SCREENING_ORIGIN_COUPON_PREVIEW_UNAUTHORIZED')
    coupons.check_snapshot(preview,snapshot)
    at=datetime.fromtimestamp(preview['issuedAt']/1000,ZoneInfo(coupons.zone)).replace(tzinfo=None,microsecond=0)
    selections=coupons.select(session,preview,kind,namespace,snapshot,cart_meta=cart_meta,point_value=at)
    checked=[preview_document(coupons,preview,preview_proof,selection,documents) for selection in selections]
    state=PreviewCouponScope(coupons,session,preview,kind,selections,checked,snapshot,
        preview_proof=preview_proof,namespace=namespace,documents=documents,at=at);token=ACTIVE.set(state)
    try:
        yield state
        coupons.check_snapshot(preview,snapshot);state.assert_current()
    finally:ACTIVE.reset(token)
