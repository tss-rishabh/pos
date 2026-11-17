"""Purpose-bound copied coupon evidence, validated before source SQL begins.

The source replay performs memory/HMAC checks only. It never obtains a new
warehouse generation, legacy absence or head witness inside a transaction.
"""
import copy
import hmac
import re
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta
from uuid import UUID
from zoneinfo import ZoneInfo
from protocol import digest
from transaction import CURRENT,VIOLATION
from membership_handoff import source_instant
from benefit_history import canonical,qualify,seal
from benefit_source import BenefitReview

CONTRACT='pos-csv-coupon-prefetch-v1'
COUPON='pos-csv-automatic-coupon-v1'
MAXIMUM_BYTES=300000
CURRENT_COUPON_HISTORY=ContextVar('pos_import_coupon_prefetch',default=None)
HASH=re.compile(r'[a-f0-9]{64}')


def invalid():raise BenefitReview('ORDER_IMPORT_COUPON_PREFETCH_INVALID') from None


def witness_hash(scope,witness,key):
    try:
        if not isinstance(witness,dict) or set(witness)!={'writersContract','writersDefinitionHash','serverUuid','sourceSchema','heads'}:invalid()
        if (witness['writersContract']!='pos-csv-coupon-history-all-writers-v1'
                or not HASH.fullmatch(witness['writersDefinitionHash'])
                or str(UUID(witness['serverUuid']))!=witness['serverUuid']
                or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',witness['sourceSchema'])):invalid()
        heads=witness['heads']
        if not isinstance(heads,list) or len(heads)!=3:invalid()
        for row,kind,scope_id in zip(heads,('controls','coupon','customer'),('0',scope['couponId'],scope['customerId'])):
            if (not isinstance(row,dict) or set(row)!={'kind','scopeId','revision'} or row['kind']!=kind or row['scopeId']!=scope_id
                    or not isinstance(row['revision'],str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}',row['revision'])
                    or int(row['revision'])>18446744073709551615):invalid()
        return seal('coupon-control-head',{'scope':scope,'serverUuid':witness['serverUuid'],'sourceSchema':witness['sourceSchema'],
            'writersDefinitionHash':witness['writersDefinitionHash'],'heads':heads},key)
    except Exception:invalid()


def guard_observation(value,scope,key,now):
    try:
        body={name:item for name,item in value.items() if name!='signature'}
        if (set(body)!={'contract','operationId','requestHash','customerId','observedAt','present'}
                or body['contract']!='pos-csv-birthday-cooperative-guard-v1'
                or any(body[name]!=scope[name] for name in ('operationId','requestHash','customerId'))
                or type(body['present']) is not bool or type(body['observedAt']) is not int
                or not 0<=now-body['observedAt']<60000
                or not isinstance(value.get('signature'),str)
                or not hmac.compare_digest(seal('birthday-observation',body,key),value['signature'])):invalid()
        return copy.deepcopy(value)
    except Exception:invalid()


class PreparedCouponHistory:
    def __init__(self,supplied,capability,auth_key,history_key,source_key,guard_key,zone,clock):
        if CURRENT.get() is not None:invalid()
        violation=VIOLATION.set(False)
        try:
            if (len({auth_key,history_key,source_key,guard_key})!=4
                    or any(not isinstance(value,str) or not re.fullmatch(r'[!-~]{32,4096}',value) for value in (auth_key,history_key,source_key,guard_key))
                    or not isinstance(supplied,dict) or set(supplied)!={'document','capability','witness','guardObservation'}
                    or len(canonical(supplied).encode())>MAXIMUM_BYTES
                    or capability.get('benefitContracts',{}).get('automaticCoupon')!=COUPON
                    or not isinstance(capability.get('couponHistoryHash'),str)
                    or not hmac.compare_digest(capability['couponHistoryHash'],digest(auth_key,'coupon-history',supplied))):invalid()
            self._value=copy.deepcopy(supplied);self._cap=self._value['capability'];self._scope=self._cap['scope']
            cap=self._cap;scope=self._scope
            if (set(cap)!={'contract','scope','generationId','documentHash','controlHeadHash','guardObservationHash','expiresAt','signature'}
                    or cap['contract']!=CONTRACT):invalid()
            expected={'operationId':capability['operationId'],'requestHash':capability['requestHash'],
                      'planHash':capability['planHash'],'customerId':capability['authority']['customerId'],'sourceTimeZone':zone}
            if any(scope[name]!=value for name,value in expected.items()):invalid()
            self.clock=clock;self.history_key=history_key;self.source_key=source_key;self.guard_key=guard_key
            self.point,self.as_of=source_instant(scope['asOf'],ZoneInfo(zone))
            end=self.point.replace(hour=0,minute=0,second=0)+timedelta(days=1)
            _end,self.day_end=source_instant(end.strftime('%Y-%m-%d %H:%M:%S'),ZoneInfo(zone))
            self._document=self._validate()
            self._not_before=max(self.as_of,self._document['fetchedAt'],self._value['guardObservation']['observedAt'])
        except Exception:invalid()
        finally:VIOLATION.reset(violation)

    def _validate(self):
        now=self.clock()
        if type(now) is not int or not 0<now<=9007199254740991:invalid()
        document=qualify(self._value['document'],self._scope,self.history_key,now)
        observation=guard_observation(self._value['guardObservation'],self._scope,self.guard_key,now)
        cap=self._cap;body={name:value for name,value in cap.items() if name!='signature'}
        control=witness_hash(self._scope,self._value['witness'],self.source_key)
        expiry=min(self.as_of+60000,document['fetchedAt']+60000,observation['observedAt']+60000,self.day_end)
        if (any(not isinstance(cap[name],str) or not HASH.fullmatch(cap[name]) for name in ('generationId','documentHash','controlHeadHash','guardObservationHash','signature'))
                or cap['generationId']!=document['generationId']
                or cap['documentHash']!=seal('coupon-history-document',document,self.history_key)
                or cap['controlHeadHash']!=control or document['publication']['controlHeadHash']!=control
                or cap['guardObservationHash']!=seal('birthday-observation-document',observation,self.history_key)
                or type(cap['expiresAt']) is not int or not self.as_of<=now<cap['expiresAt']<=expiry
                or not hmac.compare_digest(cap['signature'],seal('coupon-prefetch',body,self.history_key))):invalid()
        return document

    @property
    def value(self):return copy.deepcopy(self._value)

    @property
    def scope(self):return copy.deepcopy(self._scope)

    def assert_current(self,scope):
        # The entire document was copied/authenticated before SQL. Source
        # helpers cannot mutate its retained bytes through the public getters.
        # Repeated literal cart passes need only exact scope and live lease
        # checks, not hundreds of 300KB JSON/HMAC re-encodings under row locks.
        now=self.clock()
        if (scope!=self._scope or type(now) is not int or not 0<now<=9007199254740991
                or not self._not_before<=now<self._cap['expiresAt']):invalid()

    def read(self,scope):
        self.assert_current(scope)
        return copy.deepcopy(self._document)


@contextmanager
def prepared_coupon_history(supplied,capability,auth_key,history_key,source_key,guard_key,zone,clock):
    if CURRENT_COUPON_HISTORY.get() is not None:invalid()
    prepared=None if supplied is None else PreparedCouponHistory(supplied,capability,auth_key,history_key,source_key,guard_key,zone,clock)
    token=CURRENT_COUPON_HISTORY.set(prepared)
    try:yield prepared
    finally:CURRENT_COUPON_HISTORY.reset(token)
