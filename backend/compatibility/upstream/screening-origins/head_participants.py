"""Exact reviewed head writers, distinct from trusted administrator exceptions.

Only these literal trigger/procedure identities and minimal rights may use a
dedicated locked owner. Nothing here reads business history or executes DDL.
"""
import hashlib
import json
import os
from pathlib import Path
import re
from origin_contracts import canonical, fail

HERE = Path(__file__).resolve().parent
OWNER = re.compile(r'[A-Za-z0-9_.$-]{1,64}@[A-Za-z0-9_.:%-]{1,255}')
TRIGGER_FIELDS = {'name', 'tableName', 'event', 'timing', 'hash', 'definer', 'sqlMode'}
FAMILIES = {
    'membership': {
        'section': 'membershipTriggers', 'count': 7,
        'environment': 'POS_MEMBERSHIP_HISTORY_TRIGGER_DEFINER',
        'manifest': '../public-screening-writer/membership-history-writers.review.json',
        'heads': {'pos_rewrite_membership_history_heads': {'SELECT', 'INSERT', 'UPDATE'}},
    },
    'coupon': {
        'section': 'couponTriggers', 'count': 10,
        'environment': 'POS_COUPON_HISTORY_DEFINER',
        'manifest': '../legacy-order-imports/benefit-profile/coupon-history-writers.review.json',
        'heads': {'pos_rewrite_coupon_history_heads': {'SELECT', 'INSERT', 'UPDATE'}},
    },
    'counter': {
        'section': 'counterTriggers', 'count': 9,
        'environment': 'POS_SCREENING_COUNTER_TRIGGER_DEFINER',
        'manifest': '../legacy-order-imports/screening-counter-definition.json',
        'heads': {
            'pos_rewrite_screening_counter_heads': {'SELECT', 'INSERT', 'UPDATE'},
            'pos_rewrite_screening_counters': {'SELECT', 'UPDATE'},
            'pos_rewrite_screening_contributions': {'SELECT', 'INSERT', 'UPDATE', 'DELETE'},
        },
    },
}


def refused():
    fail('SCREENING_ORIGIN_HISTORY_UNQUALIFIED')


def normalized_hash(statement):
    return hashlib.sha256(' '.join(statement.split()).encode()).hexdigest()


def definitions(family):
    spec = FAMILIES[family]
    path = HERE / spec['manifest']
    if not path.is_file() or path.stat().st_size > 1000000:
        refused()
    manifest = json.loads(path.read_text())
    raw = manifest['triggers'] if family == 'counter' else manifest['definitions']
    if not isinstance(raw, list) or len(raw) != spec['count']:
        refused()
    if family == 'membership':
        payload = json.dumps(raw, sort_keys=True, separators=(',', ':')).encode()
        if hashlib.sha256(payload).hexdigest() != manifest['writersHash']:
            refused()
    elif family == 'coupon':
        payload = json.dumps(raw, ensure_ascii=False, separators=(',', ':')).encode()
        if hashlib.sha256(payload).hexdigest() != manifest['definitionHash']:
            refused()
    result = []
    for row in raw:
        value = {'name': row['name'], 'tableName': row.get('tableName', row.get('table')),
                 'event': row['event'], 'timing': row['timing'],
                 'hash': row['hash'] if family == 'membership' else normalized_hash(row['statement'])}
        if (not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', value['name'])
                or value['event'] not in ('INSERT', 'UPDATE', 'DELETE') or value['timing'] != 'AFTER'
                or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', value['tableName'])
                or not re.fullmatch(r'[a-f0-9]{64}', value['hash'])):
            refused()
        result.append(value)
    if len({row['name'] for row in result}) != len(result):
        refused()
    return result, manifest


def participants(metadata, origin_owner):
    owners = {}
    families = {}
    for family, spec in FAMILIES.items():
        actual = metadata[spec['section']]
        owner = os.environ.get(spec['environment'], '')
        if not actual:
            if owner or family == 'counter' and metadata['counterProcedures']:
                refused()
            continue
        expected, manifest = definitions(family)
        if (not OWNER.fullmatch(owner) or owner == origin_owner or owner in owners
                or len(actual) != spec['count']):
            refused()
        indexed = {row['name']: row for row in expected}
        seen = set()
        for row in actual:
            if not isinstance(row, dict) or set(row) != TRIGGER_FIELDS:
                refused()
            name = row['name']
            if (name in seen or name not in indexed or row['definer'] != owner
                    or any(row[key] != indexed[name][key] for key in indexed[name])
                    or not isinstance(row['sqlMode'], str)
                    or not {'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES'}.intersection(row['sqlMode'].split(','))):
                refused()
            seen.add(name)
        procedures = {}
        if family == 'counter':
            values = metadata['counterProcedures']
            if len(values) != 1:
                refused()
            row, wanted = values[0], manifest['procedure']
            if (not isinstance(row, dict) or set(row) != {'name', 'kind', 'security', 'hash', 'definer'}
                    or row['name'] != wanted['name'] or row['kind'] != wanted['type']
                    or row['security'] != wanted['security'] or row['definer'] != owner
                    or row['hash'] != normalized_hash(wanted['statement'])):
                refused()
            procedures[row['name']] = 'PROCEDURE'
        owners[owner] = {'family': family, 'names': seen, 'watched': {row['tableName'] for row in expected},
                         'heads': spec['heads'], 'procedures': procedures}
        families[family] = {'owner': owner, 'definitions': expected,
                            'manifestHash': hashlib.sha256(canonical(manifest).encode()).hexdigest()}
    return owners, families


def policy_hash(families):
    return hashlib.sha256(canonical(families).encode()).hexdigest()


def publication_owner(owners,families,origin_owner):
    """One explicitly configured infrastructure writer; never the app caller.
    It can seed quota projections from the independently qualified publication,
    but cannot own triggers/routines, grant privileges or mutate other heads.
    """
    owner=os.environ.get('POS_SCREENING_COUNTER_PUBLISHER_GRANTEE','')
    if not owner:return
    if not OWNER.fullmatch(owner) or owner==origin_owner or owner in owners or 'counter' not in families:refused()
    rights={
        'pos_rewrite_screening_counter_heads':{'SELECT','INSERT','UPDATE'},
        'pos_rewrite_screening_counters':{'SELECT','INSERT','UPDATE'},
        'pos_rewrite_screening_contributions':{'SELECT','INSERT','DELETE'},
    }
    owners[owner]={'family':'counter-publication','names':set(),'watched':set(),
                   'heads':rights,'procedures':{},'publisher':True}
    families['counter-publication']={'owner':owner,'rights':{table:sorted(value) for table,value in rights.items()}}
