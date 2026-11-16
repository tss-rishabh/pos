"""Extract static SQL from the inspected pure legacy module. Never connects to a DB."""
from pathlib import Path
import hashlib
import json
import runpy

root=Path(__file__).resolve().parents[2]
source=root.parent.parent/'backend-pos-web/report/glassbox_finance_feed_queries.py'
values=runpy.run_path(str(source))
target=root/'src/modules/finance/feed-sql.ts'
target.write_text('// Generated from baseline Glassbox source SQL; do not edit the copied business predicates.\n// Source SHA-256: '+hashlib.sha256(source.read_bytes()).hexdigest()+'\nexport const feedSql='+json.dumps({'sales':values['ORDERS_QUERY'],'returns':values['RETURNS_QUERY']},ensure_ascii=False,indent=2)+' as const;\n')
