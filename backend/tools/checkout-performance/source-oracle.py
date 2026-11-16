"""Pinned timing writer + cashier reducer AST; no Django, network or source DB."""
import ast
import copy
import datetime
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

repo=Path(__file__).resolve().parents[4]/'backend-pos-web'
revision='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
def pinned(file):return subprocess.check_output(['git','-C',str(repo),'show',revision+':'+file],text=True)
writer_text=pinned('order/views.py')
writer=next(node for node in ast.parse(writer_text).body if isinstance(node,ast.ClassDef) and node.name=='AjaxFastCheckoutView')
post=next(node for node in writer.body if isinstance(node,ast.FunctionDef) and node.name=='post')
assignment=[]
for node in post.body:
    if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='performance_json' for target in node.targets):assignment.append(node)
    elif isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and isinstance(node.value.func.value,ast.Name) and node.value.func.value.id=='performance_json':assignment.append(node)
update=next(node for node in ast.walk(post) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='update' and any(keyword.arg=='performance_json' for keyword in node.keywords))
report_text=pinned('report/datatables/performance_report.py')
report=next(node for node in ast.parse(report_text).body if isinstance(node,ast.ClassDef) and node.name=='AjaxCashierPerformanceReport')
method=next(node for node in report.body if isinstance(node,ast.FunctionDef) and node.name=='datatables')
first=next(index for index,node in enumerate(method.body) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='performance_report' for target in node.targets))
last=next(index for index,node in enumerate(method.body) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='records_total' for target in node.targets))
label=copy.deepcopy(next(node for node in report.body if isinstance(node,ast.FunctionDef) and node.name=='millisecond_to_time_stamp'));label.name='label'
results=[]
for item in json.load(sys.stdin):
    values=dict(item['performance']);overall=values.pop('overall_performance_time','')
    changes=[]
    manager=SimpleNamespace(filter=lambda **where:SimpleNamespace(update=lambda **data:changes.append({'where':{'order_id':str(where['order_id'])},'data':data})))
    scope={'req_data':{'performance_json':json.dumps(values),'overall_performance_time':overall},'json':json,'OrderStore':SimpleNamespace(objects=manager),'order_id':9007199254740993}
    exec(compile(ast.fix_missing_locations(ast.Module(body=assignment+[ast.Expr(value=update)],type_ignores=[])),'<pinned-fast-checkout-timing-writer>','exec'),scope)
    serialized=scope['performance_json']
    rows=[{'oi':'9007199254740993','pos_admin_id':7,'cashier_name':'Fixture','performance_json':serialized,'qty':2}]
    if item.get('includeBaseline'):rows.append({'oi':'9007199254740994','pos_admin_id':8,'cashier_name':'Baseline','performance_json':json.dumps({'overall_performance_time':'60000','proceed_to_payment':'','add_to_cart':'','user_behaviour':''}),'qty':1})
    report_scope={'json':json,'datetime':datetime,'data_list':rows,'sort_type':'desc','value_name':'performance_per'}
    result={'name':item['name'],'serialized':serialized,'updates':changes,'report':None,'reportError':None}
    try:
        exec(compile(ast.fix_missing_locations(ast.Module(body=[label]+method.body[first:last],type_ignores=[])),'<pinned-cashier-timing-reducer>','exec'),report_scope)
        result['report']=[{'id':str(row['pos_admin_id']) if row['pos_admin_id'] is not None else None,'cashier_name':row['cashier_name'],'product_sold':row['product_count'],'time_taken':report_scope['label'](None,row['performance_time']),'score':row['performance_per']} for row in report_scope['performance_report_list']]
    except (ValueError,OverflowError,TypeError,ZeroDivisionError) as error:result['reportError']=type(error).__name__
    results.append(result)
json.dump({'source':revision,'cases':results},sys.stdout)
