"""Real other-origin coupon preparation and original-source execution scope.

Only current cart/customer/coupon/consent controls use MySQL. Lifetime/monthly
Order/log facts are supplied by the separate bounded BQ reader outside SQL.
"""
import copy
import hmac
import json
import re
import sys
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import date,datetime
from functools import wraps
from types import SimpleNamespace
from zoneinfo import ZoneInfo
from sqlalchemy import text
from native import one,rows,json_value
from origin_contracts import canonical,digest,identifier,point,unsafe
from origin_coupon_contracts import HISTORY,check_command,current_users,capture as capture_receipt
from origin_coupon_heads import OriginCouponHeads
from origin_coupon_cache import OriginCouponCache,SnapshotCache
from benefit_source import compile_coupon
from benefit_history import CouponHistoryReplay,Rows,seal
from benefit_controls import CurrentConfigurationCache
from benefit_receipts import current_coupon_control,current_coupon_assignments

ACTIVE=ContextVar('genuine_source_origin_coupon',default=None)
CONFIG_KEYS=('auto_apply_coupon','birthday_coupon','welcome_coupon')


class Silent:
    def __getattr__(self,_name):return lambda *_args,**_kwargs:None


class ScopedLogger:
    def __init__(self,original):self.original=original
    def __getattr__(self,name):
        value=getattr(self.original,name)
        if not callable(value):return value
        def call(*args,**kwargs):
            if ACTIVE.get() is not None:return False if name=='isEnabledFor' else None
            return value(*args,**kwargs)
        return call


def settings_namespace(settings,point_value,reader,cache,error_type,types,consent):
    class FrozenDateTime(datetime):
        @classmethod
        def now(cls,tz=None):
            if tz is not None:unsafe('SCREENING_ORIGIN_COUPON_CLOCK_UNQUALIFIED')
            return point_value
    class FrozenDate(date):
        @classmethod
        def today(cls):return point_value.date()
    return {'datetime':SimpleNamespace(datetime=FrozenDateTime,now=lambda:point_value),'date':FrozenDate,
        'json':json,'text':text,'Session':reader,'SessionR':reader,'redis_object':cache,
        'fetchOne':reader.fetch_one,'fetch':reader.fetch,'logger':Silent(),'ValidationException':error_type,
        'settings':SimpleNamespace(**copy.deepcopy(settings)),'ItemTypes':types,
        **{name:settings[name] for name in ('BIRTHDAY_MESSAGE','EMPLOYEE_COUPON_DOMAIN_MAP','REDIS_COUPON_EXPIRY_IN_SEC')},
        'check_user_in_table':consent}


class Probe:
    def __init__(self,session,customer):self.session,self.customer=session,customer
    def execute(self,query,parameters=None):
        compact=' '.join(str(query).split()).lower()
        allowed=(f'select birthdate, email from users where id={self.customer}',
            "select status, value from tss_settings where platform='auto_apply_coupon'",
            "select status from tss_settings where platform='birthday_coupon'",
            "select * from coupons join tss_settings on coupons.id = tss_settings.value where tss_settings.platform='birthday_coupon';")
        if compact not in allowed or parameters not in (None,{}):unsafe('SCREENING_ORIGIN_COUPON_CURRENT_QUERY_UNQUALIFIED')
        values=rows(self.session,str(query).strip().rstrip(';')+' LIMIT 2 FOR SHARE',{},2)
        if len(values)>1:unsafe('SCREENING_ORIGIN_COUPON_CURRENT_AMBIGUOUS')
        return Rows(values)
    def fetch_one(self,session,query,params=None,to_dict=False):
        if session is not self:unsafe()
        value=self.execute(query,params).fetchone()
        return dict(value) if to_dict and value is not None else value
    def fetch(self,session,query,params=None,to_dict=False):
        if session is not self:unsafe()
        values=self.execute(query,params).fetchall()
        return [dict(row) for row in values] if to_dict else values


def qualified(document,value,selection,key,now):
    keys={'contract','commandId','origin','customerId','requestHash','cartHash','authorityHash','selection','witness','generationId',
          'publication','facts','reader','complete','fetchedAt','expiresAt','signature'}
    if (not isinstance(document,dict) or set(document)!=keys or document['contract']!=HISTORY
            or document['reader']!='bigquery' or document['complete'] is not True
            or document['selection']!={name:selection[name] for name in ('couponId','configurationHash','originConfigurationHash','couponInputHash','asOf','sourceTimeZone')}
            or document['witness']!=selection['witness']
            or any(document[name]!=value[target] for name,target in (('commandId','id'),('origin','origin'),('customerId','customerId'),('requestHash','requestHash'),('cartHash','cartHash'),('authorityHash','authorityHash')))
            or not point(document['fetchedAt']) or not point(document['expiresAt'])
            or not document['fetchedAt']<=now<document['expiresAt']<=min(document['fetchedAt']+60000,value['expiresAt'])
            or not hmac.compare_digest(digest(key,'coupon-history',{name:item for name,item in document.items() if name!='signature'}),document['signature'])):
        unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
    return copy.deepcopy(document)


class SourceCoupons:
    def __init__(self,root,origin_key,history_source_key,source_cache,coupon_settings,prepaid,zone,*,clock=None,point_factory=None):
        if (origin_key==history_source_key or type(prepaid) is not bool or not isinstance(coupon_settings,dict)
                or not re.fullmatch(r'[!-~]{32,4096}',origin_key) or not re.fullmatch(r'[!-~]{32,4096}',history_source_key)):unsafe('SCREENING_ORIGIN_COUPON_CONFIGURATION')
        self.root,self.key,self.history_key=root,origin_key,history_source_key
        self.source_cache,self.coupon_settings=source_cache,copy.deepcopy(coupon_settings)
        self.prepaid,self.zone=prepaid,zone;ZoneInfo(zone)
        self.clock=clock or (lambda:int(time.time()*1000));self.point_factory=point_factory or datetime.now
        self.heads=OriginCouponHeads(history_source_key)
    def snapshot(self,customer_id):
        from transaction import CURRENT
        if CURRENT.get() is not None:unsafe('SCREENING_ORIGIN_COUPON_SQL_SCOPE')
        customer=identifier(customer_id);values={}
        for name in CONFIG_KEYS:
            exists=self.source_cache.exists(name)
            if type(exists) not in (bool,int) or exists not in (0,1):unsafe('SCREENING_ORIGIN_COUPON_CACHE_UNQUALIFIED')
            if exists:
                raw=self.source_cache.get(name)
                if isinstance(raw,bytes):raw=raw.decode('utf-8')
                if not isinstance(raw,str) or len(raw.encode())>16000:unsafe('SCREENING_ORIGIN_COUPON_CACHE_UNQUALIFIED')
                if raw and not isinstance(json.loads(raw),dict):unsafe('SCREENING_ORIGIN_COUPON_CACHE_UNQUALIFIED')
                values[name]=raw
        present=self.source_cache.exists('birthday_coupon_'+customer)
        if type(present) not in (bool,int) or present not in (0,1):unsafe('SCREENING_ORIGIN_COUPON_CACHE_UNQUALIFIED')
        body={'customerId':customer,'observedAt':self.clock(),'config':values,'legacyPresent':bool(present)}
        return {**body,'signature':digest(self.key,'coupon-snapshot',body)}
    def check_snapshot(self,value,snapshot):
        if (not isinstance(snapshot,dict) or set(snapshot)!={'customerId','observedAt','config','legacyPresent','signature'}
                or snapshot['customerId']!=value['customerId'] or type(snapshot['legacyPresent']) is not bool
                or not point(snapshot['observedAt']) or not 0<=self.clock()-snapshot['observedAt']<60000
                or not isinstance(snapshot['config'],dict) or not set(snapshot['config'])<=set(CONFIG_KEYS)
                or not hmac.compare_digest(snapshot['signature'],digest(self.key,'coupon-snapshot',{name:item for name,item in snapshot.items() if name!='signature'}))):unsafe('SCREENING_ORIGIN_COUPON_SNAPSHOT_CHANGED')
    def _point(self):
        value=self.point_factory()
        if not isinstance(value,datetime) or value.tzinfo is not None:unsafe('SCREENING_ORIGIN_COUPON_CLOCK_UNQUALIFIED')
        point_value=value.replace(microsecond=0)
        instant=int(point_value.replace(tzinfo=ZoneInfo(self.zone)).timestamp()*1000)
        if not 0<=self.clock()-instant<1000:unsafe('SCREENING_ORIGIN_COUPON_CLOCK_UNQUALIFIED')
        return point_value
    def prepare(self,session,value,kind,namespace,snapshot,*,cart_meta=None):
        check_command(session,value,self.key,('PREPARED',));self.check_snapshot(value,snapshot)
        if kind not in ('customer','pos'):unsafe()
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        cache=CurrentConfigurationCache(SnapshotCache(snapshot['config']));reader=Probe(session,value['customerId'])
        point_value=self._point();ns=compile_coupon(self.root,settings_namespace(self.coupon_settings,point_value,reader,cache,ValidationException,ItemTypes,lambda *_a:False))
        # Traverse both original current cache controls in the same order used
        # by the generic publisher. Fallback writes remain in this invocation.
        auto=ns['get_auto_apply_coupon'](reader);birthday,birthday_name,status=ns['get_birthday_coupon_details'](reader)
        if cart_meta is None:
            metadata=rows(session,"SELECT value FROM cart_meta WHERE cart_id=:cart AND name='meta' LIMIT 2 FOR SHARE",{'cart':namespace},2)
            if len(metadata)>1:unsafe('SCREENING_ORIGIN_COUPON_CART_AMBIGUOUS')
            cart_meta=json_value(metadata[0]['value']) if metadata else {}
        if not isinstance(cart_meta,dict) or not isinstance(cart_meta.get('items',[]),list) or len(cart_meta.get('items',[]))>2000:unsafe('SCREENING_ORIGIN_COUPON_CART_AMBIGUOUS')
        manual=[item for item in cart_meta.get('items',[]) if isinstance(item,dict) and item.get('name')=='coupon']
        if len(manual)>1:unsafe('SCREENING_ORIGIN_COUPON_CART_AMBIGUOUS')
        identities=[]
        if manual:
            code=manual[0].get('coupon')
            if not isinstance(code,str) or not 1<=len(code)<=255:unsafe('SCREENING_ORIGIN_COUPON_CART_AMBIGUOUS')
            found=rows(session,'SELECT id FROM coupons WHERE voucher_code=:code LIMIT 2 FOR SHARE',{'code':code},2)
            if len(found)!=1:unsafe('SCREENING_ORIGIN_COUPON_CODE_AMBIGUOUS')
            identities.append(identifier(found[0]['id']))
        if (auto.get('value')=='birthday_coupon' and int(auto.get('status',0))==1 and birthday and birthday_name and int(status)==1
                and ns['check_birthday_month'](reader,value['customerId'])):identities.append(identifier(birthday))
        selections=[]
        policy=self.heads.policy(session) if identities else None
        for coupon_id in sorted(set(identities),key=int):
            current=current_coupon_control(session,coupon_id)
            selections.append({'couponId':coupon_id,'couponInputHash':current['native_hash'],
                'configurationHash':seal('coupon-configuration',{'cache':cache.values,'settings':self.coupon_settings,'couponInputHash':current['native_hash'],'originHistoryPolicy':policy},self.history_key),
                'originConfigurationHash':digest(self.key,'coupon-configuration',{'cache':snapshot['config'],'effective':cache.values,'settings':self.coupon_settings,'prepaid':self.prepaid,'kind':kind,'couponInputHash':current['native_hash']}),
                'asOf':point_value.strftime('%Y-%m-%d %H:%M:%S'),'sourceTimeZone':self.zone,'originHistoryPolicy':policy,
                'witness':self.heads.capture(session,value['customerId'],coupon_id)})
        return selections
    def request(self,value,selection):
        now=self.clock()
        return {'command':copy.deepcopy(value),'commandProof':digest(self.key,'command',value),
            'selection':{name:selection[name] for name in ('couponId','configurationHash','originConfigurationHash','couponInputHash','asOf','sourceTimeZone')},
            'witness':copy.deepcopy(selection['witness']),'issuedAt':now,'expiresAt':min(now+30000,value['expiresAt'])}
    def save(self,session,value,selections,documents,snapshot):
        check_command(session,value,self.key,('PREPARED',));self.check_snapshot(value,snapshot)
        if len(selections)!=len(documents) or len(selections)>2:unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
        for selection,document in zip(selections,documents):
            qualified(document,value,selection,self.key,self.clock())
            if self.heads.capture(session,value['customerId'],selection['couponId'])!=selection['witness']:unsafe('SCREENING_ORIGIN_COUPON_HEAD_CHANGED')
        body={'commandId':value['id'],'origin':value['origin'],'customerId':value['customerId'],'requestHash':value['requestHash'],
            'cartHash':value['cartHash'],'authorityHash':value['authorityHash'],'selections':copy.deepcopy(selections),'documents':copy.deepcopy(documents)}
        proof=digest(self.key,'coupon-preparation',body);identity=digest(self.key,'coupon-preparation-version',body)
        prior=rows(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_coupon_preparations WHERE id=:id FOR SHARE',{'id':identity},2)
        if prior:
            if len(prior)!=1 or json_value(prior[0]['data'])!=body or prior[0]['proof_hash']!=proof:unsafe()
        else:session.execute(text('INSERT INTO pos_rewrite_screening_origin_coupon_preparations(id,command_id,data,proof_hash,created_at_ms) VALUES(:id,:command,:data,:proof,:now)'),
            {'id':identity,'command':value['id'],'data':canonical(body),'proof':proof,'now':self.clock()})
        session.execute(text('INSERT INTO pos_rewrite_screening_origin_coupon_active(command_id,preparation_id,data,proof_hash) VALUES(:id,:version,:data,:proof) ON DUPLICATE KEY UPDATE preparation_id=VALUES(preparation_id),data=VALUES(data),proof_hash=VALUES(proof_hash)'),
            {'id':value['id'],'version':identity,'data':canonical(body),'proof':proof})
    @contextmanager
    def before(self,frame,snapshot=None):
        # Snapshot is acquired outside SQL by the genuine origin/CSK owner.
        snapshot=snapshot if snapshot is not None else getattr(frame,'coupon_snapshot',None)
        self.check_snapshot(frame.value,snapshot);check_command(frame.session,frame.value,self.key)
        stored=one(frame.session,'SELECT preparation_id,data,proof_hash FROM pos_rewrite_screening_origin_coupon_active WHERE command_id=:id AND OCTET_LENGTH(data)<=1000000 FOR SHARE',{'id':frame.value['id']})
        body=json_value(stored['data'])
        if (not isinstance(body,dict) or body.get('commandId')!=frame.value['id'] or body.get('requestHash')!=frame.value['requestHash']
                or body.get('cartHash')!=frame.value['cartHash'] or body.get('authorityHash')!=frame.value['authorityHash']
                or not hmac.compare_digest(digest(self.key,'coupon-preparation',body),stored['proof_hash'])
                or digest(self.key,'coupon-preparation-version',body)!=stored['preparation_id']):unsafe('SCREENING_ORIGIN_COUPON_HISTORY_REQUIRED')
        immutable=one(frame.session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_coupon_preparations WHERE id=:id AND command_id=:command FOR SHARE',{'id':stored['preparation_id'],'command':frame.value['id']})
        if json_value(immutable['data'])!=body or immutable['proof_hash']!=stored['proof_hash']:unsafe()
        # Recompute real current configuration and exact original cart selection;
        # no prepared code/cache assertion can authorize a changed current cart.
        current=self._current_selection(frame,body,snapshot)
        with self.heads.scope(frame,current) as heads:
            state=CouponScope(self,frame,current,body['documents'],snapshot,heads)
            if ACTIVE.get() is not None:unsafe()
            token=ACTIVE.set(state);frame.coupon_state=state
            try:yield state
            finally:ACTIVE.reset(token)
    def _current_selection(self,frame,body,snapshot):
        # The Frame already rechecks its original native cart hash. Current
        # coupon rows/cache settings are checked without redoing history reads.
        expected=body.get('selections')
        if not isinstance(expected,list) or len(expected)>2 or len(body.get('documents',[]))!=len(expected):unsafe()
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        cache=CurrentConfigurationCache(SnapshotCache(snapshot['config']));reader=Probe(frame.session,frame.value['customerId'])
        ns=compile_coupon(self.root,settings_namespace(self.coupon_settings,self._point(),reader,cache,ValidationException,ItemTypes,lambda *_a:False))
        ns['get_auto_apply_coupon'](reader);ns['get_birthday_coupon_details'](reader)
        policy=self.heads.policy(frame.session) if expected else None
        for selection,document in zip(expected,body['documents']):
            if selection.get('originHistoryPolicy')!=policy:unsafe('SCREENING_ORIGIN_COUPON_POLICY_CHANGED')
            current=current_coupon_control(frame.session,selection['couponId'])
            wanted=seal('coupon-configuration',{'cache':cache.values,'settings':self.coupon_settings,'couponInputHash':current['native_hash'],'originHistoryPolicy':policy},self.history_key)
            origin=digest(self.key,'coupon-configuration',{'cache':snapshot['config'],'effective':cache.values,'settings':self.coupon_settings,'prepaid':self.prepaid,'kind':frame.kind,'couponInputHash':current['native_hash']})
            if wanted!=selection['configurationHash'] or origin!=selection['originConfigurationHash'] or current['native_hash']!=selection['couponInputHash']:unsafe('SCREENING_ORIGIN_COUPON_CONFIGURATION_CHANGED')
            qualified(document,frame.value,selection,self.key,self.clock())
        return expected
    def capture(self,frame,header_hash,now):return capture_receipt(frame,getattr(frame,'coupon_state',None),header_hash,now)


class CouponScope:
    def __init__(self,owner,frame,selections,documents,snapshot,heads):
        self.owner,self.frame,self.heads=owner,frame,heads;self.settings={'PREPAID_AMT_DEDUCTION':owner.prepaid}
        self.cache=OriginCouponCache(owner,frame.session,frame.value,snapshot);self.entries={};self.active=None;self.validated=False;self.welcome_consent=None
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        for selection,document in zip(selections,documents):
            coupon=current_coupon_control(frame.session,selection['couponId'])
            assignments=current_coupon_assignments(frame.session,frame.value['customerId'],selection['couponId'])
            scope={'customerId':frame.value['customerId'],'couponId':selection['couponId'],'asOf':selection['asOf']}
            replay=CouponHistoryReplay({'scope':scope,**document['facts']},frame.session,coupon,assignments)
            point_value=datetime.strptime(selection['asOf'],'%Y-%m-%d %H:%M:%S')
            namespace=compile_coupon(owner.root,settings_namespace(owner.coupon_settings,point_value,replay,self.cache,ValidationException,ItemTypes,self.consent))
            self.entries[selection['couponId']]={'selection':selection,'document':document,'namespace':namespace,'replay':replay,
                'before':current_users(frame.session,frame.value['customerId'],selection['couponId']),'validated':False}
    @property
    def selection(self):return self.active['selection']
    @property
    def document(self):return self.active['document']
    @property
    def users_before(self):return self.active['before']
    def choose(self,coupon_id):
        found=self.entries.get(str(coupon_id))
        if found is None:unsafe('SCREENING_ORIGIN_COUPON_UNBOUND')
        self.active=found;return found
    def get_valid_coupon(self,_session,code,platform,user,db_fetch=True,is_pos=False):
        if not db_fetch or not user or str(user['user_id'])!=self.frame.value['customerId'] or bool(is_pos)!=(self.frame.kind=='pos'):unsafe()
        matches=rows(self.frame.session,'SELECT id,voucher_code FROM coupons WHERE voucher_code=:code LIMIT 2 FOR SHARE',{'code':code},2)
        if len(matches)!=1:unsafe('SCREENING_ORIGIN_COUPON_CODE_AMBIGUOUS')
        entry=self.choose(matches[0]['id'])
        result=entry['namespace']['get_valid_coupon'](entry['replay'],matches[0]['voucher_code'],platform,user,db_fetch=True,is_pos=is_pos)
        entry['validated']=True;self.validated=True;return result
    def apply_coupon(self,cart,coupon):
        entry=self.choose(coupon.get('coupon_id'))
        if not entry['validated']:unsafe('SCREENING_ORIGIN_COUPON_UNBOUND')
        return entry['namespace']['apply_coupon'](cart,coupon)
    def calculate_coupon_discount(self,cart,item):
        from controllers.cart.Cart import ItemTypes
        coupon=cart.get_item(ItemTypes.META,{'name':'coupon'})
        if coupon is None:return None
        return self.choose(coupon.get('coupon_id'))['namespace']['calculate_coupon_discount'](cart,item)
    def get_auto_apply_coupon(self,_session):
        if self.entries:
            entry=next(iter(self.entries.values()))
            return entry['namespace']['get_auto_apply_coupon'](entry['replay'])
        reader=Probe(self.frame.session,self.frame.value['customerId'])
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        ns=compile_coupon(self.owner.root,settings_namespace(self.owner.coupon_settings,self.owner._point(),reader,self.cache,ValidationException,ItemTypes,self.consent))
        return ns['get_auto_apply_coupon'](reader)
    def get_birthday_coupon_details(self,_session):
        if self.entries:
            entry=next(iter(self.entries.values()))
            return entry['namespace']['get_birthday_coupon_details'](entry['replay'])
        reader=Probe(self.frame.session,self.frame.value['customerId'])
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        ns=compile_coupon(self.owner.root,settings_namespace(self.owner.coupon_settings,self.owner._point(),reader,self.cache,ValidationException,ItemTypes,self.consent))
        return ns['get_birthday_coupon_details'](reader)
    def automatic(self,_session,user,cart,platform):
        if not user or str(user['user_id'])!=self.frame.value['customerId']:unsafe()
        for entry in self.entries.values():
            birthday=entry['namespace']['get_birthday_coupon_details'](entry['replay'])
            if birthday[0] and str(birthday[0])==entry['selection']['couponId']:
                self.active=entry
                return entry['namespace']['auto_apply_birthday_coupon'](entry['replay'],user,cart,platform)
        # Literal non-birthday/disabled paths still run their current controls;
        # no fake zero historical facts are supplied to a missing candidate.
        reader=Probe(self.frame.session,self.frame.value['customerId'])
        from controllers.cart.Cart import ItemTypes
        from controllers.cart.cartutils import ValidationException
        ns=compile_coupon(self.owner.root,settings_namespace(self.owner.coupon_settings,self.owner._point(),reader,self.cache,ValidationException,ItemTypes,self.consent))
        return ns['auto_apply_birthday_coupon'](reader,user,cart,platform)
    def consent(self,_session,customer_id):
        if str(customer_id)!=self.frame.value['customerId']:unsafe()
        indices=rows(self.frame.session,"SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='welcome_offer' AND SEQ_IN_INDEX=1 AND COLUMN_NAME='email_id' AND SUB_PART IS NULL AND IS_VISIBLE='YES' LIMIT 2",{},2)
        if not indices or not re.fullmatch(r'[A-Za-z0-9_]{1,64}',indices[0]['name']):unsafe('SCREENING_ORIGIN_COUPON_WELCOME_INDEX_REQUIRED')
        columns=rows(self.frame.session,"SELECT TABLE_NAME AS name,COLLATION_NAME AS collationName FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='users' AND COLUMN_NAME='email') OR (TABLE_NAME='welcome_offer' AND COLUMN_NAME='email_id')) LIMIT 3",{},3)
        if len(columns)!=2 or len({row['collationName'] for row in columns})!=1 or columns[0]['collationName'] is None:unsafe('SCREENING_ORIGIN_COUPON_WELCOME_INDEX_REQUIRED')
        # Exactly the original native join/equality; current User is already
        # locked by genuine authority. No date, user_id or coupon filter added.
        welcome_hash="LOWER(SHA2(CAST(JSON_OBJECT('id',wo.id,'email',wo.email_id) AS CHAR CHARACTER SET utf8mb4),256))"
        user_hash="LOWER(SHA2(CAST(JSON_OBJECT('id',u.id,'email',u.email) AS CHAR CHARACTER SET utf8mb4),256))"
        found=rows(self.frame.session,'SELECT wo.id,'+welcome_hash+' AS hash FROM users u STRAIGHT_JOIN welcome_offer wo FORCE INDEX(`'+indices[0]['name']+'`) ON wo.email_id=u.email WHERE u.id=:customer ORDER BY wo.id LIMIT 1001 FOR SHARE',{'customer':self.frame.value['customerId']},1001)
        if len(found)>1000:unsafe('SCREENING_ORIGIN_COUPON_WELCOME_LIMIT')
        native=one(self.frame.session,'SELECT '+user_hash+' AS hash FROM users u WHERE u.id=:customer FOR SHARE',{'customer':self.frame.value['customerId']})
        proof={'contract':'pos-screening-origin-welcome-consent-v1','customerId':self.frame.value['customerId'],'customerInputHash':native['hash'],
            'eligible':bool(found),'rows':[{'id':str(row['id']),'inputHash':row['hash']} for row in found]}
        if self.welcome_consent is not None and self.welcome_consent!=proof:unsafe('SCREENING_ORIGIN_COUPON_WELCOME_CHANGED')
        self.welcome_consent=proof
        return bool(found)
    def validate_after_native(self):self.heads.validate()


def install():
    """Source bootstrap calls this after the actual modules have loaded.

    Unselected callers keep their original function/defaults/return behavior.
    All aliases of these exact real exports are replaced, never a parallel fake
    source module. Construction/installation performs no network or SQL.
    """
    from controllers.cart.initializers import MetaInitializers
    from controllers.cart.validators import CouponValidation
    from controllers.cart.wrappers import CouponWrapper
    from libs import OrderHelper,helper
    if not isinstance(MetaInitializers.logger,ScopedLogger):MetaInitializers.logger=ScopedLogger(MetaInitializers.logger)
    targets=((MetaInitializers,'get_valid_coupon','get_valid_coupon'),(CouponValidation,'apply_coupon','apply_coupon'),
             (CouponWrapper,'calculate_coupon_discount','calculate_coupon_discount'),(OrderHelper,'auto_apply_birthday_coupon','automatic'),
             (OrderHelper,'get_auto_apply_coupon','get_auto_apply_coupon'),(helper,'get_birthday_coupon_details','get_birthday_coupon_details'))
    for module,name,method in targets:
        original=getattr(module,name)
        if getattr(original,'_origin_coupon_wrapper',False):continue
        def build(original,method):
            @wraps(original)
            def wrapped(*args,**kwargs):
                state=ACTIVE.get()
                return original(*args,**kwargs) if state is None else getattr(state,method)(*args,**kwargs)
            wrapped._origin_coupon_wrapper=True
            return wrapped
        replacement=build(original,method)
        for candidate in tuple(sys.modules.values()):
            if candidate is None or not getattr(candidate,'__name__','').startswith(('controllers.','libs.')):continue
            for alias,value in tuple(vars(candidate).items()):
                if value is original:setattr(candidate,alias,replacement)
