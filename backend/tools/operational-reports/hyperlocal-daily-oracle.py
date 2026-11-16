"""Extract the actual source daily report query for local synthetic fixture comparisons."""
import ast
from pathlib import Path
import re
import sys
start,end,stores=sys.argv[1:]
if not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]) or not re.fullmatch(r'\d+(?:,\d+)*',stores):
    raise ValueError('Use validated fixture inputs.')
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/report_queries.py'
node=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='HYPERLOCAL_DAILY_REPORT_QUERY' for target in node.targets))
query=ast.literal_eval(node.value)
query+=f" AND eli.store_id IN ({stores}) AND eli.pending_expires_at BETWEEN '{start}' AND '{end}'"
query+=' GROUP BY o.id,o.user_id,hp.id,o.first_name,o.last_name,o.created_at,o.order_status,hp.status,eli.status,s.id,s.location_code,s.store_name ORDER BY o.created_at DESC'
sys.stdout.write(query)
