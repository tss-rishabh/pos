"""Run the original expiry helpers against inert queries; no Django/network access."""
import ast
from collections import defaultdict
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import json
import sys

source=Path(__file__).resolve().parents[4]/'backend-pos-web/order/tasks.py'
tree=ast.parse(source.read_text())
nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in ['_split_and_process','_auto_pack_accepted']]

class Query:
    def __init__(self,items,filters=None):self.items=items;self.filters=filters or {}
    def __iter__(self):return iter([item for item in self.items if all(getattr(item,key.removesuffix('__in')) in value if key.endswith('__in') else getattr(item,key)==value for key,value in self.filters.items())])
    def filter(self,**kwargs):return Query(self.items,{**self.filters,**kwargs})
    def update(self,**kwargs):
        for item in list(self):
            for key,value in kwargs.items():setattr(item,key,value)
    def values_list(self,*names,**kwargs):return [tuple(getattr(item,name) for name in names) for item in self]

def run(case):
    items=[SimpleNamespace(id=int(line['id']),order_id=int(line['orderId']),has_product_id=int(line['hasProductId']),status=line['status'],vinc_status=line['vincStatus']) for line in case['lines']]
    products=Query([SimpleNamespace(id=item.has_product_id,product=100+item.has_product_id) for item in items])
    sink=[]
    helpers=SimpleNamespace(now_ist=lambda:'fixture-now',slack_text_notification=lambda *a,**k:None,call_status_api=lambda *a,**k:None,express_concurrency_sync=lambda *a,**k:None)
    scope={'defaultdict':defaultdict,'VINC_ALLOCATED':['Allocated','Part Allocated'],'HL_TIMED_OUT_REASON_ID':5,'HasProduct':SimpleNamespace(objects=products),'ExpressOrderStatusLog':SimpleNamespace(objects=SimpleNamespace(using=lambda _:SimpleNamespace(create=lambda **kw:sink.append(kw)))),'Helpers':helpers,'transaction':SimpleNamespace(atomic=lambda **k:nullcontext()),'logger':SimpleNamespace(info=lambda *a,**k:None),'_call_rejection_api':lambda *a,**k:None}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),str(source),'exec'),scope)
    scope['_auto_pack_accepted' if case['phase']=='accepted-expiry' else '_split_and_process'](Query(items),1,'Fixture store')
    return sorted([{'orderId':str(entry['order_id']),'from':entry['old_status'],'to':entry['new_status'],'ids':sorted(str(item.id) for item in items if item.order_id==entry['order_id'])} for entry in sink],key=lambda entry:int(entry['orderId']))

json.dump([run(case) for case in json.load(sys.stdin)['cases']],sys.stdout)
