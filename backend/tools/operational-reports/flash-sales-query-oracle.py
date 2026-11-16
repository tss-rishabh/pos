"""Return validated source SQL for isolated synthetic MySQL fixtures only."""
import ast
from pathlib import Path
import re
import sys
kind,start,end,stores=sys.argv[1:]
if kind not in ['interactive','export','refunds'] or not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]) or not re.fullmatch(r'\d+(?:,\d+)*',stores):raise ValueError('Use validated fixture inputs.')
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/datatables/sales_data.py'
cls=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.ClassDef) and node.name=='AjaxSalesDataView')
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name==('datatables' if kind=='interactive' else 'get_full_queryset'))
assignment=next(node for node in ast.walk(method) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id==('return_query' if kind=='refunds' else 'query') for target in node.targets))
parts=[]
for part in assignment.value.values:
    if isinstance(part,ast.Constant):parts.append(part.value)
    else:
        value=ast.unparse(part.value)
        if value=='selected_store_id_list':parts.append(stores)
        elif value.startswith(('start_order_date_range_obj.','start_date.')):parts.append(start)
        elif value.startswith(('end_order_date_range_obj.','end_date.')):parts.append(end)
        else:raise ValueError('Unknown source interpolation.')
sys.stdout.write(''.join(parts))
