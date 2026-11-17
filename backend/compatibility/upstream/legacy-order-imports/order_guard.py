"""Cooperating public API-v2 handlers cannot mutate an interrupted import.

This middleware is installed after JSON/auth middleware. It reads the writer,
never its replica, accepts no import bypass header, and validates completion
against its retained purpose key before permitting ordinary source behavior.
"""
import hashlib
import hmac
import json
import os
import re
from sqlalchemy import text


def completed_mac(key,value):
    body='{"kind":"legacy-order-imports.financial.completed.v1","input":'+json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'}'
    return hmac.new(key.encode(),body.encode(),hashlib.sha256).hexdigest()


def order_ids(value,depth=0):
    if depth>5:
        raise ValueError()
    found=set()
    if isinstance(value,dict):
        if len(value)>200:
            raise ValueError()
        for key,item in value.items():
            if key in {'order','order_id','orderId','parent_order_id','parentOrderId','orderid'}:
                if type(item) in (str,int) and re.fullmatch(r'[1-9][0-9]{0,18}',str(item)):
                    found.add(str(item))
            if isinstance(item,(dict,list)):
                found.update(order_ids(item,depth+1))
    elif isinstance(value,list):
        if len(value)>1000:
            raise ValueError()
        for item in value:
            if isinstance(item,(dict,list)):
                found.update(order_ids(item,depth+1))
    if len(found)>1000:
        raise ValueError()
    return found


def line_ids(value,depth=0):
    if depth>5:
        raise ValueError()
    found=set()
    if isinstance(value,dict):
        if len(value)>200:raise ValueError()
        for key,item in value.items():
            if key in {'has_product_id','hasProductId','hp_id','hpId','has_product_ids','hp_id_list','hpIdArr'}:
                if not isinstance(item,list) and item in (None,0,'0',''):
                    continue  # Source explicitly treats zero/empty HP as SKU fallback.
                selected=item if isinstance(item,list) else [item]
                if len(selected)>1000:raise ValueError()
                for entry in selected:
                    if type(entry) not in (str,int) or not re.fullmatch(r'[1-9][0-9]{0,18}',str(entry)):raise ValueError()
                    found.add(str(entry))
            if isinstance(item,(dict,list)):found.update(line_ids(item,depth+1))
    elif isinstance(value,list):
        if len(value)>1000:raise ValueError()
        for item in value:
            if isinstance(item,(dict,list)):found.update(line_ids(item,depth+1))
    if len(found)>1000:raise ValueError()
    return found


def assert_available(session,order_id,key):
    result=session.execute(text('SELECT operation_id,request_hash,status FROM pos_rewrite_import_financial_order_bindings WHERE order_id=:id FOR SHARE'),{'id':order_id})
    binding=result.mappings().first()
    if not binding:
        return
    if binding['status']!='completed' or not re.fullmatch(r'[a-f0-9]{64}',key):
        raise ValueError()
    result=session.execute(text('SELECT data,proof_hash FROM pos_rewrite_import_financial_proofs WHERE operation_id=:op AND order_id=:id AND request_hash=:hash AND OCTET_LENGTH(data)<=1000000 FOR SHARE'),
        {'op':binding['operation_id'],'id':order_id,'hash':binding['request_hash']})
    row=result.mappings().first()
    if not row:
        raise ValueError()
    proof=json.loads(row['data']) if isinstance(row['data'],str) else row['data']
    if (not hmac.compare_digest(completed_mac(key,proof),row['proof_hash']) or
        proof['scope']['operationId']!=binding['operation_id'] or proof['order']['orderId']!=order_id or
        proof['requestHash']!=binding['request_hash']):
        raise ValueError()


class ImportOrderGuard:
    def process_resource(self,req,resp,resource,params):
        if req.method not in {'POST','PUT','PATCH','DELETE'}:
            return
        import falcon
        from database.WriteDbConn import Session
        try:
            data=req.context.get('data')
            if isinstance(data,dict):
                custom=data.get('custom_data') or {}
                # These legacy customer-JWT request fields are reserved for the
                # isolated, independently authorized native import receiver.
                if (data.get('custom_created_at') or (isinstance(custom,dict) and
                    any(custom.get(name) not in (None,'',{}) for name in
                        ('price','tax','shipping_charges','is_shopify_order','currency','discount_amount','address')))):
                    raise ValueError()
            identifiers=order_ids(data)|order_ids(params)
            for line_id in sorted(line_ids(data)|line_ids(params),key=int):
                row=Session.execute(text('SELECT order_id FROM has_products WHERE id=:id FOR SHARE'),{'id':line_id}).mappings().first()
                if not row:raise ValueError()
                identifiers.add(str(row['order_id']))
            for order_id in sorted(identifiers,key=int):
                assert_available(Session,order_id,os.environ.get('POS_LEGACY_IMPORT_FINANCIAL_PROOF_KEY',''))
        except Exception:
            raise falcon.HTTPForbidden('This order requires import reconciliation.') from None
