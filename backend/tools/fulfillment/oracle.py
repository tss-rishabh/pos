"""Execute original _hl_get_orders_for_tab with inert record/query adapters."""
import ast
from collections import defaultdict
import datetime
import json
from pathlib import Path
from types import SimpleNamespace
import sys

source = Path(__file__).resolve().parents[4] / 'backend-pos-web/order/views.py'
tree = ast.parse(source.read_text())
node = next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_hl_get_orders_for_tab')


class Query(list):
    def using(self, *args): return self
    def select_related(self,*args): return self
    def annotate(self,**kwargs): return self
    def filter(self,**kwargs):
        def matches(row):
            for key,value in kwargs.items():
                name=key.removesuffix('__in')
                actual=getattr(row,name)
                if key.endswith('__in'):
                    if actual not in value: return False
                elif actual!=value: return False
            return True
        return Query([row for row in self if matches(row)])
    def order_by(self,*names):
        return Query(sorted(self,key=lambda row:tuple(getattr(row,name) for name in names)))


def calculate(case):
    lines=[]
    for row in case:
        hp=None if row['productId'] is None else SimpleNamespace(pre_gst_amt=row['preGstAmount'],gst=row['gst'],shipment_id=row['shipmentId'],awb=row['awb'],status=row['productStatus'])
        lines.append(SimpleNamespace(id=int(row['id']),order_id=1,store_id=1,has_product_id=int(row['hasProductId']),status=row['status'],vinc_status=row['vincStatus'],has_product=hp))
    orders=Query([SimpleNamespace(id=1,min_expires_at=datetime.datetime(2026,11,16,12,0))]) if lines else Query([])
    scope={'READ_DB_ALIAS':'fixture','HL_PAGE_SIZE':20,'Order':SimpleNamespace(objects=orders),'ExpressLineItem':SimpleNamespace(objects=Query(lines)),'Min':lambda *a,**k:None,'Q':lambda **kw:None,'defaultdict':defaultdict}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),str(source),'exec'),scope)
    result=scope['_hl_get_orders_for_tab']('in_queue',1,{'pending_order_ids':{1},'not_packed_order_ids':set(),'packed_order_ids':set(),'shipped_order_ids':set()})
    if not result['items']:return None
    row=result['items'][0]
    return {key:row[key] for key in ['store_order_amt','is_rto','can_mark_rto','is_timed_out','is_vinc_allocated','has_shipment_id','has_awb']}

value=json.load(sys.stdin)
json.dump([calculate(case) for case in value['cases']],sys.stdout)
