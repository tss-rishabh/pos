"""Qualified history handoff for literal customer Order queries.

Only generation-backed counts leave BigQuery. The current native change head
is operational synchronization metadata, not a reader of old order facts.
No MySQL lifetime COUNT is issued by this module.
"""
import copy
import hmac
import hashlib
import json
import re
import os
from pathlib import Path
from contextlib import contextmanager
from contextvars import ContextVar
from sqlalchemy import event
from sqlalchemy import text
from native import one,rows,json_value
from transaction import LegacyRow
from origin_contracts import digest,canonical,identifier,fail,unsafe,HASH,point

HISTORY='pos-screening-origin-history-v1'
HEAD='pos-screening-origin-history-head-v1'
ACTIVE=ContextVar('screening_origin_history',default=None)
NATIVE=ContextVar('screening_origin_trusted_native',default=False)
class HistoryReadRefused(BaseException):pass
WELCOME='select count(id) from orders where user_id = :user_id and not order_status = 4'
APP=re.compile(r'^select count\(id\) as order_count from orders where user_id\s*=\s*([1-9][0-9]*) and order_status\s*=\s*3 and flag_id\s*(!=|=)\s*18$',re.I)


def normal(value):return re.sub(r'\s+',' ',str(value).strip()).rstrip(';').strip()


def head(session,customer,lock=False):
    definition=(Path(__file__).parent/'history-heads.review.sql').read_text()
    expected=[]
    for name,action,table,body in re.findall(r'CREATE TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW\s*(.*?)END\$\$',definition,re.S):
        expected.append({'name':name,'action':action,'table':table,'body':' '.join((body+'END').split())})
    definer=os.environ.get('POS_SCREENING_ORIGIN_HISTORY_DEFINER','')
    if len(expected)!=4 or not re.fullmatch(r'[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}',definer):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    origin=one(session,'SELECT DATABASE() AS sourceSchema,@@GLOBAL.server_uuid AS serverUuid,@@GLOBAL.read_only AS reader,@@GLOBAL.super_read_only AS superReader')
    if origin['reader']!=0 or origin['superReader']!=0:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    # MDL is retained while qualifying the exact private definer implementations.
    session.execute(text('SELECT id FROM orders WHERE FALSE')).close()
    installed=rows(session,"SELECT TRIGGER_NAME AS name,EVENT_MANIPULATION AS action,EVENT_OBJECT_TABLE AS sourceTable,ACTION_STATEMENT AS body,DEFINER AS owner,SQL_MODE AS sqlMode FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME LIKE 'pos_rewrite_origin_history_%'",limit=5)
    if len(installed)!=4:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    for item in expected:
        found=[row for row in installed if row['name']==item['name']]
        if (len(found)!=1 or found[0]['owner']!=definer or found[0]['action']!=item['action'] or found[0]['sourceTable']!=item['table']
                or ' '.join(found[0]['body'].split())!=item['body']
                or not {'STRICT_TRANS_TABLES','STRICT_ALL_TABLES'}.intersection(found[0]['sqlMode'].split(','))):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    value=one(session,'SELECT customer_id,revision FROM pos_rewrite_screening_origin_history_heads WHERE customer_id=:customer'+(' FOR SHARE' if lock else ''),{'customer':identifier(customer)})
    if str(value['customer_id'])!=str(customer) or not re.fullmatch(r'0|[1-9][0-9]{0,19}',str(value['revision'])):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    return {'contract':HEAD,'sourceSchema':origin['sourceSchema'],'sourceServerUuid':origin['serverUuid'],'revision':str(value['revision']),
            'writersHash':hashlib.sha256(canonical({'definitions':expected,'definer':definer}).encode()).hexdigest()}


def qualified(document,key,command,now):
    fields={'contract','commandId','customerId','requestHash','cartHash','witness','generationId','sourceCompleteThrough',
            'reader','complete','welcomeCount','appCashbackCount','webCashbackCount','fetchedAt','expiresAt','signature'}
    if (not isinstance(document,dict) or set(document)!=fields or document['contract']!=HISTORY
            or document['reader']!='bigquery' or document['complete'] is not True
            or any(document[name]!=command[target] for name,target in (('commandId','id'),('customerId','customerId'),('requestHash','requestHash'),('cartHash','cartHash')))
            or any(not isinstance(document[name],str) or not HASH.fullmatch(document[name]) for name in ('generationId','signature'))
            or not isinstance(document['witness'],dict) or set(document['witness'])!={'contract','sourceSchema','sourceServerUuid','revision','writersHash'}
            or document['witness']['contract']!=HEAD or not isinstance(document['witness']['revision'],str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}',document['witness']['revision'])
            or any(not isinstance(document[name],str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}',document[name]) for name in ('welcomeCount','appCashbackCount','webCashbackCount'))
            or any(not point(document[name]) for name in ('sourceCompleteThrough','fetchedAt','expiresAt'))
            or not document['sourceCompleteThrough']<=document['fetchedAt']<=now<document['expiresAt']<=min(document['fetchedAt']+60000,command['expiresAt'])
            or not hmac.compare_digest(digest(key,'history',{name:value for name,value in document.items() if name!='signature'}),document['signature'])):
        fail('SCREENING_ORIGIN_HISTORY_REQUIRED')
    return copy.deepcopy(document)


class CountResult:
    def __init__(self,name,value):self.row=LegacyRow({name:value})
    def fetchone(self):return self.row
    def first(self):return self.row
    def fetchall(self):return [self.row]
    def __iter__(self):return iter([self.row])


class Replay:
    def __init__(self,session,document):self.session,self.document=session,document;self.own_order=None
    def inserted(self,order_id):
        if self.own_order is not None:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
        self.own_order=identifier(order_id)
    def execute(self,statement,parameters=None,**kwargs):
        query=normal(statement);params=parameters if parameters is not None else kwargs.get('params')
        if query.lower()==WELCOME:
            if not isinstance(params,dict) or set(params)!={'user_id'} or str(params['user_id'])!=self.document['customerId']:fail('SCREENING_ORIGIN_HISTORY_SCOPE_CHANGED')
            # The pinned welcome query occurs after the original Order INSERT.
            # Its one own row is a current native read, never an old-data scan.
            if self.own_order is None:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
            row=one(self.session,'SELECT user_id,order_status FROM orders WHERE id=:id FOR SHARE',{'id':self.own_order})
            if str(row['user_id'])!=self.document['customerId']:fail()
            delta=1 if row['order_status'] is not None and row['order_status']!=4 else 0
            return CountResult('count(id)',int(self.document['welcomeCount'])+delta)
        match=APP.fullmatch(query)
        if match:
            if match.group(1)!=self.document['customerId'] or params not in (None,{}):fail('SCREENING_ORIGIN_HISTORY_SCOPE_CHANGED')
            return CountResult('order_count',int(self.document['appCashbackCount' if match.group(2)=='=' else 'webCashbackCount']))
        if re.search(r'\b(?:from|join)\s+`?orders\b',query,re.I) and not re.search(r'\bid\s*=\s*(?::[a-z_]+|%s|\?|[1-9][0-9]*)',query,re.I):
            fail('SCREENING_ORIGIN_HISTORY_SQL_UNQUALIFIED')
        return self.session.execute(statement,parameters,**kwargs)
    def __getattr__(self,name):return getattr(self.session,name)


@contextmanager
def scope(session,command,key,now):
    found=one(session,'SELECT data,proof_hash FROM pos_rewrite_screening_origin_histories WHERE command_id=:id AND OCTET_LENGTH(data)<=16000 FOR SHARE',{'id':command['id']})
    value=qualified(json_value(found['data']),key,command,now)
    if not hmac.compare_digest(digest(key,'history-record',value),found['proof_hash']) or head(session,command['customerId'])!=value['witness']:fail('SCREENING_ORIGIN_HISTORY_CHANGED')
    replay=Replay(session,value);token=ACTIVE.set(replay)
    try:yield replay
    finally:ACTIVE.reset(token)


def after_order_insert(order):
    current=ACTIVE.get()
    if current is not None:current.inserted(str(order.id))


def finish(session,command,replay):
    """Every intervening change must belong to this transaction's new Order.

    The final shared head lock is acquired after source Order/HP locks. A
    concurrent committed order/status/customer mutation cannot be hidden by
    an earlier RR snapshot; selected frames use owned READ COMMITTED.
    """
    final_witness=head(session,command['customerId'],True);initial_witness=replay.document['witness']
    if any(final_witness[name]!=initial_witness[name] for name in ('contract','sourceSchema','sourceServerUuid','writersHash')):fail('SCREENING_ORIGIN_HISTORY_CHANGED')
    final=final_witness['revision'];initial=initial_witness['revision']
    if int(final)<int(initial) or int(final)-int(initial)>1000:fail('SCREENING_ORIGIN_HISTORY_CHANGED')
    changes=rows(session,'SELECT revision,order_id FROM pos_rewrite_screening_origin_history_changes WHERE customer_id=:customer AND revision>:initial AND revision<=:final ORDER BY revision LIMIT 1001',
                 {'customer':command['customerId'],'initial':initial,'final':final},1001)
    if (len(changes)!=int(final)-int(initial) or any(str(row['revision'])!=str(int(initial)+index+1) or str(row['order_id'])!=replay.own_order for index,row in enumerate(changes))):fail('SCREENING_ORIGIN_HISTORY_CHANGED')


def save(session,command,value,key,now):
    value=qualified(value,key,command,now)
    if head(session,command['customerId'],True)!=value['witness']:fail('SCREENING_ORIGIN_HISTORY_CHANGED')
    session.execute(text('INSERT INTO pos_rewrite_screening_origin_histories(command_id,data,proof_hash) VALUES(:id,:data,:proof)'),
                    {'id':command['id'],'data':canonical(value),'proof':digest(key,'history-record',value)})


@contextmanager
def trusted_native():
    token=NATIVE.set(True)
    try:yield
    finally:NATIVE.reset(token)


@contextmanager
def guard_source(session,frame):
    connection=session.connection()
    def guard(_connection,_cursor,statement,parameters,_context,_many):
        if NATIVE.get():return
        query=normal(statement)
        if not re.match(r'^SELECT\b',query,re.I) or not re.search(r'\b(?:FROM|JOIN)\s+`?(?:orders|has_products)\b',query,re.I):return
        if re.search(r'\b(?:WHERE FALSE|LIMIT 0)\s*$',query,re.I):return
        own=frame.order_id
        # All allowed current source order/line facts are exact own-order points.
        match=re.search(r'\b(?:orders\.)?(?:order_id|id)\s*=\s*(?:%\(([a-z_][a-z0-9_]*)\)s|:([a-z_][a-z0-9_]*)|([1-9][0-9]*))',query,re.I)
        value=None
        if match:
            if match.group(3):value=match.group(3)
            elif isinstance(parameters,dict):value=parameters.get(match.group(1) or match.group(2))
        if own is not None and str(value)==own:return
        from transaction import VIOLATION
        VIOLATION.set(True)
        raise HistoryReadRefused() from None
    event.listen(connection,'before_cursor_execute',guard)
    try:yield
    finally:
        if event.contains(connection,'before_cursor_execute',guard):event.remove(connection,'before_cursor_execute',guard)
