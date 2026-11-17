"""Literal coupon discovery using current controls and no historical SQL."""
import copy
import json
import re
from datetime import datetime,timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo
from sqlalchemy import text
from benefit_source import BenefitReview,compile_coupon
from benefit_history import CouponHistoryReplay,Rows,seal
from benefit_receipts import current_coupon_control,current_coupon_assignments
from benefit_fence import coupon_history_statement
from membership_handoff import source_instant
from benefit_profile import CouponCandidate
from benefit_claims import GUARD_CONTRACT


class NeedCouponHistory(BaseException):
    """Cannot be swallowed by the original automatic-coupon catch-all."""
    def __init__(self,scope,witness):
        self.scope=copy.deepcopy(scope);self.witness=copy.deepcopy(witness)


class UnavailableCouponHeads:
    def assert_ready(self):raise BenefitReview('ORDER_IMPORT_COUPON_HEADS_UNQUALIFIED')
    def capture(self,_session,_scope):self.assert_ready()
    def scope(self,_session,_cap,_scope,_witness):self.assert_ready()
    def validate_after_native(self,_session,_scope,_witness,_native):self.assert_ready()


class CurrentConfigurationCache:
    """Read original source cache flags, retaining source fallback writes only
    in this invocation. No Redis warming/invalidation occurs under SQL.
    """
    def __init__(self,original):self.original=original;self.values={};self.checked=set();self.guard=None
    def _read(self,name):
        if name not in ('auto_apply_coupon','birthday_coupon'):raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        if name not in self.checked:
            self.checked.add(name)
            if self.original.exists(name):
                raw=self.original.get(name)
                if not isinstance(raw,(str,bytes)) or len(raw)>16000:raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
                value=json.loads(raw)
                if not isinstance(value,dict):raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
                self.values[name]=value
    def exists(self,name):
        if name.startswith('birthday_coupon_'):
            if self.guard is None:raise BenefitReview('ORDER_IMPORT_COUPON_PREFETCH_REQUIRED')
            return self.guard.exists(name)
        self._read(name);return name in self.values
    def get(self,name):
        if name.startswith('birthday_coupon_'):
            if self.guard is None:raise BenefitReview('ORDER_IMPORT_COUPON_PREFETCH_REQUIRED')
            return self.guard.get(name)
        self._read(name)
        return json.dumps(self.values[name]).encode() if name in self.values else None
    def set(self,name,value,ex=None):
        if name.startswith('birthday_coupon_'):
            if self.guard is None:raise BenefitReview('ORDER_IMPORT_COUPON_PREFETCH_REQUIRED')
            return self.guard.set(name,value,ex)
        if name not in ('auto_apply_coupon','birthday_coupon') or ex is not None:raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        if not isinstance(value,(str,bytes)) or len(value)>16000:raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        parsed=json.loads(value)
        if not isinstance(parsed,dict):raise BenefitReview('ORDER_IMPORT_COUPON_CACHE_UNQUALIFIED')
        self.checked.add(name);self.values[name]=parsed
        return True


class ProbeReader:
    def __init__(self,owner):self.owner=owner;self.replay=None
    def execute(self,query,parameters=None,*,params=None):
        if parameters is not None and params is not None:raise BenefitReview()
        parameters=params if params is not None else parameters
        sql=' '.join(str(query).split());normalized=sql.lower()
        # This exact current-control source SELECT precedes the first usage
        # count. Read it from the same writer and remember the configured ID.
        allowance=re.fullmatch(r"select no_times_allowed as num from tss\.coupons where id='([1-9][0-9]{0,9})';",normalized)
        if allowance:
            coupon=self.owner.bind_coupon(allowance[1])
            return Rows([{'num':coupon['no_times_allowed']}])
        if coupon_history_statement(sql):
            self.owner.need_history()
        if self.replay is not None:return self.replay.execute(query,parameters)
        uid=self.owner.cap['authority']['customerId']
        allowed=(f'select birthdate, email from users where id={uid}',
                 "select status, value from tss_settings where platform='auto_apply_coupon'",
                 "select status from tss_settings where platform='birthday_coupon'",
                 "select * from coupons join tss_settings on coupons.id = tss_settings.value where tss_settings.platform='birthday_coupon';")
        if normalized not in allowed:raise BenefitReview('ORDER_IMPORT_COUPON_CURRENT_QUERY_UNQUALIFIED')
        statement=sql.rstrip(';')+' LIMIT 2 FOR SHARE'
        result=self.owner.session.execute(text(statement),parameters or {})
        values=result.mappings().fetchmany(2) if hasattr(result,'mappings') else result.fetchall()
        if hasattr(result,'close'):result.close()
        if len(values)>1:raise BenefitReview('ORDER_IMPORT_COUPON_CURRENT_ROWS_AMBIGUOUS')
        return Rows([dict(row) for row in values])
    def fetch_one(self,session,query,params=None,to_dict=False):
        if session is not self:raise BenefitReview()
        row=self.execute(query,params).fetchone()
        return dict(row) if row is not None and to_dict else row
    def fetch(self,session,query,params=None,to_dict=False):
        if session is not self:raise BenefitReview()
        values=self.execute(query,params).fetchall()
        return [dict(row) for row in values] if to_dict else values


class CouponControls:
    def __init__(self,root,session,cap,plan,source_key,source_cache,settings,item_types,error_type,heads,clock,point_factory,zone,history=None,preview=False):
        self.root,self.session,self.cap,self.plan=root,session,cap,plan
        self.source_key,self.settings,self.item_types=source_key,copy.deepcopy(settings),item_types
        self.clock,self.point_factory,self.zone=clock,point_factory,zone
        self.history,self.preview,self.heads=history,preview,heads;self.error_type=error_type
        self.cache=CurrentConfigurationCache(source_cache)
        self.coupon=None;self.scope=None;self.witness=None;self.candidate=None
        self.reader=ProbeReader(self)
        self._point=history.point if history is not None else None
        owner=self
        class FrozenDateTime(datetime):
            @classmethod
            def now(cls,tz=None):
                if tz is not None:raise BenefitReview('ORDER_IMPORT_COUPON_CLOCK_UNQUALIFIED')
                return owner.point
        self.namespace=compile_coupon(root,{
            'datetime':SimpleNamespace(datetime=FrozenDateTime,now=lambda:owner.point),'date':SimpleNamespace(today=lambda:owner.point.date()),
            'json':json,'text':text,'Session':self.reader,'SessionR':self.reader,'redis_object':self.cache,
            'fetchOne':self.reader.fetch_one,'fetch':self.reader.fetch,'logger':SimpleNamespace(debug=lambda *_a:None,error=lambda *_a:None,info=lambda *_a:None),
            'ValidationException':error_type,'settings':SimpleNamespace(**copy.deepcopy(settings)),
            'ItemTypes':item_types,**{name:settings[name] for name in ('BIRTHDAY_MESSAGE','EMPLOYEE_COUPON_DOMAIN_MAP','REDIS_COUPON_EXPIRY_IN_SEC')},
            'check_user_in_table':lambda *_a:(_ for _ in ()).throw(BenefitReview('ORDER_IMPORT_WELCOME_COUPON_PROFILE_REQUIRED'))})

    @property
    def point(self):
        if self._point is None:self._point=self.execution_point()
        return self._point

    def execution_point(self):
        value=self.point_factory()
        if not isinstance(value,datetime) or value.tzinfo is not None:raise BenefitReview('ORDER_IMPORT_COUPON_CLOCK_UNQUALIFIED')
        point=value.replace(microsecond=0)
        _value,instant=source_instant(point.strftime('%Y-%m-%d %H:%M:%S'),ZoneInfo(self.zone))
        if not 0<=self.clock()-instant<1000:raise BenefitReview('ORDER_IMPORT_COUPON_CLOCK_UNQUALIFIED')
        return point

    def bind_coupon(self,coupon_id):
        if self.coupon is not None:
            if str(self.coupon['coupon_id'])!=coupon_id:raise BenefitReview('ORDER_IMPORT_COUPON_CONFIGURATION_CHANGED')
            return self.coupon
        self.coupon=current_coupon_control(self.session,coupon_id)
        scope={'contract':'pos-csv-coupon-history-v1','operationId':self.cap['operationId'],
            'requestHash':self.cap['requestHash'],'planHash':self.cap['planHash'],'customerId':self.cap['authority']['customerId'],
            'couponId':coupon_id,'configurationHash':seal('coupon-configuration',{'cache':self.cache.values,'settings':self.settings,'couponInputHash':self.coupon['native_hash']},self.source_key),
            'asOf':self.point.strftime('%Y-%m-%d %H:%M:%S'),'sourceTimeZone':self.zone}
        self.scope=scope
        users=current_coupon_assignments(self.session,scope['customerId'],coupon_id)
        # Only the current-query arm is used before a complete document exists.
        self.reader.replay=CouponHistoryReplay({'scope':scope},self.session,self.coupon,users)
        return self.coupon

    def need_history(self):
        if self.scope is None:raise BenefitReview('ORDER_IMPORT_COUPON_HISTORY_QUERY_UNQUALIFIED')
        if self.cap.get('benefitContracts',{}).get('automaticCoupon')!='pos-csv-automatic-coupon-v1':
            raise BenefitReview('ORDER_IMPORT_COUPON_PROFILE_REQUIRED')
        self.heads.assert_ready()
        if self.history is not None:
            self.history.assert_current(self.scope)
            if self.candidate is None:
                candidate=CouponCandidate(self.root,session=self.session,expected_history=self.scope,
                    document=self.history.value['document'],history_key=self.history.history_key,source_key=self.source_key,
                    guard_key=self.history.guard_key,guard_observation=self.history.value['guardObservation'],guard_contract=GUARD_CONTRACT,
                    now_ms=self.clock(),configuration_cache=self.cache.values,settings=self.settings,item_types=self.item_types,validation_error=self.error_type)
                if self.preview:
                    candidate.cache=PreviewBirthdayCache(candidate.cache)
                    candidate.namespace['redis_object']=candidate.cache
                self.candidate=candidate
                self.reader.replay=candidate.replay
                self.cache.guard=candidate.cache
                self.witness=copy.deepcopy(self.history.value['witness'])
            return
        if not self.preview:raise BenefitReview('ORDER_IMPORT_COUPON_PREFETCH_REQUIRED')
        self.witness=self.heads.capture(getattr(self.session,'session',self.session),self.scope)
        raise NeedCouponHistory(self.scope,self.witness)


class PreviewBirthdayCache:
    """Run literal eligibility without minting a real SQL guard/claim."""
    def __init__(self,original):
        self.original=original;self.claim=None;self.guard=None
    def exists(self,name):
        if name!=self.original.key_name:return self.original.exists(name)
        if self.guard is None:
            query='SELECT operation_id,expires_at_ms FROM pos_rewrite_import_birthday_guards WHERE customer_id=:customer LIMIT 2 FOR SHARE'
            result=self.original.session.execute(text(query),{'customer':self.original.scope['customerId']})
            rows=result.mappings().fetchmany(2) if hasattr(result,'mappings') else result.fetchall()
            if hasattr(result,'close'):result.close()
            if len(rows)>1:raise BenefitReview()
            self.guard={} if not rows else dict(rows[0])
        return (self.original.legacy_present or self.claim is not None or
                int(self.guard.get('expires_at_ms',0))>self.original.now_ms and self.guard.get('operation_id')!=self.original.scope['operationId'])
    def get(self,name):
        if name==self.original.key_name:return b'{"is_applied":true}' if self.exists(name) else None
        return self.original.get(name)
    def set(self,name,value,ex=None):
        if name!=self.original.key_name:return self.original.set(name,value,ex)
        if type(ex) is not int or not 1<=ex<=2592000 or json.loads(value)!={'is_applied':True}:raise BenefitReview()
        if self.exists(name):raise BenefitReview('ORDER_IMPORT_BIRTHDAY_ALREADY_CLAIMED')
        # No UUID, receipt, external guard or positive financial evidence.
        self.claim={'preview':True}
        return True
