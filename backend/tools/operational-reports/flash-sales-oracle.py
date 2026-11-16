"""Execute only the actual source flash-sales reducer AST, without Django/DB/network."""
import ast
import datetime
import json
from pathlib import Path
from types import SimpleNamespace
import sys
source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/datatables/sales_data.py'
cls=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.ClassDef) and node.name=='AjaxSalesDataView')
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='get_full_queryset')
start=next(index for index,node in enumerate(method.body) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='data' for target in node.targets))
function=ast.FunctionDef(name='prepare',args=ast.arguments(posonlyargs=[],args=[ast.arg(arg='sales_data'),ast.arg(arg='return_data_list')],kwonlyargs=[],kw_defaults=[],defaults=[]),body=method.body[start:],decorator_list=[])
scope={};exec(compile(ast.fix_missing_locations(ast.Module(body=[function],type_ignores=[])),str(source),'exec'),scope)
cases=json.load(sys.stdin)['cases'];result=[]
for case in cases:
    def record(row):
        row=dict(row);row['date']=datetime.date.fromisoformat(row['date'])
        for key,value in row.items():
            if key.startswith('total_') and key not in ['total_number_of_bills','total_order_qty'] and value is not None:row[key]=float(value)
        return SimpleNamespace(**row)
    result.append(scope['prepare']([record(row) for row in case['sales']],[record(row) for row in case['refunds']]))
json.dump(result,sys.stdout)
