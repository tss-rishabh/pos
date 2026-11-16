"""Extract the original acceptance SELECT for isolated fixture comparison only."""
import ast
from pathlib import Path
import re
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/datatables/hyperlocal_report_datatable.py'
tree=ast.parse(source.read_text())
cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='AjaxHyperlocalOrderAcceptReport')
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
query=next(node.value.value for node in method.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='query' for target in node.targets) and isinstance(node.value,ast.Constant))
start,end,store=sys.argv[1:]
if not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]) or not re.fullmatch(r'\d+',store):
 raise ValueError('Use validated fixture inputs.')
# The source SQL escapes literal percent signs for the Python DB adapter.
print(query.replace('%%','%')+f" AND hol.created_at BETWEEN '{start}' AND '{end}' AND o.location_id IN ({store}) ORDER BY hol.id")
