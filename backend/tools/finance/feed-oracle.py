"""Execute the actual legacy record builders with inert query responses."""
import ast
from datetime import datetime,timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
import json
import math
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/glassbox_finance_feed_views.py'
tree=ast.parse(source.read_text())
names={'_fetch_sale_records','_new_sale_record','_apply_line_item','_split_refund','_fetch_return_records','_new_return_record','_success_response'}
nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
def run(case):
    def rows(values):
        result=[]
        for raw in values:
            row=raw.copy();row['id']=int(row['id']);row['transaction_date']=datetime.fromisoformat(row['transaction_date']) if row['transaction_date'] else None
            for key in ['CASH','PaytmCardUpi','PinelabCardUpi','OnlineOther','DistrictAmount','CreditPincodeAmount']:
                if key in row and isinstance(row[key],str):row[key]=Decimal(row[key])
            result.append(row)
        return result
    sales,returns=rows(case['sales']),rows(case['returns'])
    scope={'math':math,'JsonResponse':lambda value:value,'ORDERS_QUERY':'sales','RETURNS_QUERY':'returns {ro_where} {rr_where}','_to_exclusive_upper_bound':lambda params:'fixture-end','_run_query':lambda query,args:sales if query.startswith('sales') else returns}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),str(source),'exec'),scope)
    params={'from':'2026-11-01','to':'2026-11-30','store_code':None}
    records=scope['_fetch_sale_records'](params)+scope['_fetch_return_records'](params)
    records.sort(key=lambda row:(row['transaction_date'] or '',row['order_id'],row['transaction_type']))
    response=scope['_success_response'](records,case['page'],case['pageSize'])
    return response
json.dump([run(case) for case in json.load(sys.stdin)['cases']],sys.stdout,default=lambda value:str(value) if isinstance(value,Decimal) else value)
