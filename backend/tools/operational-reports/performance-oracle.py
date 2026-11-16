"""Execute actual source performance reducers; omit Django, SQL and network code."""
import ast
import copy
import datetime
import json
from pathlib import Path
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/datatables/performance_report.py'
tree=ast.parse(source.read_text())
data=json.load(sys.stdin)
result=[]
for case in data['cases']:
 cls=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name==('AjaxCashierPerformanceReport' if case['kind']=='cashier' else 'AjaxSalespersonPerformanceReport'))
 method=next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
 if case['kind']=='cashier':
  first=next(index for index,node in enumerate(method.body) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='performance_report' for target in node.targets))
  last=next(index for index,node in enumerate(method.body) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='records_total' for target in node.targets))
  label=copy.deepcopy(next(node for node in cls.body if isinstance(node,ast.FunctionDef) and node.name=='millisecond_to_time_stamp'))
  label.name='label'
  scope={'datetime':datetime,'json':json,'data_list':[{'oi':row['orderId'],'pos_admin_id':int(row['cashierId']) if row['cashierId'] is not None else None,'cashier_name':row['cashierName'],'performance_json':row['performanceJson'],'qty':row['quantity']} for row in case['rows']],'sort_type':case['direction'],'value_name':{'cashier_name':'cashier_name','cashier_id':'pos_admin_id','product_sold':'product_count','time_taken':'performance_time','rating':'performance_per'}[case['sort']]}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[label]+method.body[first:last],type_ignores=[])),str(source),'exec'),scope)
  result.append([{'id':str(row['pos_admin_id']) if row['pos_admin_id'] is not None else None,'cashier_name':row['cashier_name'],'product_sold':row['product_count'],'time_taken':scope['label'](None,row['performance_time']),'score':row['performance_per']} for row in scope['performance_report_list']])
 else:
  reducer=next(node for node in method.body if isinstance(node,ast.If) and isinstance(node.test,ast.Name) and node.test.id=='data_list')
  scope={'data_list':[{'employee_id':row['employeeId'],'Store_Name':row['storeName'],'salesperson_name':row['salespersonName'],'total_sales':row['totalSales']} for row in case['rows']],'price_list':[row['totalSales'] for row in case['rows']]}
  exec(compile(ast.fix_missing_locations(ast.Module(body=[reducer],type_ignores=[])),str(source),'exec'),scope)
  result.append([{'id':row['employee_id'],'store_name':row['Store_Name'],'salesperson_name':row['salesperson_name'],'total_sales':row['total_sales'],'rating':row['rating']} for row in scope['data_list']])
json.dump(result,sys.stdout)
