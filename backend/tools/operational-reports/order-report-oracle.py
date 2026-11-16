"""Execute only the actual combined-report formatter AST; no Django, DB or network."""
import ast
import datetime
import json
from pathlib import Path
from types import SimpleNamespace
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/datatables/return_orders_datatable.py'
cls=next(node for node in ast.parse(source.read_text()).body if isinstance(node,ast.ClassDef) and node.name=='AjaxOrdersDataListView')
method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='get_prepared_data')
scope={}
exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),str(source),'exec'),scope)
input_data=json.load(sys.stdin)
if input_data.get('operation')=='headers':
 method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='do_order_export')
 assignment=next(node for node in method.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='header_mapping' for target in node.targets))
 json.dump(list(ast.literal_eval(assignment.value).items()),sys.stdout)
 sys.exit(0)
floats=['LineItemSubTotal','LineItemSubTotalWoTax','LineItemPgDisc','LineItemStoreDiscPG','IndividualDisc','IndividualPointsUsed','TaxRate']
result=[]
for case in input_data['cases']:
 rows=[]
 for row in case['rows']:
  row=dict(row)
  for key in floats:row[key]=float(row[key])
  for key in ['OrderDate','transaction_date']:row[key]=datetime.datetime.fromisoformat(row[key]) if row[key] and not row[key].startswith('0000-00-00') else None
  rows.append(SimpleNamespace(**row))
 result.append(scope['get_prepared_data'](rows,case.get('userType',1)))
json.dump(result,sys.stdout,default=lambda value:value.isoformat() if isinstance(value,datetime.datetime) else str(value))
