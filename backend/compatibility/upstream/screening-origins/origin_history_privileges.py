"""Bounded read-only ownership/privilege attestation. No history rows or DDL."""
import hashlib
import json
import os
import re
from pathlib import Path
from native import one, rows, json_value
from origin_contracts import canonical, fail

INFO='pos_rewrite_origin_history_metadata'
HEADS={'pos_rewrite_screening_origin_history_heads','pos_rewrite_screening_origin_history_changes'}
ADMIN=re.compile(r'[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}')

def normal(value):return ' '.join(str(value).split()).strip().rstrip(';')

def qualify(session,expected,trigger_owner):
    audit=os.environ.get('POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER','')
    try:administrators=json.loads(os.environ.get('POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES','[]'))
    except Exception:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    if (not ADMIN.fullmatch(audit) or audit==trigger_owner or not isinstance(administrators,list)
            or len(administrators)>32 or len(set(administrators))!=len(administrators)
            or any(not isinstance(value,str) or not ADMIN.fullmatch(value) for value in administrators)):
        fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    caller=one(session,'SELECT CURRENT_USER() AS account,CURRENT_ROLE() AS roles')
    if caller['roles']!='NONE' or caller['account'] in (audit,trigger_owner):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    # A caller that can replace a trigger/routine or mutate its head cannot
    # authenticate its own all-writer history. Roles/proxies are not guessed.
    grants=rows(session,'SHOW GRANTS FOR CURRENT_USER()',limit=65)
    for row in grants:
        value=str(next(iter(row.values())))
        match=re.fullmatch(r'GRANT (.+) ON (.+) TO .+',value)
        if not match:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
        privileges={part.strip().upper() for part in match.group(1).split(',')}
        target=match.group(2).replace('`','')
        if 'WITH GRANT OPTION' in value.upper():fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
        if privileges-{'USAGE','SELECT','SHOW VIEW','SHOW_ROUTINE','SHOW ROUTINE','PROCESS','EXECUTE','INSERT','UPDATE','DELETE','REFERENCES','INDEX'}:
            fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
        if privileges.intersection({'INSERT','UPDATE','DELETE','INDEX'}) and (target=='*.*' or target.endswith('.*') or target.split('.')[-1] in HEADS):
            fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
        if 'EXECUTE' in privileges and target not in (f'FUNCTION {one(session,"SELECT DATABASE() AS db")["db"]}.{INFO}',):
            fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    definition=Path(__file__).with_name('history-security.review.sql').read_text()
    match=re.search(r'\nRETURN (.*?)\n\$\$',definition,re.S)
    if match is None:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    body='RETURN '+match.group(1)
    routine=one(session,"SELECT DEFINER AS owner,SECURITY_TYPE AS security,SQL_DATA_ACCESS AS accessMode,ROUTINE_DEFINITION AS body FROM INFORMATION_SCHEMA.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='pos_rewrite_origin_history_metadata' AND ROUTINE_TYPE='FUNCTION'")
    if (routine['owner']!=audit or routine['security']!='DEFINER' or routine['accessMode']!='READS SQL DATA'
            or normal(routine['body'])!=normal(body)):
        fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    result=one(session,'SELECT pos_rewrite_origin_history_metadata() AS document')
    if len(str(result['document']))>500000:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    data=json_value(result['document'])
    if set(data)!={'triggers','accounts','roles','proxies','privileges','ownedRoutines'} or any(not isinstance(data[name],list) or len(data[name])>1000 for name in data):
        fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    accounts={item['name']:item['locked'] for item in data['accounts']}
    if accounts.get(trigger_owner)!='Y' or accounts.get(audit)!='Y':fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    if any(item['name'] in (trigger_owner,audit,caller['account']) for item in data['roles']):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    if any(item['target'] in (trigger_owner,audit) or item['name']==caller['account'] for item in data['proxies']):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    if any(item['owner']==trigger_owner for item in data['ownedRoutines']):fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    relevant=[item for item in data['triggers'] if item['owner']==trigger_owner or item['name'].startswith('pos_rewrite_origin_history_')]
    if len(relevant)!=4:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    for item in expected:
        found=[row for row in relevant if row['name']==item['name']]
        if (len(found)!=1 or found[0]['owner']!=trigger_owner or found[0]['action']!=item['action'] or found[0]['sourceTable']!=item['table']
                or normal(found[0]['body'])!=normal(item['body'])
                or not {'STRICT_TRANS_TABLES','STRICT_ALL_TABLES'}.intersection(found[0]['sqlMode'].split(','))):
            fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    schema=one(session,'SELECT DATABASE() AS db')['db']
    for privilege in data['privileges']:
        owner=privilege['grantee'].replace("'",'')
        applies=privilege['scope']=='global' or privilege['schema']==schema and (privilege['scope']=='schema' or privilege['table'] in HEADS)
        if applies and privilege['privilege'] in ('INSERT','UPDATE','DELETE') and owner!=trigger_owner and owner not in administrators:
            fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
        if owner==trigger_owner:
            allowed={'USAGE'} if privilege['scope']=='global' else (
                {'SELECT','TRIGGER'} if privilege['table'] in ('orders','users') else
                {'SELECT','INSERT','UPDATE'} if privilege['table']=='pos_rewrite_screening_origin_history_heads' else
                {'INSERT'} if privilege['table']=='pos_rewrite_screening_origin_history_changes' else set())
            if privilege['grantable']!='NO' or privilege['privilege'] not in allowed:fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')
    return {'auditDefiner':audit,'metadataHash':hashlib.sha256(normal(body).encode()).hexdigest(),'administrators':sorted(administrators)}
