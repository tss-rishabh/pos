"""Literal pinned cancellation presentation, without importing the source app.

The old whole-order web write handler lacks this protection; the rewrite adds
an authoritative denial for the source's stated ticket non-cancellation intent.
"""
import ast
import hashlib
import json
import os
from pathlib import Path

repo=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT', str(Path(__file__).resolve().parents[4]/'backend-tss-api_v2')))
controller=(repo/'controllers/OrderController.py').read_bytes()
if hashlib.sha256(controller).hexdigest()!='821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad':
    raise RuntimeError('Pinned cancellation source changed')
expected=ast.parse('int(product.get("product_id") or 0) == SCREENING_TICKET_SKU',mode='eval').body
matches=[node for node in ast.walk(ast.parse(controller)) if isinstance(node,ast.If) and ast.dump(node.test,include_attributes=False)==ast.dump(expected,include_attributes=False)]
if len(matches)!=1:raise RuntimeError('Source screening cancellation predicate changed')
code=compile(ast.Module(body=matches,type_ignores=[]),'<pinned-screening-cancellation-presentation>','exec')
results=[]
for value in (390238,'390238',11,None):
    scope={'product':{'product_id':value,'non_cancellable':False},'SCREENING_TICKET_SKU':390238,'window_message':''}
    exec(code,scope)
    results.append({'productId':value,'blocked':scope['product']['non_cancellable'],'message':scope['window_message']})
print(json.dumps({'sourceCommit':'2960acbea10c4eaf16b6d99e15ff6e03ef7724c5','cases':results}))
