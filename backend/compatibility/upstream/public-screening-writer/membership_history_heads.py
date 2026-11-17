"""Current delivered-history revision; never a native history-data reader.

Review triggers track every field consumed by literal membership eligibility.
The first read does not lock the head across Cart→Order. The final locking read
comes after source native writes, matching cooperating Order→head lock order.
"""
import hashlib
import json
import re
import os
from pathlib import Path
from uuid import UUID
from native_authority import one,rows
from writer_protocol import fail

CONTRACT='pos-membership-history-head-v1'
TABLE='pos_rewrite_membership_history_heads'


def definitions():
    root=Path(__file__).resolve().parent
    value=json.loads((root/'membership-history-writers.review.json').read_text())
    if (set(value)!={'contract','definitions','writersHash'} or value['contract']!=CONTRACT
            or not isinstance(value['definitions'],list) or len(value['definitions'])!=7):fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    raw=json.dumps(value['definitions'],sort_keys=True,separators=(',',':')).encode()
    if hashlib.sha256(raw).hexdigest()!=value['writersHash']:fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    return value


def capture(session,customer_id,lock=False):
    manifest=definitions()
    definer=os.environ.get('POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER','')
    if not re.fullmatch(r'[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}',definer):fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    origin=one(session,'SELECT DATABASE() AS schemaName,@@GLOBAL.server_uuid AS serverUuid,@@GLOBAL.read_only AS reader,@@GLOBAL.super_read_only AS superReader')
    if (origin['reader']!=0 or origin['superReader']!=0 or not isinstance(origin['schemaName'],str)
            or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}',origin['schemaName'])
            or str(UUID(origin['serverUuid']))!=origin['serverUuid']):fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    # Hold table MDL through the owned transaction; trigger DROP/replacement
    # cannot race final source admission after this metadata is verified.
    row=one(session,'SELECT revision FROM '+TABLE+' WHERE customer_id=:id'+(' FOR SHARE' if lock else ''),{'id':customer_id})
    actual=rows(session,"SELECT TRIGGER_NAME AS name,EVENT_OBJECT_TABLE AS tableName,EVENT_MANIPULATION AS event,ACTION_TIMING AS timing,LOWER(SHA2(ACTION_STATEMENT,256)) AS hash,SQL_MODE AS sqlMode,DEFINER AS definer FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME IN ('pos_rewrite_member_history_order_i','pos_rewrite_member_history_order_u','pos_rewrite_member_history_order_d','pos_rewrite_member_history_hp_i','pos_rewrite_member_history_hp_u','pos_rewrite_member_history_hp_d','pos_rewrite_member_history_user_i')",maximum=7)
    if len(actual)!=7:fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    indexed={item['name']:item for item in actual}
    for expected in manifest['definitions']:
        current=indexed.get(expected['name'])
        if (current is None or current['definer']!=definer or any(current[name]!=expected[name] for name in ('name','tableName','event','timing','hash'))
                or not {'STRICT_TRANS_TABLES','STRICT_ALL_TABLES'}.intersection(current['sqlMode'].split(','))):fail('SCREENING_MEMBERSHIP_HISTORY_UNQUALIFIED')
    revision=str(row['revision'])
    if not re.fullmatch(r'0|[1-9][0-9]{0,19}',revision) or int(revision)>18446744073709551615:fail()
    return {'contract':CONTRACT,'origin':{'schema':origin['schemaName'],'serverUuid':origin['serverUuid']},
            'revision':revision,'writersHash':hashlib.sha256((manifest['writersHash']+'\n'+definer).encode()).hexdigest()}


def validate(session,customer_id,expected):
    if capture(session,customer_id,lock=True)!=expected:fail('SCREENING_MEMBERSHIP_HISTORY_CHANGED')
