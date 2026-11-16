"""Execute the literal pinned web handler without Django, Redis or HTTP startup."""
import ast
from copy import deepcopy
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import sys

sys.dont_write_bytecode=True
repo=Path(__file__).resolve().parents[4]/'backend-pos-web'
source=subprocess.check_output(['git','show','78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:order/views.py'],cwd=repo,text=True)
node=next(node for node in ast.parse(source).body if isinstance(node,ast.ClassDef) and node.name=='AjaxFetchTheProducts')
class Login:pass
class View:pass
class Response:
 def __init__(self,body,**kwargs):self.body=body
class Query:
 def __init__(self,rows):self.rows=rows
 def first(self):return self.rows[0] if self.rows else None
 def __iter__(self):return iter(self.rows)
def run(connected=True,missing=False,stop=None,duplicate=False):
 calls=[];syncs=[];clears=[];cart={'products':{'items':[]},'giftvouchers':{'items':[]}}
 class CartView:
  def add_to_cart(self,*args,**kwargs):
   calls.append((args,kwargs))
   if stop=='none' and len(calls)==2:return None
   if stop=='error' and len(calls)==2:raise RuntimeError('inert source failure')
   cart['products']['items'].append({'prod_id':args[1],'quantity':1})
   return SimpleNamespace(json=lambda:deepcopy(cart))
  def clear_cart(self,*args,**kwargs):clears.append(kwargs)
 namespace={'LoginRequiredMixin':Login,'View':View,'HttpResponse':Response,'json':json,'redis_instance':SimpleNamespace(set=lambda *a,**k:None),'REDIS_TAB_USER_OBJECT_EXPIRY':3600,
  'Helpers':SimpleNamespace(create_token=lambda user:('inert-target-token',False)),
  'CreateOrderView':SimpleNamespace(get_user_cart=lambda *a,**k:{'products':{'items':[]},'giftvouchers':{'items':[]}}),
  'Order':SimpleNamespace(objects=SimpleNamespace(filter=lambda **k:Query([] if missing else [SimpleNamespace(id=11)]))),
  'HasProduct':SimpleNamespace(objects=SimpleNamespace(filter=lambda **k:Query([SimpleNamespace(product=SimpleNamespace(id=10),qty=8),SimpleNamespace(product=SimpleNamespace(id=10 if duplicate else 11),qty=7)]))),
  'ProductBarcode':SimpleNamespace(objects=SimpleNamespace(filter=lambda **k:Query([SimpleNamespace(gtin='barcode-'+str(k['product']))]))),
  'AjaxCartView':CartView,'logger':SimpleNamespace(error=lambda *a:None,warning=lambda *a:None,exception=lambda *a:None)}
 exec(compile(ast.Module(body=[node],type_ignores=[]),'<pinned-AjaxFetchTheProducts>','exec'),namespace)
 handler=namespace['AjaxFetchTheProducts']()
 def sync(value,*args):syncs.append(deepcopy(value));return SimpleNamespace(status_code=200)
 handler.sync_cart=sync
 request=SimpleNamespace(POST={'tab_id':'2','store_id':'1','auth_token':'inert-actor-token','order_id':'11','end_user_cart':'1' if connected else '0','user_id':'7'})
 result=json.loads(handler.post(request).body)
 return {'status':result['status'],'message':result['message'].strip(),'calls':len(calls),'productIds':[row[0][1] for row in calls],'syncs':len(syncs),'clears':len(clears),'syncedItems':syncs[-1]['products']['items'] if syncs else []}
vectors={name:run(**options) for name,options in {'normal':{},'disconnected':{'connected':False},'missing':{'missing':True},'partial-none':{'stop':'none'},'thrown-error':{'stop':'error'},'duplicate-sku':{'duplicate':True}}.items()}
assert vectors['normal']['calls']==2 and [item['quantity'] for item in vectors['normal']['syncedItems']]==[1,1,1]
assert vectors['duplicate-sku']['productIds']==[10,10]
assert vectors['disconnected']['calls']==0 and vectors['disconnected']['status']==204
assert vectors['partial-none']['syncs']==1 and vectors['partial-none']['message']=='Cart partially synced - please review the cart'
assert vectors['thrown-error']['message']=='Cart Synced' and vectors['thrown-error']['syncs']==1
print(json.dumps(vectors,separators=(',',':')))
