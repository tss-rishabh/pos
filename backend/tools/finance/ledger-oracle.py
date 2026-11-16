"""Run the source cash ledger with inert store/query adapters and Decimal fixtures."""
import ast
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
import datetime
import json
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/report/cash_balance_services.py'
tree=ast.parse(source.read_text())
names={'expected_cash','_start_day','ledger','_base_row','_closed_row','_open_row'}
nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
class Query(list):
    def using(self,*args):return self
    def filter(self,**kwargs):return Query([row for row in self if row.id in kwargs['id__in']])
    def order_by(self,name):return Query(sorted(self,key=lambda row:getattr(row,name)))

def run(case):
    date=lambda value:datetime.date.fromisoformat(value)
    anchors={}
    for row in case['anchors']:anchors.setdefault(int(row['storeId']),{})[date(row['date'])]=Decimal(row['amount'])
    closes={}
    for row in case['closes']:
        key=(int(row['storeId']),date(row['date']))
        if key in closes and closes[key].version>row['version']:continue
        closes[key]=SimpleNamespace(version=row['version'],status=row['status'],cash_system=Decimal(row['cashSystem']),cash_refund_system=Decimal(row['cashRefund']),cash_manual_punched=Decimal(row['cashPunched']),cash_manual_created=Decimal(row['cashCreated']),cash_actual=Decimal(row['cashActual']),cash_difference=Decimal(row['cashDifference']),banking_amount=Decimal(row['banking']))
    banking={(int(row['storeId']),date(row['date'])):Decimal(row['amount']) for row in case['banking']}
    sales={(int(row['storeId']),date(row['date'])):Decimal(row['cash'])-Decimal(row['cashRefund']) for row in case['sales']}
    scope={'datetime':datetime,'_anchors':lambda ids,end:{key:value for key,value in anchors.items() if key in ids},'_latest_closes':lambda *args:closes,'day_close':SimpleNamespace(banking_map=lambda *args:banking),'Store':SimpleNamespace(objects=Query([SimpleNamespace(id=int(row['id']),store_name=row['name']) for row in case['stores']])),'READ_DB_ALIAS':'fixture','_live_sales':lambda store,day:sales[(store,day)]}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),str(source),'exec'),scope)
    rows=scope['ledger']([int(row['id']) for row in case['stores']],date(case['from']),date(case['to']))
    for row in rows:
        row['store_id']=str(row['store_id']);row['date']=row['date'].isoformat()
        for key,value in row.items():
            if isinstance(value,Decimal):row[key]=str(value.quantize(Decimal('0.01')))
    return rows
json.dump([run(case) for case in json.load(sys.stdin)['cases']],sys.stdout)
