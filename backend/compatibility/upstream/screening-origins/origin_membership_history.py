"""Membership facts bound to a genuine source command, never a POS capability.

The provider runs outside SQL. Inside the source transaction only the current
head and already authenticated selection are used. Literal source SELECTs are
replayed by membership_history.HistorySession; there is no history fallback.
"""
import copy
import hmac
import os
import re
from datetime import datetime,timedelta
from uuid import UUID
import membership_history_heads
from origin_contracts import command,digest,point,unsafe
from public_membership_history import configuration,instant,validate_selection

CONTRACT='pos-screening-origin-membership-history-v1'
IDENTITY=('origin','customerId','requestHash','cartHash','authorityHash')
HASH=re.compile(r'[a-f0-9]{64}')


def refused():unsafe('SCREENING_ORIGIN_MEMBERSHIP_UNQUALIFIED')


class NeedOriginMembershipHistory(BaseException):
    def __init__(self,scope,head):
        self.scope,self.head=copy.deepcopy(scope),copy.deepcopy(head)


def request(value,source_point,settings,session):
    command(value)
    if (value['phase']!='PREPARED' or value['orderId'] is not None
            or not isinstance(source_point,datetime) or source_point.tzinfo is not None):refused()
    source_point=source_point.replace(microsecond=0)
    scope={'contract':CONTRACT,'commandId':value['id'],
           **{name:value[name] for name in IDENTITY},
           'configurationHash':configuration(settings),
           'sourceTimeZone':os.environ.get('BUSINESS_TIMEZONE','Asia/Kolkata'),
           'asOf':source_point.strftime('%Y-%m-%d %H:%M:%S'),
           'cutoff':(source_point-timedelta(days=45)).strftime('%Y-%m-%d %H:%M:%S')}
    return scope,membership_history_heads.capture(session,value['customerId'])


def _head(value):
    if (not isinstance(value,dict) or set(value)!={'contract','origin','revision','writersHash'}
            or value['contract']!='pos-membership-history-head-v1'
            or not isinstance(value['origin'],dict) or set(value['origin'])!={'schema','serverUuid'}
            or not isinstance(value['origin']['schema'],str)
            or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',value['origin']['schema'])
            or not isinstance(value['revision'],str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}',value['revision'])
            or int(value['revision'])>18446744073709551615
            or not isinstance(value['writersHash'],str) or not HASH.fullmatch(value['writersHash'])
            or str(UUID(value['origin']['serverUuid']))!=value['origin']['serverUuid']):refused()


class PreparedOriginMembershipHistory:
    def __init__(self,supplied,value,key,settings,clock):
        self.clock,self.value=clock,copy.deepcopy(command(value))
        try:
            from origin_contracts import canonical
            if (self.value['phase']!='PREPARED' or self.value['orderId'] is not None
                    or not isinstance(supplied,dict) or len(canonical(supplied).encode())>2000000
                    or set(supplied)!={'contract','scope','head','generationId','sourceCaptureHash','publicationHash',
                                      'reader','complete','fetchedAt','expiresAt','selection','signature'}):refused()
            body={name:item for name,item in supplied.items() if name!='signature'}
            if (supplied['contract']!=CONTRACT or supplied['reader']!='bigquery' or supplied['complete'] is not True
                    or any(not isinstance(supplied[name],str) or not HASH.fullmatch(supplied[name])
                           for name in ('signature','generationId','sourceCaptureHash','publicationHash'))
                    or not hmac.compare_digest(digest(key,'membership-history',body),supplied['signature'])):refused()
            scope=supplied['scope']
            if (not isinstance(scope,dict) or set(scope)!={'contract','commandId',*IDENTITY,'configurationHash','sourceTimeZone','asOf','cutoff'}
                    or scope['contract']!=CONTRACT or scope['commandId']!=value['id']
                    or any(scope[name]!=value[name] for name in IDENTITY)
                    or scope['configurationHash']!=configuration(settings)
                    or scope['sourceTimeZone']!=os.environ.get('BUSINESS_TIMEZONE','Asia/Kolkata')):refused()
            self.point,source_at=instant(scope['asOf'],scope['sourceTimeZone'])
            now=clock()
            if ((self.point-timedelta(days=45)).strftime('%Y-%m-%d %H:%M:%S')!=scope['cutoff']
                    or not all(point(item) for item in (now,supplied['fetchedAt'],supplied['expiresAt']))
                    or not source_at<=supplied['fetchedAt']<=now<supplied['expiresAt']<=min(value['expiresAt'],source_at+60000)
                    or source_at<value['createdAt']-999):refused()
            _head(supplied['head'])
            self._facts=validate_selection(supplied['selection'],scope,settings.MEMBERSHIP_PROD_ID)
            self._document=copy.deepcopy(supplied)
        except Exception:refused()

    def assert_current(self,value,late=False,session=None):
        command(value)
        if (value['id']!=self.value['id'] or any(value[name]!=self.value[name] for name in IDENTITY)
                or not self._document['fetchedAt']<=self.clock()<min(self._document['expiresAt'],value['expiresAt'])):refused()
        if late:
            if session is None:refused()
            membership_history_heads.validate(session,value['customerId'],self._document['head'])
            if not self._document['fetchedAt']<=self.clock()<self._document['expiresAt']:refused()

    def facts(self):return copy.deepcopy(self._facts)

    def evidence(self):
        return {name:self._document[name] for name in ('generationId','sourceCaptureHash','publicationHash','signature','fetchedAt','expiresAt')}|{
            name:self._document['scope'][name] for name in ('asOf','cutoff','configurationHash')}
