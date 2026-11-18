"""Qualified current screening projection and exact in-memory source replay.

No raw historical Order/HP count is executed by this module. Immutable seed
proofs come from an independent complete BigQuery publication. DBA-installed
triggers maintain contributions; missing projection/coverage never means 0.
"""
from contextlib import contextmanager
from copy import deepcopy
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
from sqlalchemy import event,text,inspect
from protocol import ImportReview,canonical
from screening_transaction import _session
from transaction import VIOLATION

CONTRACT='pos-screening-current-counter-v1'
PUBLICATION='pos-screening-counter-publication-v1'
SKU='390238'
_SHAPE=('SELECT COUNT(*) AS cnt FROM spiderman_screening_orders s '
        'JOIN orders o ON o.id = s.order_id JOIN has_products hp ON hp.id = s.has_product_id '
        'WHERE s.user_id = :user_id AND hp.prod_id = :sku AND o.order_status NOT IN (0, 17)')

# Exact current graph reads in the pinned 2960 source; all require this
# attempt's after_flush provenance, not merely a matching customer/lock.
_CURRENT_ORDER_SELECT='SELECT o.id, order_status, voucher_used, voucher_amt_used, payment_method, cashback_used, pay_amt, tss_money_used, tss_points_used, order_amt AS price, gifting_charges, shipping_amt, cashback_earned, tss_points_earned, cod_charges, hl_charges, coupon_used, coupon_amt_used, cc.name AS courier_name, o.original_order_id, o.location_id, o.start_timeslot, o.end_timeslot, o.location_type, hl_parent_order_id, o.parent_order_id, o.fraction_value As fraction_value, o.created_at as order_date, ha.postcode as postal_code, o.is_split_order, o.is_global_order, o.is_express, o.express_charges, o.is_parent_express, oa.priority_reason FROM orders o LEFT JOIN courier_companies cc ON cc.id = o.courier LEFT JOIN has_addresses ha ON ha.id = o.has_address_id LEFT JOIN order_attributes oa ON oa.order_id = o.id WHERE o.id = :order_id AND o.user_id = :user_id'
_CURRENT_LINES_SELECT='select id, hp_tss_points_used, status, prod_id, price, gst, disc, wallet_disc, voucher_disc,store_disc_pg from has_products where order_id = '
_FIELDS={'contract','sourceCommit','writersContract','scope','snapshotId','serverUuid','sourceSchema',
         'generationId','headRevision','writersDefinitionHash','writersOwner','rows','count','rowsHash','sourceCaptureHash',
         'sourceCapturedAt','sourceFinishedAt','sourceCdcThrough','publishedAt','complete','signature'}


def fail(code='INVALID'):
    raise ImportReview('ORDER_IMPORT_SCREENING_COUNTER_'+code) from None


class CounterReadRefused(BaseException):
    """Translated outside the literal helper, whose Exception fallback is unsafe."""


def refuse():
    VIOLATION.set(True)
    raise CounterReadRefused() from None


def rows(session,query,params=None,maximum=2):
    result=session.execute(text(query),params or {})
    try:value=[dict(row) for row in result.mappings().fetchmany(maximum+1)]
    finally:result.close()
    if len(value)>maximum:fail()
    return value


def one(session,query,params=None):
    value=rows(session,query,params,1)
    if len(value)!=1:fail('PROJECTION_REQUIRED')
    return value[0]


def _count(value):
    return isinstance(value,str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,19})',value) and int(value)<=18446744073709551615


def _hash(value):
    return isinstance(value,str) and re.fullmatch(r'[a-f0-9]{64}',value)


def _identifier(value):
    return isinstance(value,str) and re.fullmatch(r'[1-9][0-9]{0,18}',value) and int(value)<=9223372036854775807


def _owner(value):
    return isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,32}@[A-Za-z0-9_.%:-]{1,255}',value)


def _json(value):
    try:return json.loads(value) if isinstance(value,(str,bytes)) else value
    except Exception:fail()


def _definition():
    try:
        value=json.loads(Path(__file__).with_name('screening-counter-definition.json').read_text())
        if value['contract']!=CONTRACT or value['sku']!=SKU or len(value['triggers'])!=9 or not _hash(value['definitionHash']):fail('WRITERS_UNQUALIFIED')
        return value
    except Exception:fail('WRITERS_UNQUALIFIED')


def _normalize(value):
    if not isinstance(value,str):fail('WRITERS_UNQUALIFIED')
    return ' '.join(value.split())


def _qualify(session):
    transaction=session.get_transaction()
    if transaction is None or session.connection().get_isolation_level()!='READ COMMITTED':fail('TRANSACTION_REQUIRED')
    definition=_definition()
    prior=session.info.get('screening_counter_definitions')
    if prior is not None and prior[0] is transaction:
        definition['_owner']=prior[1];return definition
    # Metadata locks, zero historical source rows.
    session.execute(text('SELECT 1 FROM orders o,has_products hp,spiderman_screening_orders s,pos_rewrite_screening_counter_heads h,pos_rewrite_screening_counters c,pos_rewrite_screening_contributions x WHERE FALSE')).close()
    indexes=rows(session,definition['indexSql'],maximum=2000)
    for table,columns in definition['requiredPrefixes'].items():
        for column in columns:
            if not any(row['sourceTable']==table and row['columnName']==column and row['position']=='1' and row['indexType']=='BTREE' for row in indexes):fail('WRITERS_UNQUALIFIED')
        primary=[row for row in indexes if row['sourceTable']==table and row['indexName']=='PRIMARY']
        if len(primary)!=1 or primary[0]['columnName']!=columns[0] or primary[0]['position']!='1' or primary[0]['nonUnique']!='0':fail('WRITERS_UNQUALIFIED')
    from origin_history_privileges import qualified_head_metadata
    metadata=qualified_head_metadata(session)
    found=metadata['counterTriggers']
    if len(found)!=9:fail('WRITERS_UNQUALIFIED')
    for expected in definition['triggers']:
        match=[row for row in found if row['name']==expected['name']]
        if (len(match)!=1 or match[0]['tableName']!=expected['table'] or match[0]['event']!=expected['event']
                or match[0]['timing']!=expected['timing'] or match[0]['hash']!=hashlib.sha256(_normalize(expected['statement']).encode()).hexdigest()):fail('WRITERS_UNQUALIFIED')
    if len(metadata['counterProcedures'])!=1:fail('WRITERS_UNQUALIFIED')
    routine=metadata['counterProcedures'][0]
    expected=definition['procedure']
    if (routine['name']!=expected['name'] or routine['kind']!='PROCEDURE' or routine['security']!='DEFINER'
            or routine['hash']!=hashlib.sha256(_normalize(expected['statement']).encode()).hexdigest() or not _owner(routine['definer'])
            or any(row['definer']!=routine['definer'] for row in found)):fail('WRITERS_UNQUALIFIED')
    session.info['screening_counter_definitions']=(transaction,routine['definer'])
    definition['_owner']=routine['definer']
    return definition


def _publication(value,key,definition):
    value=_json(value)
    if not isinstance(value,dict) or set(value)!=_FIELDS:fail('PUBLICATION_INVALID')
    if (value['contract']!=PUBLICATION or value['sourceCommit']!=definition['sourceCommit']
            or value['writersContract']!=definition['writersContract'] or value['writersDefinitionHash']!=definition['definitionHash']
            or value['writersOwner']!=definition['_owner']
            or not isinstance(value['scope'],dict) or set(value['scope'])!={'customerId','sku'}
            or not _identifier(value['scope']['customerId']) or value['scope']['sku']!=SKU
            or value['complete'] is not True or any(not _count(value[name]) for name in ('headRevision','rows','count'))
            or any(not _hash(value[name]) for name in ('generationId','rowsHash','sourceCaptureHash','signature'))
            or any(type(value[name]) is not int or not 0<value[name]<=9007199254740991 for name in
                   ('sourceCapturedAt','sourceFinishedAt','sourceCdcThrough','publishedAt'))
            or not value['sourceCapturedAt']<=value['sourceFinishedAt']<=value['sourceCdcThrough']<=value['publishedAt']):fail('PUBLICATION_INVALID')
    if int(value['count'])>int(value['rows']):fail('PUBLICATION_INVALID')
    body={name:item for name,item in value.items() if name!='signature'}
    raw='{"kind":"screening-counter.publication.v1","input":'+canonical(body)+'}'
    signature=hmac.new(key.encode(),raw.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature,value['signature']):fail('PUBLICATION_INVALID')
    return value


def _runtime_privileges(session,definition,owner):
    transaction=session.get_transaction()
    if session.info.get('screening_counter_privileges')==(transaction,owner):return
    actor=one(session,'SELECT CURRENT_USER() AS actor,CURRENT_ROLE() AS roles')
    if not _owner(actor['actor']) or actor['actor']==owner or actor['roles']!='NONE':fail('APPLICATION_GRANTS')
    grants=rows(session,definition['privilegeSql'],maximum=1000)
    if any(row.get('privilegeName') not in ('SELECT','USAGE','SHOW_ROUTINE') or row.get('grantable')!='NO' for row in grants):fail('APPLICATION_GRANTS')
    direct=rows(session,'SHOW GRANTS FOR CURRENT_USER',maximum=1000)
    schema=one(session,'SELECT DATABASE() AS name')['name']
    for row in direct:
        if len(row)!=1:fail('APPLICATION_GRANTS')
        value=next(iter(row.values()))
        if not isinstance(value,str) or re.search(r'\bPROXY\b|\bWITH GRANT OPTION\b',value,re.I):fail('APPLICATION_GRANTS')
        if re.search(r'\bEXECUTE\b',value,re.I) and not re.fullmatch(
            r'GRANT EXECUTE ON FUNCTION `?'+re.escape(schema)+r'`?\.`?pos_rewrite_origin_(?:history|transaction)_metadata`? TO .+',value,re.I):fail('APPLICATION_GRANTS')
    session.info['screening_counter_privileges']=(transaction,owner)


class Snapshot:
    def __init__(self,session,customer,count,revision,baseline,key):
        self.session,self.customer,self.count,self.revision,self.baseline,self.key=session,customer,count,revision,deepcopy(baseline),key
        self.transaction=session.get_transaction()
    def guard(self):
        if self.session.get_transaction() is not self.transaction or self.transaction is None:refuse()
    def validate(self,added=0):
        self.guard()
        fresh=read_current(self.session,self.customer,CONTRACT,self.key)
        if type(added) is not int or added<0 or fresh.count!=self.count+added:fail('CHANGED')


def read_current(session,customer_id,contract=None,publication_key=None):
    session=_session(session);customer=str(customer_id)
    contract=os.environ.get('POS_SCREENING_COUNTER_CONTRACT') if contract is None else contract
    key=os.environ.get('POS_SCREENING_COUNTER_PUBLICATION_KEY','') if publication_key is None else publication_key
    if contract!=CONTRACT or not isinstance(key,str) or not re.fullmatch(r'[!-~]{32,4096}',key):fail('QUALIFICATION_REQUIRED')
    if not _identifier(customer):fail('SCOPE_CHANGED')
    definition=_qualify(session)
    row=one(session,"""SELECT CAST(c.customer_id AS CHAR) AS customer_id,CAST(c.sku AS CHAR) AS sku,
        CAST(c.bought AS CHAR) AS bought,CAST(c.revision AS CHAR) AS revision,
        CAST(h.revision AS CHAR) AS head_revision,@@server_uuid AS server_uuid,DATABASE() AS source_schema,
        CASE WHEN OCTET_LENGTH(c.baseline)<=12000 THEN c.baseline ELSE NULL END AS baseline,c.baseline_hash
        FROM pos_rewrite_screening_counters c JOIN pos_rewrite_screening_counter_heads h ON h.customer_id=c.customer_id
        WHERE c.customer_id=:customer FOR SHARE""",{'customer':customer})
    proof=_publication(row['baseline'],key,definition)
    _runtime_privileges(session,definition,proof['writersOwner'])
    if (row['customer_id']!=customer or row['sku']!=SKU or proof['scope']['customerId']!=customer
            or not _count(row['bought']) or not _count(row['revision']) or row['revision']!=row['head_revision']
            or int(row['revision'])<int(proof['headRevision']) or row['baseline_hash']!=proof['signature']
            or proof['serverUuid']!=row['server_uuid'] or proof['sourceSchema']!=row['source_schema']):fail('PROJECTION_INVALID')
    total=one(session,'SELECT CAST(COALESCE(SUM(included),0) AS CHAR) AS bought,CAST(COUNT(*) AS CHAR) AS marker_rows FROM (SELECT included FROM pos_rewrite_screening_contributions WHERE customer_id=:customer LIMIT 10001) current_rows',{'customer':customer})
    if total['bought']!=row['bought'] or not _count(total['marker_rows']) or int(total['marker_rows'])>10000:fail('PROJECTION_INVALID')
    return Snapshot(session,customer,int(row['bought']),row['revision'],proof,key)


class _Result:
    def __init__(self,count):self.count=count
    def fetchone(self):return {'cnt':self.count}
    def fetchall(self):return [self.fetchone()]
    def mappings(self):return self
    def first(self):return self.fetchone()
    def all(self):return self.fetchall()


class ReplaySession:
    def __init__(self,session,snapshot):
        self.session,self.snapshot=session,snapshot;self.reads=0
        self.creation_context=snapshot.session.info.get('screening_counter_creation_context')
    def new_order(self,order):
        self.snapshot.guard();native=self.snapshot.session;context=self.creation_context
        if (not _identifier(order) or context is None or native.info.get('screening_counter_creation_context') is not context
                or not context['active'] or context['transaction'] is not native.get_transaction()
                or context['savepoint'] is not native.get_nested_transaction()
                or context['connection'] is not native.connection() or native.connection().get_execution_options().get('schema_translate_map')
                or context['customer']!=self.snapshot.customer
                or context['orders'].get(order)!=self.snapshot.customer):refuse()
        owner=one(native,'SELECT user_id,DATABASE() AS source_schema FROM orders WHERE id=:id FOR UPDATE',{'id':order})
        lock=one(native,'SELECT IS_USED_LOCK(:name)=CONNECTION_ID() AS held',{'name':_named(native,'o',order)})
        if str(owner['user_id'])!=self.snapshot.customer or owner['source_schema']!=context['schema'] or lock['held']!=1:refuse()
        return native,context
    def address_update(self,statement,parameters,kwargs,match):
        address,order=match.groups();native,context=self.new_order(order)
        if parameters not in (None,{}) or kwargs or not _identifier(address) or (order,address) not in context['addresses']:refuse()
        mappings=rows(native,'SELECT has_address_id FROM order_address_mapping WHERE order_id=:order AND has_address_id=:address LIMIT 2',{'order':order,'address':address},2)
        if len(mappings)!=1:refuse()
        return self.session.execute(statement,parameters,**kwargs)
    def new_lines(self,order):
        native,context=self.new_order(order)
        values=rows(native,'SELECT id,order_id,prod_id FROM has_products WHERE order_id=:id ORDER BY id LIMIT 10001',{'id':order},10000)
        for row in values:
            line=str(row['id']);product=str(row['prod_id'])
            if context['lines'].get(line)!=(order,product):refuse()
            lock=one(native,'SELECT IS_USED_LOCK(:name)=CONNECTION_ID() AS held',{'name':_named(native,'p',line)})
            if lock['held']!=1:refuse()
        return native,context
    def execute(self,statement,parameters=None,**kwargs):
        address=re.fullmatch(r"UPDATE orders SET has_address_id = '([1-9][0-9]{0,18})' WHERE id = ([1-9][0-9]{0,18})",str(statement))
        if address:return self.address_update(statement,parameters,kwargs,address)
        compact=' '.join(str(statement).split()).strip()
        if compact in ('SELECT * FROM orders WHERE id=:id',_CURRENT_ORDER_SELECT):
            params=parameters if parameters is not None else kwargs.get('params',kwargs.get('parameters'))
            key='id' if compact=='SELECT * FROM orders WHERE id=:id' else 'order_id'
            if not isinstance(params,dict) or key not in params or type(params[key]) not in (str,int):refuse()
            self.new_order(str(params[key]))
            if key=='id':
                if set(params)!={'id'}:refuse()
                bound={'id':params[key]}
            else:
                if type(params.get('user_id')) not in (str,int) or str(params['user_id'])!=self.snapshot.customer:refuse()
                bound={'order_id':params['order_id'],'user_id':params['user_id']}
            return self.session.execute(statement,bound)
        lines=re.fullmatch(_CURRENT_LINES_SELECT+r'([1-9][0-9]{0,18})',compact)
        if lines:
            if parameters not in (None,{}) or kwargs:refuse()
            self.new_lines(lines.group(1))
            return self.session.execute(statement,parameters,**kwargs)
        refund=re.fullmatch(r'UPDATE has_products SET amount_to_be_refunded = ((?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?), fraction_value = 0 WHERE order_id = ([1-9][0-9]{0,18}) and prod_id = ([1-9][0-9]{0,18}) AND id = ([1-9][0-9]{0,18})',compact)
        if refund:
            amount,order,product,line=refund.groups()
            if parameters not in (None,{}) or kwargs or len(amount)>40 or not _identifier(product) or not _identifier(line):refuse()
            native,context=self.new_lines(order)
            if context['lines'].get(line)!=(order,product):refuse()
            return self.session.execute(statement,parameters,**kwargs)
        if compact==_SHAPE:
            params=parameters if parameters is not None else kwargs.get('params',kwargs.get('parameters'))
            self.snapshot.guard()
            if (not isinstance(params,dict) or set(params)!={'user_id','sku'} or
                    type(params['user_id']) not in (str,int) or type(params['sku']) not in (str,int) or
                    str(params['user_id'])!=self.snapshot.customer or str(params['sku'])!=SKU):refuse()
            self.reads+=1
            return _Result(self.snapshot.count)
        if re.search(r'\b(?:orders|has_products|spiderman_screening_orders)\b',compact,re.I):refuse()
        return self.session.execute(statement,parameters,**kwargs)
    def __getattr__(self,name):return getattr(self.session,name)


def _named(session,kind,identity):
    return one(session,"SELECT CONCAT('pos-screening:',LEFT(SHA2(DATABASE(),256),16),':',:kind,':',:identity) AS name",
               {'kind':kind,'identity':str(identity)})['name']


@contextmanager
def writer_entry(session,customer):
    session=_session(session);connection=session.connection();owned_names=[]
    if session.info.get('screening_counter_creation_context') is not None or connection.get_execution_options().get('schema_translate_map'):fail('WRITER_SCOPE_CHANGED')
    context={'active':True,'transaction':session.get_transaction(),'savepoint':session.get_nested_transaction(),
             'connection':connection,'schema':one(session,'SELECT DATABASE() AS name')['name'],'customer':str(customer),'orders':{},'addresses':set(),'lines':{}}
    if context['transaction'] is None:fail('TRANSACTION_REQUIRED')
    session.info['screening_counter_creation_context']=context
    def record_creation(current_session,*_args):
        if (current_session is not session or not context['active'] or current_session.get_transaction() is not context['transaction']
                or current_session.get_nested_transaction() is not context['savepoint'] or current_session.connection() is not connection
                or connection.get_execution_options().get('schema_translate_map')):refuse()
        for model in sorted(current_session.new,key=lambda value: 0 if inspect(value).mapper.local_table.name=='orders' else 1):
            state=inspect(model);table=state.mapper.local_table
            # Inspect the actual SQLAlchemy physical mapped table and exact
            # native session/bind, never a class name or request supplied flag.
            if (state.session is not session or table is not state.mapper.persist_selectable or table.schema is not None
                    or table.metadata.tables.get(table.name) is not table):continue
            binding=current_session.get_bind(mapper=state.mapper)
            if binding is not connection.engine and binding is not connection:refuse()
            if table.name=='orders':
                identity=str(getattr(model,'id',None));owner=str(getattr(model,'user_id',None))
                if not _identifier(identity) or owner!=str(customer):refuse()
                context['orders'][identity]=owner;acquire('o',identity)
            elif table.name=='has_products':
                identity=str(getattr(model,'id',None));order=str(getattr(model,'order_id',None));product=str(getattr(model,'prod_id',None))
                if not _identifier(identity) or not _identifier(product) or order not in context['orders']:refuse()
                context['lines'][identity]=(order,product);acquire('p',identity)
            elif table.name=='order_address_mapping':
                order=str(getattr(model,'order_id',None));address=str(getattr(model,'has_address_id',None))
                if _identifier(order) and _identifier(address):context['addresses'].add((order,address))
    def retire(current_session,transaction):
        if transaction is context['transaction'] or transaction is context['savepoint']:
            context['active']=False
            if session.info.get('screening_counter_creation_context') is context:session.info.pop('screening_counter_creation_context')
    def acquire(kind,identity):
        name=_named(session,kind,identity)
        if name in owned_names:return
        if one(session,'SELECT GET_LOCK(:name,0) AS acquired',{'name':name})['acquired']!=1:fail('WRITER_BUSY')
        owned_names.append(name)
        connection.info.setdefault('screening_counter_owned_names',set()).add(name)
    def parent_guard(current_session,*_args):
        orders=set();lines=set()
        def values(model,attribute):
            found={getattr(model,attribute,None)}
            state=inspect(model)
            if attribute in state.attrs:
                history=state.attrs[attribute].history
                found.update(history.added);found.update(history.deleted)
            found.discard(None);return found
        for model in list(current_session.new)+list(current_session.dirty)+list(current_session.deleted):
            table=getattr(model,'__tablename__',None)
            if table=='spiderman_screening_orders':
                if any(str(value)!=customer for value in values(model,'user_id')):fail('WRITER_SCOPE_CHANGED')
                orders.update(values(model,'order_id'));lines.update(values(model,'has_product_id'))
            elif table=='orders':orders.update(values(model,'id'))
            elif table=='has_products':
                lines.update(values(model,'id'));orders.update(values(model,'order_id'))
        orders.discard(None);lines.discard(None)
        orders={str(value) for value in orders};lines={str(value) for value in lines}
        if (len(orders)>10000 or len(lines)>10000 or any(not re.fullmatch(r'(?:0|-?[1-9][0-9]{0,18})',value) or not -9223372036854775808<=int(value)<=9223372036854775807 for value in orders|lines)):fail('WRITER_SCOPE_CHANGED')
        for identity in sorted(orders,key=int):
            rows(session,'SELECT id FROM orders WHERE id=:id FOR UPDATE',{'id':identity},1)
        for identity in sorted(lines,key=int):
            existing=rows(session,'SELECT id,order_id FROM has_products WHERE id=:id FOR UPDATE',{'id':identity},1)
            if any(row['order_id'] not in (None,0) and str(row['order_id']) not in orders for row in existing):fail('WRITER_SCOPE_CHANGED')
        for identity in sorted(orders,key=int):acquire('o',identity)
        for identity in sorted(lines,key=int):acquire('p',identity)
        if orders or lines:
            clauses=[];params={}
            for prefix,column,identities in (('o','order_id',orders),('p','has_product_id',lines)):
                names=[]
                for index,identity in enumerate(sorted(identities,key=int)):
                    name=prefix+str(index);params[name]=identity;names.append(':'+name)
                if names:clauses.append(column+' IN('+','.join(names)+')')
            affected=rows(session,'SELECT user_id,order_id,has_product_id FROM spiderman_screening_orders WHERE '+' OR '.join(clauses)+' LIMIT 10001',params,10000)
            if any(str(row['user_id'])!=customer or str(row['order_id']) not in orders or str(row['has_product_id']) not in lines for row in affected):fail('WRITER_SCOPE_CHANGED')
    def returned(dbapi,record):
        names=record.info.pop('screening_counter_owned_names',set())
        if not names or dbapi is None:return
        try:
            cursor=dbapi.cursor()
            try:
                for name in names:cursor.execute('SELECT RELEASE_LOCK(%s)',(name,));cursor.fetchone()
            finally:cursor.close()
        except Exception:record.invalidate()
    engine=connection.engine
    if not getattr(engine,'_screening_counter_pool_guard',False):
        event.listen(engine,'checkin',returned);engine._screening_counter_pool_guard=True
    try:
        acquire('u',customer)
        event.listen(session,'before_flush',parent_guard)
        event.listen(session,'after_flush',record_creation)
        event.listen(session,'after_transaction_end',retire)
        yield
    finally:
        context['active']=False
        if session.info.get('screening_counter_creation_context') is context:session.info.pop('screening_counter_creation_context')
        for name,callback in (('before_flush',parent_guard),('after_flush',record_creation),('after_transaction_end',retire)):
            if event.contains(session,name,callback):event.remove(session,name,callback)
        if not connection.closed and not connection.invalidated:
            for name in reversed(owned_names):
                connection.execute(text('SELECT RELEASE_LOCK(:name)'),{'name':name}).close()
                connection.info.get('screening_counter_owned_names',set()).discard(name)


@contextmanager
def public_scope(session,cap,preview=False):
    # Independent public capability shape. CSV nonce/witness is not accepted.
    from writer_protocol import validate_saved
    cap=validate_saved(cap);native=_session(session)
    snapshot=read_current(native,cap['customerId'])
    try:
        if preview:
            yield ReplaySession(session,snapshot)
            snapshot.validate()
        else:
            with writer_entry(native,snapshot.customer):
                yield ReplaySession(session,snapshot)
                snapshot.validate()
    except CounterReadRefused:
        fail('INVALID')

