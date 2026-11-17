"""Verify a Node-prepared warehouse document before opening any SQL scope.

The per-request reader performs memory/HMAC checks only. It cannot refresh a
generation, issue SQL/HTTP or replace missing evidence with empty history.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime,timedelta,timezone
import hashlib
import hmac
import re
from zoneinfo import ZoneInfo

from protocol import ImportReview,canonical,digest
from membership_history import CONTRACT,request,validate
from transaction import CURRENT,VIOLATION

CONTRACT_PREFETCH='pos-csv-membership-prefetch-v1'
CURRENT_HISTORY=ContextVar('pos_import_prepared_membership_history',default=None)
HASH=re.compile(r'[a-f0-9]{64}')


def invalid():
    raise ImportReview('ORDER_IMPORT_MEMBERSHIP_PREFETCH_INVALID') from None


def signed(kind,value,key):
    if not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):invalid()
    body='{"kind":'+canonical('legacy-order-imports.'+kind+'.v1')+',"input":'+canonical(value)+'}'
    return hmac.new(key.encode(),body.encode(),hashlib.sha256).hexdigest()


def source_instant(value,zone):
    try:
        point=datetime.strptime(value,'%Y-%m-%d %H:%M:%S')
        if point.strftime('%Y-%m-%d %H:%M:%S')!=value:invalid()
        offsets=set()
        for fold in (0,1):
            candidate=point.replace(tzinfo=zone,fold=fold)
            if candidate.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)==point:
                offsets.add(candidate.utcoffset())
        # Reject both nonexistent and ambiguous source wall seconds, as Node
        # Temporal does. A fold flag must never choose a different generation.
        if len(offsets)!=1:invalid()
        return point,int(point.replace(tzinfo=zone).timestamp()*1000)
    except (ValueError,TypeError,OverflowError):invalid()


class PreparedMembershipHistory:
    def __init__(self,supplied,capability,auth_key,history_key,member_ids,source_zone,clock):
        if CURRENT.get() is not None:invalid()
        self.clock=clock
        self.key=history_key
        self.member_ids=frozenset(member_ids)
        violation=VIOLATION.set(False)
        try:
            if (not isinstance(supplied,dict) or set(supplied)!={'document','capability'}
                    or len(canonical(supplied).encode())>1100000):invalid()
            # Own the input: a concurrent caller cannot replace a document or
            # scope between its signature check and literal source evaluation.
            self.value=deepcopy(supplied)
            self.cap=self.value['capability']
            if (not isinstance(self.cap,dict) or set(self.cap)!=
                    {'contract','scope','sourceTimeZone','generationId','documentHash','expiresAt','signature'}):invalid()
            self.scope=self.cap['scope']
            if (not isinstance(self.scope,dict) or set(self.scope)!=
                    {'contract','operationId','requestHash','planHash','customerId','asOf','cutoff'}):invalid()
            expected={'contract':CONTRACT,'operationId':capability['operationId'],
                      'requestHash':capability['requestHash'],'planHash':capability['planHash'],
                      'customerId':capability['authority']['customerId']}
            if (any(self.scope[name]!=value for name,value in expected.items())
                    or self.cap['contract']!=CONTRACT_PREFETCH or self.cap['sourceTimeZone']!=source_zone
                    or any(not isinstance(self.cap[name],str) or not HASH.fullmatch(self.cap[name])
                           for name in ('generationId','documentHash','signature'))
                    or not isinstance(capability.get('membershipHistoryHash'),str)
                    or not hmac.compare_digest(capability['membershipHistoryHash'],digest(auth_key,'membership-history',self.value))):invalid()
            zone=ZoneInfo(source_zone)
            self.point,self.as_of_ms=source_instant(self.scope['asOf'],zone)
            if self.scope['cutoff']!=(self.point-timedelta(days=45)).strftime('%Y-%m-%d %H:%M:%S'):invalid()
            self._validate()
        except ImportReview:
            invalid()
        except Exception:
            invalid()
        finally:
            VIOLATION.reset(violation)

    def _validate(self):
        now=self.clock()
        if type(now) is not int or now<=0:invalid()
        document=validate(self.value['document'],self.scope,self.key,self.member_ids,now)
        body={key:value for key,value in self.cap.items() if key!='signature'}
        if (type(self.cap['expiresAt']) is not int or not self.as_of_ms<=now<self.cap['expiresAt']
                or self.cap['expiresAt']>min(document['fetchedAt']+60000,self.as_of_ms+60000)
                or self.cap['generationId']!=document['generationId']
                or not hmac.compare_digest(self.cap['signature'],signed('membership-prefetch',body,self.key))
                or not hmac.compare_digest(self.cap['documentHash'],signed('membership-document',document,self.key))):invalid()
        return document

    def execution_clock(self,state):
        if request(state,self.point)!=self.scope:invalid()
        self._validate()
        return self.point

    def read(self,query):
        if query!=self.scope:invalid()
        return deepcopy(self._validate())


@contextmanager
def prepared_history(supplied,capability,auth_key,history_key,member_ids,source_zone,clock):
    if CURRENT_HISTORY.get() is not None:invalid()
    reader=None
    if supplied is not None:
        reader=PreparedMembershipHistory(supplied,capability,auth_key,history_key,member_ids,source_zone,clock)
    elif 'membershipHistoryHash' in capability:
        invalid()
    token=CURRENT_HISTORY.set(reader)
    try:
        yield reader
    finally:
        CURRENT_HISTORY.reset(token)
