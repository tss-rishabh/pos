"""Bounded head-integrity attestation; no history reads or permission changes.

Trusted DBAs are an explicit installation boundary, never the current source
caller. Ordinary unrelated grants are not rewritten. An unsupported bypass
participant refuses qualification instead of guessing its effective authority.
"""
import hashlib
import json
import os
import re
from pathlib import Path
from native import one, rows, json_value
from origin_contracts import fail
from head_participants import FAMILIES, participants, publication_owner, policy_hash

INFO='pos_rewrite_origin_history_metadata'
HEADS={'pos_rewrite_screening_origin_history_heads','pos_rewrite_screening_origin_history_changes'}
WATCHED={'orders','users','has_products','order_coupon_log','coupons','spiderman_screening_orders'}
ALL_HEADS=HEADS|set().union(*(set(spec['heads']) for spec in FAMILIES.values()))
ADMIN=re.compile(r'[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}')
GRANTEE=re.compile(r"'([A-Za-z0-9_.$-]{1,64})'@'([A-Za-z0-9_.:%-]{1,255})'")
GLOBAL_READ={'USAGE','SELECT','SHOW DATABASES','SHOW VIEW','SHOW_ROUTINE','SHOW ROUTINE','PROCESS','REPLICATION CLIENT','REPLICATION SLAVE','REPLICATION REPLICA'}
SOURCE_READ={'SELECT','SHOW VIEW','REFERENCES'}
TABLE_WRITE={'SELECT','SHOW VIEW','INSERT','UPDATE','DELETE','REFERENCES','INDEX'}
AUDIT_RIGHTS={'SELECT','SHOW VIEW','SHOW_ROUTINE','TRIGGER','EVENT'}
FK_RULES={'CASCADE','SET NULL','SET DEFAULT','RESTRICT','NO ACTION'}
POLICY='pos-screening-origin-history-head-integrity-v3'


def refused():fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')


def normal(value):return ' '.join(str(value).split()).strip().rstrip(';')


def fields(row,keys):
    if not isinstance(row,dict) or set(row)!=set(keys):refused()
    return row


def account(value):
    if not isinstance(value,str) or not ADMIN.fullmatch(value):refused()
    return value


def grantee(value):
    if not isinstance(value,str):refused()
    match=GRANTEE.fullmatch(value)
    if match is None:refused()
    return account(match.group(1)+'@'+match.group(2))


def _qualified(session,expected,trigger_owner):
    audit=os.environ.get('POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER','')
    try:administrators=json.loads(os.environ.get('POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES','[]'))
    except Exception:refused()
    if (not ADMIN.fullmatch(audit) or audit==trigger_owner or not isinstance(administrators,list)
            or len(administrators)>32 or any(not isinstance(value,str) or not ADMIN.fullmatch(value) for value in administrators)
            or len(set(administrators))!=len(administrators) or audit in administrators or trigger_owner in administrators):refused()
    administrators=set(administrators)
    caller=one(session,'SELECT CURRENT_USER() AS account,CURRENT_ROLE() AS roles,@@SESSION.proxy_user AS proxyAccount,@@GLOBAL.mandatory_roles AS mandatoryRoles,@@GLOBAL.performance_schema AS performanceSchema,@@GLOBAL.skip_grant_tables AS skipGrants')
    current=account(caller['account'])
    if (caller['roles']!='NONE' or caller['proxyAccount'] is not None or caller['mandatoryRoles'] not in ('','NONE')
            or caller['performanceSchema']!=1 or caller['skipGrants']!=0
            or current in administrators or current in (audit,trigger_owner)):refused()
    schema=one(session,'SELECT DATABASE() AS db')['db']
    if not isinstance(schema,str) or not re.fullmatch(r'[A-Za-z0-9_]{1,64}',schema):refused()
    # SHOW GRANTS also denies a previously activated/implicit role and requires
    # the source application's own explicit, table-scoped writer privileges.
    grants=rows(session,'SHOW GRANTS FOR CURRENT_USER()',limit=65)
    for row in grants:
        value=str(next(iter(row.values())))
        match=re.fullmatch(r'GRANT (.+) ON (.+) TO .+',value)
        if not match:refused()
        privileges={part.strip().upper() for part in match.group(1).split(',')}
        target=match.group(2).replace('`','')
        if 'WITH GRANT OPTION' in value.upper():refused()
        if privileges-{'USAGE','SELECT','SHOW VIEW','SHOW_ROUTINE','SHOW ROUTINE','PROCESS','EXECUTE','INSERT','UPDATE','DELETE','REFERENCES','INDEX'}:refused()
        if privileges.intersection({'INSERT','UPDATE','DELETE','INDEX'}) and (target=='*.*' or target.endswith('.*') or target.split('.')[-1] in ALL_HEADS):refused()
        if 'EXECUTE' in privileges and target!=f'FUNCTION {schema}.{INFO}':refused()
    # Pin actual base tables before reading their trigger metadata. Optional
    # families are explicit deployment declarations; no historical rows are read.
    declared=HEADS|WATCHED
    for family,spec in FAMILIES.items():
        if os.environ.get(spec['environment']):
            declared|=set(spec['heads'])
    from sqlalchemy import text
    for table in sorted(declared):
        session.execute(text('SELECT 1 FROM `'+table+'` WHERE FALSE')).close()
    definition=Path(__file__).with_name('history-security.review.sql').read_text()
    match=re.search(r'\nRETURN (.*?)\n\$\$',definition,re.S)
    if match is None:refused()
    body='RETURN '+match.group(1)
    routine=one(session,"SELECT /*+ MAX_EXECUTION_TIME(3000) */ DEFINER AS owner,SECURITY_TYPE AS security,SQL_DATA_ACCESS AS accessMode,ROUTINE_DEFINITION AS body FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_rewrite_origin_history_metadata' AND ROUTINE_TYPE='FUNCTION'")
    if (routine['owner']!=audit or routine['security']!='DEFINER' or routine['accessMode']!='READS SQL DATA'
            or normal(routine['body'])!=normal(body)):refused()
    result=one(session,'SELECT /*+ MAX_EXECUTION_TIME(3000) */ pos_rewrite_origin_history_metadata() AS document')
    if len(str(result['document']).encode())>500000:refused()
    data=json_value(result['document'])
    sections={'triggers','accounts','roles','proxies','privileges','routineGrants','objects','aliases','tables','foreignKeys','replicationChannels',
              'membershipTriggers','couponTriggers','counterTriggers','counterProcedures'}
    if (not isinstance(data,dict) or set(data)!=sections
            or any(not isinstance(data[name],list) or len(data[name])>1000 for name in sections)):refused()
    additional,families=participants(data,trigger_owner)
    publication_owner(additional,families,trigger_owner)
    owner_specs={trigger_owner:{'family':'origin','names':{item['name'] for item in expected},
        'watched':{'orders','users'},'heads':{
            'pos_rewrite_screening_origin_history_heads':{'SELECT','INSERT','UPDATE'},
            'pos_rewrite_screening_origin_history_changes':{'INSERT'}},'procedures':{}},**additional}
    heads=HEADS|set().union(*(set(spec['heads']) for spec in additional.values()))
    if set(additional).intersection(administrators|{audit,current}):refused()
    accounts={}
    for raw in data['accounts']:
        item=fields(raw,{'name','locked'});name=account(item['name'])
        if name in accounts or item['locked'] not in ('Y','N'):refused()
        accounts[name]=item['locked']
    if (any(accounts.get(owner)!=('N' if spec.get('publisher') else 'Y') for owner,spec in owner_specs.items()) or accounts.get(audit)!='Y' or accounts.get(current)!='N'
            or not administrators.issubset(accounts)):refused()
    isolated=set(owner_specs)|{audit,current}
    for raw in data['roles']:
        item=fields(raw,{'name','role'});left=account(item['name']);right=account(item['role'])
        # Check both endpoints, including transitive escape through a trusted
        # DBA role; no assumption about default/active role direction is needed.
        if left not in accounts or right not in accounts or {left,right}.intersection(isolated):refused()
        if (left in administrators)!=(right in administrators):refused()
    for raw in data['proxies']:
        item=fields(raw,{'name','target','grantable'});name=account(item['name'])
        if name not in accounts or item['grantable'] not in (0,1):refused()
        target=item['target']
        if target!='@':account(target)
        if name in isolated or target in isolated:refused()
        if name not in administrators and (target in administrators or target=='@' or item['grantable']==1):refused()

    if len(data['triggers'])!=len(expected) or len(expected)!=4:refused()
    names={item['name'] for item in expected}
    for raw in data['triggers']:
        item=fields(raw,{'name','action','sourceTable','body','owner','sqlMode'})
        matches=[value for value in expected if value['name']==item['name']]
        if (len(matches)!=1 or item['owner']!=trigger_owner or item['action']!=matches[0]['action']
                or item['sourceTable']!=matches[0]['table'] or normal(item['body'])!=normal(matches[0]['body'])
                or not isinstance(item['sqlMode'],str) or not {'STRICT_TRANS_TABLES','STRICT_ALL_TABLES'}.intersection(item['sqlMode'].split(','))):refused()
    if {item['name'] for item in data['triggers']}!=names:refused()

    audit_global=set()
    for raw in data['privileges']:
        item=fields(raw,{'grantee','scope','schema','table','privilege','grantable','target'});owner=grantee(item['grantee'])
        scope=item['scope'];privilege=item['privilege'];target_schema=item['schema'];table=item['table']
        if (owner not in accounts or scope not in ('global','schema','table','column') or not isinstance(privilege,str)
                or not isinstance(target_schema,str) or not isinstance(table,str) or item['grantable'] not in ('YES','NO')
                or item['target'] not in ('global','protected-schema','grants','control','watched','other')):refused()
        if owner in owner_specs:
            spec=owner_specs[owner]
            allowed={'USAGE'} if scope=='global' else (
                SOURCE_READ if spec.get('publisher') and scope=='schema' and target_schema==schema else
                {'SELECT'} if spec.get('publisher') and scope=='table' and target_schema==schema and table in WATCHED else
                {'SELECT','TRIGGER'} if scope=='table' and target_schema==schema and table in spec['watched'] else
                spec['heads'].get(table,set()) if scope=='table' and target_schema==schema else set())
            if item['grantable']!='NO' or privilege not in allowed:refused()
            continue
        if owner==audit:
            if scope!='global' or item['grantable']!='NO' or privilege not in AUDIT_RIGHTS|{'USAGE'}:refused()
            audit_global.add(privilege)
            continue
        if owner in administrators:continue
        # Information_schema.USER_PRIVILEGES includes dynamic global privileges.
        # Unknown/global escalation powers fail closed, including SUPER, FILE,
        # role/definer/admin/applier and global/schema EXECUTE shortcuts.
        if scope=='global':
            if privilege not in GLOBAL_READ or item['grantable']!='NO':refused()
        elif scope=='schema':
            if privilege=='EXECUTE' or (item['target']=='protected-schema' and privilege not in SOURCE_READ):refused()
        elif item['target']=='grants':
            if privilege not in {'SELECT','SHOW VIEW'}:refused()
        elif item['target']=='control':
            if privilege!='SELECT':refused()
        elif item['target']=='watched':
            if privilege not in TABLE_WRITE:refused()
    # Complete dictionary visibility is an actual checked prerequisite, not a
    # caller assertion that hidden routines/views/events/trigger owners do not
    # exist. The locked audit account's only executable object is fixed below.
    if not AUDIT_RIGHTS.issubset(audit_global):refused()
    for raw in data['routineGrants']:
        item=fields(raw,{'name','schema','routine','kind','privileges'});owner=account(item['name'])
        if (owner not in accounts or item['kind'] not in ('FUNCTION','PROCEDURE')
                or not all(isinstance(item[name],str) for name in ('schema','routine','privileges'))):refused()
        privileges={part.strip().upper() for part in item['privileges'].split(',')}
        if owner in administrators:continue
        if owner in owner_specs:
            if (owner_specs[owner].get('publisher') and item['schema']==schema and item['routine']==INFO
                    and item['kind']=='FUNCTION' and privileges=={'EXECUTE'}):continue
            if (item['schema']!=schema or item['routine'] not in owner_specs[owner]['procedures']
                    or item['kind']!=owner_specs[owner]['procedures'][item['routine']] or privileges!={'EXECUTE'}):refused()
            continue
        if (owner==audit or item['schema']!=schema or item['routine']!=INFO
                or item['kind']!='FUNCTION' or privileges!={'EXECUTE'}):refused()

    objects=set()
    for raw in data['objects']:
        item=fields(raw,{'schema','name','kind','owner','security','usesRoutines'});owner=account(item['owner'])
        identity=(item['schema'],item['name'],item['kind'])
        if (not isinstance(item['schema'],str) or not isinstance(item['name'],str) or owner not in accounts
                or item['kind'] not in ('FUNCTION','PROCEDURE','VIEW','TRIGGER','EVENT')
                or item['security'] not in ('DEFINER','INVOKER') or item['usesRoutines'] not in (0,1)
                or identity in objects):refused()
        objects.add(identity)
        if owner==audit:
            if identity!=(schema,INFO,'FUNCTION') or item['security']!='DEFINER':refused()
        elif owner in owner_specs:
            spec=owner_specs[owner]
            if (item['schema']!=schema or not (item['kind']=='TRIGGER' and item['name'] in spec['names']
                or spec['procedures'].get(item['name'])==item['kind']) or item['security']!='DEFINER'):refused()
        elif owner in administrators:
            # Routines cannot be executed by a source caller (grants checked
            # above). Implicit triggers/events and definer views calling stored
            # functions would provide another route into those DBA routines.
            if item['kind'] in ('TRIGGER','EVENT'):refused()
            if item['kind']=='VIEW' and item['security']=='DEFINER' and item['usesRoutines']==1:refused()
    required={(schema,INFO,'FUNCTION')}
    for spec in owner_specs.values():
        required|={(schema,name,'TRIGGER') for name in spec['names']}
        required|={(schema,name,kind) for name,kind in spec['procedures'].items()}
    if not required.issubset(objects):refused()
    # A direct dependency exists at the bottom of any nested control/grant-table
    # view chain. No updatable alias is qualified; ordinary Order views still
    # use their base table's real mutation triggers.
    if data['aliases']:refused()
    if data['replicationChannels']:refused()

    tables={}
    for raw in data['tables']:
        item=fields(raw,{'name','kind','engine'})
        if item['name'] in tables or item['name'] not in heads|WATCHED or item['kind']!='BASE TABLE' or item['engine']!='InnoDB':refused()
        tables[item['name']]=item
    if set(tables)!=heads|WATCHED:refused()
    for table in sorted(heads|WATCHED):
        # Information_schema omits session temporary tables. SHOW CREATE names
        # the object this connection would really access, so an old temporary
        # shadow cannot reuse the physical base table's metadata as its proof.
        actual=one(session,'SHOW CREATE TABLE `'+table+'`')
        ddl=actual.get('Create Table')
        if (actual.get('Table')!=table or not isinstance(ddl,str) or len(ddl.encode())>200000
                or not re.match(r'^CREATE TABLE\s+`'+re.escape(table)+r'`\s*\(',ddl)):refused()
    for raw in data['foreignKeys']:
        item=fields(raw,{'table','column','update','delete'})
        if item['table'] not in heads|WATCHED or item['update'] not in FK_RULES or item['delete'] not in FK_RULES:refused()
        if item['table'] in heads:refused()
        # Cascaded changes do not invoke MySQL triggers. A delete cascade
        # removes a whole Order, and SET NULL/CASCADE on any watched column can
        # change these literal predicates without a revision.
        if item['update'] not in {'RESTRICT','NO ACTION'} or item['delete'] not in {'RESTRICT','NO ACTION'}:refused()
    policy={'policy':POLICY,'auditDefiner':audit,'metadataHash':hashlib.sha256(normal(body).encode()).hexdigest(),
            'qualifierHash':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'administrators':sorted(administrators),
            'participantsHash':policy_hash(families),
            'participantQualifierHash':hashlib.sha256(Path(__file__).with_name('head_participants.py').read_bytes()).hexdigest()}
    return {'policy':policy,**{name:data[name] for name in
        ('membershipTriggers','couponTriggers','counterTriggers','counterProcedures')}}


def qualify(session,expected,trigger_owner):
    return _qualified(session,expected,trigger_owner)['policy']


def qualified_head_metadata(session):
    definition=Path(__file__).with_name('history-heads.review.sql').read_text()
    expected=[]
    for name,action,table,body in re.findall(r"CREATE(?: DEFINER='[^']+'@'[^']+')? TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW\s*(.*?)END\$\$",definition,re.S):
        expected.append({'name':name,'action':action,'table':table,'body':' '.join((body+'END').split())})
    owner=os.environ.get('POS_SCREENING_ORIGIN_HISTORY_DEFINER','')
    if len(expected)!=4 or not ADMIN.fullmatch(owner):refused()
    return _qualified(session,expected,owner)
