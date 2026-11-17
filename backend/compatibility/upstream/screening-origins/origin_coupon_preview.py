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


class PreviewCouponScope(CouponScope):
    def __init__(self,owner,session,preview,kind,selections,documents,snapshot):
        self.owner,self.session,self.customer_id,self.kind=owner,session,preview['customerId'],kind
        self.preview=preview;self.settings={'PREPAID_AMT_DEDUCTION':owner.prepaid}
        self.cache=PreviewCache(owner,session,preview,snapshot);self.entries={};self.active=None;self.validated=False;self.welcome_consent=None
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        for selection,document in zip(selections,documents):
            coupon=current_coupon_control(session,selection['couponId']);assignments=current_coupon_assignments(session,self.customer_id,selection['couponId'])
            replay=OriginalCouponReplay({'scope':{'customerId':self.customer_id,'couponId':selection['couponId'],'asOf':selection['asOf']},
                **(document['facts'] if document is not None else {})},session,coupon,assignments,requires_history=selection['requiresHistory'])
            namespace=compile_coupon(owner.root,settings_namespace(owner.coupon_settings,datetime.strptime(selection['asOf'],'%Y-%m-%d %H:%M:%S'),
                replay,self.cache,ValidationException,ItemTypes,self.consent))
            self.entries[selection['couponId']]={'selection':selection,'document':document,'namespace':namespace,'replay':replay,'validated':False}
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
    selections=coupons.select(session,preview,kind,namespace,snapshot,cart_meta=cart_meta,point_value=at);checked=[]
    for selection in selections:
        if not selection['requiresHistory']:checked.append(None);continue
        request={'preview':preview,'previewProof':preview_proof,'selection':{name:selection[name] for name in
            ('couponId','configurationHash','originConfigurationHash','couponInputHash','asOf','sourceTimeZone')},'witness':selection['witness']}
        identity=digest(coupons.key,'coupon-preview-request',request)
        document=documents.get(identity)
        if document is None:raise NeedCouponPreview(request)
        checked.append(qualified(document,request,coupons.key,coupons.clock()))
    state=PreviewCouponScope(coupons,session,preview,kind,selections,checked,snapshot);token=ACTIVE.set(state)
    try:
        yield state
        coupons.check_snapshot(preview,snapshot);state.assert_current()
    finally:ACTIVE.reset(token)
