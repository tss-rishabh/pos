"""Execute the active pinned Django SDD transport handler with a fake HTTP client."""
import ast
import hashlib
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
from urllib.parse import parse_qsl,urlsplit
PIN='78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
repository=Path(__file__).resolve().parents[4]/'backend-pos-web'
source=subprocess.check_output(['git','show',f'{PIN}:order/views.py'],cwd=repository,text=True)
tree=ast.parse(source)
handler=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='ShowOnlineSDDOrderInvoiceView')
method=next(node for node in handler.body if isinstance(node,ast.FunctionDef) and node.name=='get')
observed=[]
def get(url):
    observed.append(url)
    return SimpleNamespace(status_code=200)
namespace={'requests':SimpleNamespace(get=get),'SDD_ORDER_RECEIPT_URL':'https://renderer.example.test/sdd','ORDER_RECEIPT_TOKEN':'synthetic-only-private-secret','render':lambda _request,template,context:{'template':template,'context':context},'redirect':lambda _route:None,'messages':SimpleNamespace(error=lambda *_args:None)}
exec(compile(ast.Module(body=[method],type_ignores=[]),'pinned/ShowOnlineSDDOrderInvoiceView','exec'),namespace)
result=namespace['get'](None,None,12345)
parameters=dict(parse_qsl(urlsplit(observed[0]).query))
assert parameters=={'order_id':'12345','is_sdd_shipment':'0','pos_token':'synthetic-only-private-secret'}
assert result['template']=='order/invoice.html' and result['context']['is_store'] is False
print(json.dumps({'sourceCommit':PIN,'sourceHandlerSha256':hashlib.sha256(ast.get_source_segment(source,method).encode()).hexdigest(),'orderId':parameters['order_id'],'isSddShipment':parameters['is_sdd_shipment'],'legacyCredentialInQuery':True,'rewriteCredentialTransport':'private-header-only','template':result['template'],'isStore':result['context']['is_store'],'requests':len(observed)}))
