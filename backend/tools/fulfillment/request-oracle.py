"""Capture the legacy request helpers without importing Django or sending requests."""
import ast
from pathlib import Path
from types import SimpleNamespace
import json
import sys

root=Path(__file__).resolve().parents[4]/'backend-pos-web'
helpers=ast.parse((root/'helpers/helpers.py').read_text())
helper_class=next(node for node in helpers.body if isinstance(node,ast.ClassDef) and node.name=='Helpers')
names={'call_status_api','_notify_mailr','call_express_out_for_delivery_api','express_concurrency_sync'}
helper_class.body=[node for node in helper_class.body if isinstance(node,ast.FunctionDef) and node.name in names]
views=ast.parse((root/'order/views.py').read_text())
rto=next(node for node in views.body if isinstance(node,ast.FunctionDef) and node.name=='_call_vinculum_rto_api')
recorded=[]
def post(url,**kwargs):
    recorded.append({'url':url,'payload':kwargs.get('json'),'headers':kwargs.get('headers',{})})
    return SimpleNamespace(status_code=200,raise_for_status=lambda:None)
class Thread:
    def __init__(self,target,**kwargs):self.target=target
    def start(self):self.target()
logger=SimpleNamespace(info=lambda *a,**kw:None,warning=lambda *a,**kw:None,error=lambda *a,**kw:None,exception=lambda *a,**kw:None)
scope={'requests':SimpleNamespace(post=post,exceptions=SimpleNamespace(RequestException=Exception,Timeout=TimeoutError,HTTPError=ValueError)),'threading':SimpleNamespace(Thread=Thread),'logger':logger,'BACKEND_SYNC_API_BASE_URL':'https://sync.example.test','BACKEND_SYNC_REPO_API_KEY':'fixture-sync-key','MJML_HOST':'https://mailr.example.test/','PREORDER_URL':'https://preorder.example.test/','PREORDER_INTERNAL_KEY':'fixture-preorder-key'}
exec(compile(ast.fix_missing_locations(ast.Module(body=[helper_class,rto],type_ignores=[])),'legacy-request-helpers','exec'),scope)
result=[]
for case in json.load(sys.stdin)['cases']:
    recorded.clear()
    if case['kind']=='status-api':scope['Helpers'].call_status_api(case['orderId'],case['hasProductIds'],case['status'],True)
    elif case['kind']=='rto-api':scope['_call_vinculum_rto_api'](case['orderId'],case['hasProductIds'])
    elif case['kind']=='out-for-delivery-api':scope['Helpers'].call_express_out_for_delivery_api(case['orderId'],case['awb'])
    elif case['kind']=='concurrency-sync':scope['Helpers'].express_concurrency_sync(case['storeId'],case['pending'],case['accepted'])
    result.append(recorded[0] if recorded else None)
json.dump(result,sys.stdout)
