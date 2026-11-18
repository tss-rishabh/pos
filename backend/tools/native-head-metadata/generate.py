"""Generate reviewed metadata descriptors only; no application build or DB I/O."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
BASE = 'backend/compatibility/upstream/'
parser = argparse.ArgumentParser()
parser.add_argument('--revision', help='Read committed review sources for an isolated branch')
args = parser.parse_args()
def read(path):
    return (subprocess.check_output(['git', 'show', args.revision+':'+path], cwd=ROOT)
            if args.revision else (ROOT/path).read_bytes())
def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()
def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
def normalized(value):
    return ' '.join(value.split()).rstrip(';')
limits = json.loads(read(BASE+'screening-origins/native-head-limits.json'))
if (set(limits) != {'contract','callerGrantRows','callerGrantRowBytes','callerGrantTotalBytes','privilegeRows','sectionRows','metadataBytes'}
        or limits['contract'] != 'pos-native-head-capacity-v1'
        or any(type(value) is not int or value <= 0 for name,value in limits.items() if name != 'contract')
        or not limits['callerGrantRows'] < limits['privilegeRows']
        or not limits['callerGrantRowBytes'] <= limits['callerGrantTotalBytes'] < limits['metadataBytes']):
    raise ValueError('Invalid reviewed native head capacity')
source = read(BASE+'screening-origins/history-security.review.sql').decode()
# Keep the installed literal function and every consumer on one reviewed limit
# source. A sentinel is returned intact; no caller treats a prefix as complete.
rendered = re.sub(r'\bLIMIT [0-9]+', 'LIMIT '+str(limits['sectionRows']+1), source)
rendered,count = re.subn(r'(FROM INFORMATION_SCHEMA.COLUMN_PRIVILEGES\s+LIMIT )[0-9]+',
    lambda match: match.group(1)+str(limits['privilegeRows']+1), rendered)
if count != 1: raise ValueError('Missing privilege capacity boundary')
rendered,count = re.subn(r'\nRETURN (?:/\* native-head-capacity:[a-f0-9]{64} \*/ )?JSON_OBJECT\(',
    '\nRETURN /* native-head-capacity:'+sha(canonical(limits))+' */ JSON_OBJECT(',rendered)
if count != 1: raise ValueError('Missing metadata capacity identity')
if args.revision and rendered != source: raise ValueError('Committed capacity and SQL function disagree')
if not args.revision and rendered != source:
    (ROOT/(BASE+'screening-origins/history-security.review.sql')).write_text(rendered)
source = rendered
body = re.search(r'\nRETURN (.*?)\n\$\$', source, re.S)
if body is None:
    raise ValueError('Missing fixed metadata RETURN body')
transaction_source = read(BASE+'screening-origins/transaction-security.review.sql').decode()
transaction_body = re.search(r'\nRETURN (.*?)\n\$\$', transaction_source, re.S)
if transaction_body is None: raise ValueError('Missing transaction metadata body')
origin = read(BASE+'screening-origins/history-heads.review.sql').decode()
triggers = [{'name': name, 'action': action, 'table': table, 'hash': sha(normalized(body+'END'))}
            for name, action, table, body in re.findall(
                r"CREATE(?: DEFINER='[^']+'@'[^']+')? TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW\s*(.*?)END\$\$", origin, re.S)]
if len(triggers) != 4:
    raise ValueError('Expected exactly four source history triggers')
paths = {'membership': 'public-screening-writer/membership-history-writers.review.json',
         'coupon': 'legacy-order-imports/benefit-profile/coupon-history-writers.review.json',
         'counter': 'legacy-order-imports/screening-counter-definition.json'}
families = {}
for family, path in paths.items():
    manifest = json.loads(read(BASE+path))
    raw = manifest['triggers'] if family == 'counter' else manifest['definitions']
    if family == 'membership' and sha(canonical(raw)) != manifest['writersHash']:
        raise ValueError('Membership descriptor hash mismatch')
    if family == 'coupon' and sha(json.dumps(raw, ensure_ascii=False, separators=(',', ':'))) != manifest['definitionHash']:
        raise ValueError('Coupon descriptor hash mismatch')
    definitions = [{'name': row['name'], 'tableName': row.get('tableName', row.get('table')),
                    'event': row['event'], 'timing': row['timing'],
                    'hash': row['hash'] if family == 'membership' else sha(' '.join(row['statement'].split()))}
                   for row in raw]
    if len(definitions) != {'membership': 7, 'coupon': 10, 'counter': 9}[family]:
        raise ValueError('Family descriptor count mismatch')
    families[family] = {'definitions': definitions, 'manifestHash': sha(canonical(manifest))}
    if family == 'counter':
        procedure = manifest['procedure']
        families[family]['procedure'] = {'name': procedure['name'], 'kind': procedure['type'],
            'security': procedure['security'], 'hash': sha(' '.join(procedure['statement'].split()))}
qualifier=read(BASE+'screening-origins/origin_history_privileges.py')
registry=next(node.value for node in ast.parse(qualifier).body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='PLATFORM_TRIGGERS' for target in node.targets))
platform_triggers=ast.literal_eval(registry)
if len(platform_triggers)!=2:raise ValueError('Expected closed platform trigger registry')
descriptor = {'limits': limits, 'metadataHash': sha(normalized('RETURN '+body.group(1))),
    'transactionMetadataHash': sha(normalized('RETURN '+transaction_body.group(1))),
    'qualifierHash': sha(qualifier),
    'participantQualifierHash': sha(read(BASE+'screening-origins/head_participants.py')),
    'originTriggers': triggers, 'families': families, 'platformTriggers': platform_triggers}
output = ROOT/'backend/src/modules/screening-origins/native-head-metadata.generated.ts'
output.write_text('// Generated by tools/native-head-metadata/generate.py; review only.\n'
                  +'export const nativeHeadDescriptor = '+json.dumps(descriptor, ensure_ascii=False, indent=2)+' as const;\n')

# One language-neutral descriptor is shared with the actual common Go audit.
go_output = ROOT/'backend/compatibility/upstream/legacy-order-imports/screening_head_metadata_definition.go'
go_output.write_text('// Code generated by tools/native-head-metadata/generate.py; DO NOT EDIT.\n'
    +'package poscheckout\n\nconst screeningHeadMetadataDefinitionJSON = '
    +json.dumps(json.dumps(descriptor, ensure_ascii=True, separators=(',', ':')))+'\n')
# Both legacy flat-module entry points resolve this generated dependency locally;
# their identical bytes always derive from the single reviewed JSON source.
python_limits = '# Generated by tools/native-head-metadata/generate.py; DO NOT EDIT.\n'+'LIMITS = '+repr(limits)+'\n'
for folder in ('screening-origins', 'legacy-order-imports'):
    (ROOT/(BASE+folder+'/native_head_limits.py')).write_text(python_limits)
