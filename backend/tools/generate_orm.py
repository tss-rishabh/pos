"""Generate field-preserving Drizzle mappings from the audited source inventory.

This is a mapping, never a migration. Validate against information_schema before
enabling production writes. Foreign keys using custom subclasses are recorded as
unmapped until their effective db_column has been reviewed.
"""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
inventory = json.loads((root / 'parity/legacy-inventory.json').read_text())
imports = 'mysqlTable, bigint, int, smallint, boolean, varchar, text, decimal, double, float, datetime, date, time, json'
lines = ['// Generated from source plus verified physical decoder overrides. Never auto-migrate legacy tables.', f"import {{ {imports} }} from 'drizzle-orm/mysql-core';", '']
unmapped = []
metadata_path=root/'evidence/mysql-readonly.json'
metadata=json.loads(metadata_path.read_text()) if metadata_path.exists() else {'columns':[]}
verified_path=root/'evidence/mysql-schema.json'
verified=json.loads(verified_path.read_text()).get('tables',{}) if verified_path.exists() else {}
for model in inventory['models']:
    if not model['table']:
        continue
    fields = list(model['fields'])
    if model['name']=='PosUser':
        inherited=[('username','CharField',150),('password','CharField',128),('first_name','CharField',150),('last_name','CharField',150),('is_active','BooleanField',None),('is_staff','BooleanField',None),('is_superuser','BooleanField',None),('last_login','DateTimeField',None),('date_joined','DateTimeField',None)]
        fields=[{'name':n,'column':n,'type':t,'options':{'max_length':length,'null':n=='last_login'}} for n,t,length in inherited]+fields
    verified_columns={column['name']:column for column in verified.get(model['table'],[])}
    # The Go POS allocator uses these real columns even though Django omits them.
    if model['name']=='Order':
        for name,kind in [('cashback_used','FloatField'),('original_order_id','BigIntegerField')]:
            if name in verified_columns and not any(f['column']==name for f in fields):
                fields.append({'name':name,'column':name,'type':kind,'options':{'null':verified_columns[name]['nullable']}})
    if model['name']=='MUser':
        for name in ('is_block', 'is_disabled'):
            if name in verified_columns and not any(f['column']==name for f in fields):
                fields.append({'name':name,'column':name,'type':'SmallIntegerField','options':{'null':verified_columns[name]['nullable']}})
    if model['name']=='OrderAddon' and 'hl_charges_refunded' in verified_columns and not any(f['column']=='hl_charges_refunded' for f in fields):
        fields.append({'name':'hl_charges_refunded','column':'hl_charges_refunded','type':'SmallIntegerField','options':{'null':verified_columns['hl_charges_refunded']['nullable']}})
    live_columns=set(verified_columns) or {c['column_name'] for c in metadata['columns'] if c['table_name']==model['table']}
    if not any(f['name'] == 'id' for f in fields) and (not live_columns or 'id' in live_columns):
        fields.insert(0, {'name': 'id', 'column': 'id', 'type': 'BigAutoField', 'options': {'primary_key': True}})
    columns = []
    for field in fields:
        kind, name, opt = field['type'], field['column'], field['options']
        if kind in ('BigIntegerField', 'BigAutoField', 'ForeignKey', 'OneToOneField'):
            call = f"bigint('{name}', {{ mode: 'bigint' }})"
        elif kind in ('IntegerField', 'PositiveIntegerField', 'AutoField'): call = f"int('{name}')"
        elif kind in ('SmallIntegerField', 'PositiveSmallIntegerField'): call = f"smallint('{name}')"
        elif kind == 'BooleanField': call = f"boolean('{name}')"
        elif kind == 'FloatField': call = f"double('{name}')"
        elif kind == 'DecimalField': call = f"decimal('{name}', {{ precision: {opt.get('max_digits', 20)}, scale: {opt.get('decimal_places', 2)} }})"
        elif kind in ('CharField', 'EmailField', 'ImageField', 'FileField', 'URLField', 'SlugField'): call = f"varchar('{name}', {{ length: {opt.get('max_length') or 254} }})"
        elif kind == 'TextField': call = f"text('{name}')"
        elif kind == 'DateTimeField': call = f"datetime('{name}', {{ mode: 'string' }})"
        elif kind == 'DateField': call = f"date('{name}', {{ mode: 'string' }})"
        elif kind == 'TimeField': call = f"time('{name}')"
        elif kind == 'JSONField': call = f"json('{name}')"
        else:
            unmapped.append({'model': model['name'], **field})
            continue
        observed=verified_columns.get(name)
        decoder_override=False
        if observed:
            physical=observed['type'].lower()
            if physical.startswith('bigint') and kind in ('IntegerField','PositiveIntegerField','AutoField','SmallIntegerField','PositiveSmallIntegerField','FloatField'):
                call=f"bigint('{name}', {{ mode: 'bigint' }})"
                decoder_override=True
            elif kind in ('BigIntegerField','BigAutoField','ForeignKey','OneToOneField') and physical.startswith(('float','double')):
                call=f"{'float' if physical.startswith('float') else 'double'}('{name}')"
                decoder_override=True
            elif kind in ('BigIntegerField','BigAutoField','ForeignKey','OneToOneField') and physical.startswith('varchar'):
                length=re.fullmatch(r'varchar\((\d+)\)',physical)
                if not length: raise ValueError('Unreviewed physical varchar mapping')
                call=f"varchar('{name}', {{ length: {int(length[1])} }})"
                decoder_override=True
            elif kind=='FloatField' and physical.startswith('float'):
                # Same TS number shape; fixture storage must preserve actual FLOAT rounding.
                call=f"float('{name}')"
            elif kind=='TimeField' and physical.startswith('datetime'):
                # Old delivery slots are full nullable event timestamps, not a
                # time-of-day. Preserve the inspected storage and date boundary.
                call=f"datetime('{name}', {{ mode: 'string' }})"
                decoder_override=True
        auto_increment=('auto_increment' in observed.get('extra','')) if observed else kind in ('AutoField','BigAutoField')
        if auto_increment: call += '.autoincrement()'
        if opt.get('primary_key'): call += '.primaryKey()'
        nullable = observed['nullable'] if decoder_override else opt.get('null')
        # Conservative application type for the separately reviewed nullable
        # unset-event-date contract. This does not alter physical metadata/DDL.
        # Existing orders without either event may legitimately have no date.
        if model['table'] == 'orders' and name in ('ship_date', 'ret_ex_request_date'):
            nullable = True
        if not nullable: call += '.notNull()'
        columns.append(f"  {field['name']}: {call},")
    lines.extend([f"export const {model['name']} = mysqlTable('{model['table']}', {{", *columns, '});', ''])
out = root / 'src/db/legacy-schema.ts'
if sys.argv[1:] == ['--stdout']:
    # Read-only verification: callers format this text using the pinned Prettier.
    sys.stdout.write('\n'.join(lines))
    raise SystemExit(0)
if sys.argv[1:]:
    raise SystemExit('Use no arguments to generate, or --stdout to inspect without writes.')
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text('\n'.join(lines))
(root / 'parity/orm-unmapped.json').write_text(json.dumps(unmapped, indent=2) + '\n')
print(json.dumps({'tables': sum(1 for m in inventory['models'] if m['table']), 'unmapped_fields': len(unmapped)}))
