"""Extract source report SELECTs; caller executes only against isolated local fixtures."""
import ast
from pathlib import Path
import re
import sys

kind,start,end,store=sys.argv[1:]
if kind not in ['salesperson','cashier'] or not re.fullmatch(r'\d+',store) or not all(re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}',value) for value in [start,end]):
 raise ValueError('Use validated fixture inputs.')
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/datatables/performance_report.py'
cls=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.ClassDef) and node.name==('AjaxSalespersonPerformanceReport' if kind=='salesperson' else 'AjaxCashierPerformanceReport'))
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
query=next(node.value.value for node in method.body if isinstance(node,ast.Assign) and isinstance(node.value,ast.Constant) and any(isinstance(target,ast.Name) and target.id=='query' for target in node.targets))
if kind=='salesperson':
 print(query+f" AND hp.created_at BETWEEN '{start}' AND '{end}' AND os.store_id IN ({store}) GROUP BY employee_id ORDER BY total_sales DESC,employee_id ASC")
else:
 print(query+f" AND o.created_at BETWEEN '{start}' AND '{end}' AND os.store_id IN ({store}) GROUP BY os.order_id ORDER BY os.order_id ASC")
