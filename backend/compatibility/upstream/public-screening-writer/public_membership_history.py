"""Copied public membership history. No warehouse/native history I/O in SQL."""
import copy
import hashlib
import hmac
import json
import os
import re
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
from native_authority import one,value_json
from protocol import canonical,digest
from writer_protocol import fail,portable_hash
import membership_history_heads

CONTRACT='pos-public-screening-membership-history-v1'
HASH=re.compile(r'[a-f0-9]{64}')


class NeedMembershipHistory(BaseException):
    def __init__(self,scope,head):self.scope,self.head=scope,head


def configuration(settings):
    from membership_profile import PINS
    value={'memberProductIds':sorted({str(value) for value in settings.MEMBERSHIP_PROD_ID},key=int),
           'freeProductId':str(settings.FREE_EXCLUSIVE_PRODUCT),'sourceCartHash':PINS['controllers/cart/Cart.py'],
           'exclusiveProducts':settings.EXCLUSIVE_PRODUCT,'upgradeProducts':settings.EXCLUSIVE_UPGRADE_PRODUCT}
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def request(cap,point,settings,session):
    if not isinstance(point,datetime) or point.tzinfo is not None:fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    zone=os.environ.get('BUSINESS_TIMEZONE','Asia/Kolkata')
    scope={name:cap[name] for name in ('operationId','checkoutId','customerId','requestHash','cartHash')}
    scope.update(contract=CONTRACT,configurationHash=configuration(settings),sourceTimeZone=zone,
                 asOf=point.strftime('%Y-%m-%d %H:%M:%S'),cutoff=(point-timedelta(days=45)).strftime('%Y-%m-%d %H:%M:%S'))
    return scope,membership_history_heads.capture(session,cap['customerId'])


def signature(body,key):
    if not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    value='{"kind":"public-screening.membership-history.document.v1","input":'+canonical(body)+'}'
    return hmac.new(key.encode(),value.encode(),hashlib.sha256).hexdigest()


def instant(wall,zone):
    point=datetime.strptime(wall,'%Y-%m-%d %H:%M:%S')
    aware=point.replace(tzinfo=ZoneInfo(zone))
    if aware.astimezone(ZoneInfo('UTC')).astimezone(ZoneInfo(zone)).replace(tzinfo=None)!=point:
        fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    return point,int(aware.timestamp()*1000)


class PreparedPublicMembershipHistory:
    def __init__(self,supplied,cap,key,settings,clock):
        self.clock=clock;self.cap=copy.deepcopy(cap)
        try:
            if (not isinstance(supplied,dict) or len(canonical(supplied).encode())>1000000
                    or set(supplied)!={'contract','scope','head','generationId','sourceCaptureHash','publicationHash','reader','complete','fetchedAt','expiresAt','selection','signature'}):raise ValueError()
            body={name:value for name,value in supplied.items() if name!='signature'}
            if (supplied['contract']!=CONTRACT or supplied['reader']!='bigquery' or supplied['complete'] is not True
                    or not isinstance(supplied['signature'],str) or not hmac.compare_digest(signature(body,key),supplied['signature'])
                    or any(not isinstance(supplied[name],str) or not HASH.fullmatch(supplied[name])
                           for name in ('generationId','sourceCaptureHash','publicationHash'))):raise ValueError()
            scope=supplied['scope']
            if (set(scope)!={'contract','operationId','checkoutId','customerId','requestHash','cartHash','configurationHash','sourceTimeZone','asOf','cutoff'}
                    or scope['contract']!=CONTRACT or scope['configurationHash']!=configuration(settings)
                    or any(scope[name]!=cap[name] for name in ('operationId','checkoutId','customerId','requestHash','cartHash'))
                    or scope['sourceTimeZone']!=os.environ.get('BUSINESS_TIMEZONE','Asia/Kolkata')):raise ValueError()
            self.point,source_at=instant(scope['asOf'],scope['sourceTimeZone'])
            if (self.point-timedelta(days=45)).strftime('%Y-%m-%d %H:%M:%S')!=scope['cutoff']:raise ValueError()
            now=clock()
            if (type(now) is not int or type(supplied['fetchedAt']) is not int or type(supplied['expiresAt']) is not int
                    or not source_at<=supplied['fetchedAt']<=now<supplied['expiresAt']<=cap['expiresAt']
                    or source_at+1000<=cap['issuedAt'] or supplied['expiresAt']>source_at+60000):raise ValueError()
            self._value=copy.deepcopy(supplied)
            self._facts=self._validate_selection(settings)
        except Exception:fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')

    def _validate_selection(self,settings):
        value=self._value['selection'];scope=self._value['scope']
        if not isinstance(value,dict) or set(value)!={'lastDeliveredOrder','recentDeliveredOrders'}:raise ValueError()
        recent,last=value['recentDeliveredOrders'],value['lastDeliveredOrder']
        if not isinstance(recent,list) or len(recent)>5000:raise ValueError()
        members={str(value) for value in settings.MEMBERSHIP_PROD_ID}
        count=0
        for order in ([last] if last is not None else [])+recent:
            if (not isinstance(order,dict) or set(order)!={'id','paymentMethod','createdAt','lines'}
                    or not re.fullmatch(r'[1-9][0-9]{0,18}',order['id'])
                    or type(order['paymentMethod']) is not int or not 0<=order['paymentMethod']<=32767
                    or not isinstance(order['lines'],list) or len(order['lines'])>10000):raise ValueError()
            datetime.strptime(order['createdAt'],'%Y-%m-%d %H:%M:%S')
            ids=set();flags=set()
            for row in order['lines']:
                if (not isinstance(row,dict) or set(row)!={'lineId','productId','isExclusiveOrder'}
                        or any(not isinstance(row[name],str) or not re.fullmatch(r'[1-9][0-9]{0,18}',row[name]) for name in ('lineId','productId'))
                        or type(row['isExclusiveOrder']) is not int or row['isExclusiveOrder'] not in (0,1)
                        or row['lineId'] in ids):raise ValueError()
                ids.add(row['lineId'])
                if row['productId'] not in members:flags.add(row['isExclusiveOrder'])
            count+=len(order['lines'])
            if len(flags)>1 or count>20000:raise ValueError()
        if (len({order['id'] for order in recent})!=len(recent)
                or any(not scope['cutoff']<order['createdAt'] for order in recent)
                or any(a['createdAt']<=b['createdAt'] for a,b in zip(recent,recent[1:]))
                or recent and last!=recent[0]
                or last is not None and last['createdAt']>scope['cutoff'] and not recent):raise ValueError()
        return {'scope':copy.deepcopy(scope),**copy.deepcopy(value)}

    def assert_current(self,cap,late=False,session=None):
        if (any(cap[name]!=self.cap[name] for name in ('operationId','checkoutId','customerId','requestHash','cartHash'))
                or not self._value['fetchedAt']<=self.clock()<self._value['expiresAt']):fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
        if late:
            if session is None:fail()
            membership_history_heads.validate(session,cap['customerId'],self._value['head'])
            if not self._value['fetchedAt']<=self.clock()<self._value['expiresAt']:fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')

    def facts(self):return copy.deepcopy(self._facts)
    def evidence(self):
        return {name:self._value[name] for name in ('generationId','fetchedAt','signature')}|{
            name:self._value['scope'][name] for name in ('asOf','cutoff')}


def retained(session,cap,proof_key):
    raw=one(session,'SELECT data,proof_hash FROM pos_rewrite_public_screening_benefit_preparations WHERE operation_id=:id AND OCTET_LENGTH(data)<=1100000 FOR SHARE',{'id':cap['operationId']})
    value=value_json(raw['data'])
    if (not isinstance(value,dict) or set(value)!={'contract','operationId','requestHash','cartHash','membershipHistory','preparedAt'}
            or value['contract']!='pos-public-screening-benefit-preparation-v1'
            or any(value[name]!=cap[name] for name in ('operationId','requestHash','cartHash'))
            or not hmac.compare_digest(digest(proof_key,'public-screening-benefit-preparation',value),raw['proof_hash'])
            or (value['membershipHistory'] is None and 'membershipHistoryHash' in cap)
            or (value['membershipHistory'] is not None and portable_hash(value['membershipHistory'])!=cap.get('membershipHistoryHash'))):fail()
    if value['membershipHistory'] is None:return None
    # Only scalar settings/configuration and the retained key are supplied by
    # the installed public source process; no browser reader is consulted.
    from source_frame import FRAME
    frame=FRAME.get()
    if frame is None or frame.owner.benefits is None:fail()
    return PreparedPublicMembershipHistory(value['membershipHistory'],cap,
        os.environ.get('POS_PUBLIC_SCREENING_MEMBERSHIP_HISTORY_KEY',''),frame.owner.benefits.settings,frame.owner.clock)
