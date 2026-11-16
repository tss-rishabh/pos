"""Extract the original return report SELECT for isolated fixture comparisons."""
import ast
from pathlib import Path
import re
import sys
start,end,store=sys.argv[1:]
if not re.fullmatch(r'\d+',store) or not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]):raise ValueError('Use validated fixture inputs.')
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/report_queries.py'
node=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='RETRUN_ORDER_QUERY' for target in node.targets))
query=ast.literal_eval(node.value)
print(query+f" AND ro.created_at BETWEEN '{start}' AND '{end}' AND ro.store_id IN ({store}) GROUP BY hp.id ORDER BY ro.created_at DESC,hp.id ASC")
