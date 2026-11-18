"""Explicit global-online authority: a context store is never a legal issuer or order owner."""
import base64
import hashlib
import hmac
import json
import re
import time

CONTRACT = 'pos-global-online-invoice-v1'


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate global invoice field')
        value[key] = item
    return value


def require_global(req, invoice_scope, history, snapshot, kind='online'):
    parts = snapshot['parts']
    token = req.get_header('X-POS-Global-Invoice') or ''
    genuine = not parts[8] and parts[6] is None
    ids = {row[0] for row in parts[9]}
    owned_express = bool(parts[10]) and all(row[2] == history['storeId'] and row[1] in ids for row in parts[10]) and {row[1] for row in parts[10]} == ids
    owned_mapping = len(parts[8]) == 1 and parts[8][0][1] == history['storeId']
    owned_local = parts[5] == 'SW' and parts[6] == history['storeId'] and not parts[7] and all(row[1] == '4' for row in parts[9])
    if not token and (owned_mapping or owned_express or owned_local):
        return None
    if not genuine or len(token) > 8192 or req.get_header('X-POS-Global-Invoice-Contract') != CONTRACT:
        raise ValueError('Global invoice scope unavailable')
    contract, body, signature = token.split('.')
    if contract != CONTRACT or not re.fullmatch(r'[A-Za-z0-9_-]{1,4096}', body) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', signature):
        raise ValueError('Global invoice scope unavailable')
    key = invoice_scope['service_key'].encode()
    if not hmac.compare_digest(base64.urlsafe_b64decode(signature+'='), hmac.new(key,(contract+'.'+body).encode(),hashlib.sha256).digest()):
        raise ValueError('Global invoice signature unavailable')
    value = json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)),object_pairs_hook=unique)
    if set(value) != {'v','purpose','contract','kind','orderId','operatorId','contextStoreId','ownerStoreId','customerId','role','userType','issuerPolicy','selection','nativeSnapshot','actorSnapshot','historyProofHash','nonce','requestId','issuedAt','expiresAt'}:
        raise ValueError('Global invoice fields unavailable')
    if type(value['v']) is not int or value['v'] != 1 or value['purpose'] != 'global-online-invoice' or value['contract'] != CONTRACT or value['kind'] != kind or kind not in ('online','same-day'):
        raise ValueError('Global invoice purpose unavailable')
    for name in ('orderId','operatorId','contextStoreId','customerId'):
        if not isinstance(value[name],str) or not re.fullmatch(r'[1-9][0-9]{0,18}',value[name]) or int(value[name]) > 9223372036854775807:
            raise ValueError('Global invoice identity unavailable')
    if value['ownerStoreId'] is not None or type(value['role']) is not int or value['role'] not in (1,2,3,4,5) or type(value['userType']) is not int or value['userType'] != 1:
        raise ValueError('Global invoice reader unavailable')
    if value['issuerPolicy'] != ('pinned-online-renderer' if kind=='online' else 'source-sdd-renderer') or value['selection'] != ('full-order' if kind=='online' else 'source-is-sdd-shipment-0'):
        raise ValueError('Global invoice issuer policy unavailable')
    for name in ('nativeSnapshot','actorSnapshot','historyProofHash'):
        if not isinstance(value[name],str) or not re.fullmatch(r'[a-f0-9]{64}',value[name]):
            raise ValueError('Global invoice binding unavailable')
    if any(value[name] != history[name] for name in ('orderId','operatorId','customerId','nonce','requestId')) or value['contextStoreId'] != history['storeId'] or value['nativeSnapshot'] != snapshot['binding'] or value['historyProofHash'] != hashlib.sha256(history['capability'].encode()).hexdigest():
        raise ValueError('Global invoice binding changed')
    if value['orderId'] != invoice_scope['order_id'] or value['operatorId'] != invoice_scope['operator_id'] or value['nonce'] != invoice_scope['nonce'] or value['requestId'] != invoice_scope['request_id']:
        raise ValueError('Global invoice request changed')
    now=int(time.time())
    if type(value['issuedAt']) is not int or type(value['expiresAt']) is not int or not 0 < value['expiresAt']-value['issuedAt'] <= 30 or value['issuedAt'] > now+5 or value['expiresAt'] <= now:
        raise ValueError('Global invoice expired')
    ids={row[0] for row in parts[9]}
    if not ids or len(ids) != len(parts[9]) or any(row[1] not in ids for row in parts[10]):
        raise ValueError('Global invoice lines unavailable')
    if kind=='same-day' and not (parts[7] and any(row[1] in ('3','4') for row in parts[9]) and any(row[1] not in ('3','4') for row in parts[9])):
        raise ValueError('Global SDD selection unavailable')
    return token


def stamp_global(resp, html, token, key):
    message='\n'.join((CONTRACT,hashlib.sha256(token.encode()).hexdigest(),hashlib.sha256(html.encode()).hexdigest()))
    resp.set_header('X-POS-Global-Invoice-Contract',CONTRACT)
    resp.set_header('X-POS-Global-Invoice-Proof',hmac.new(key.encode(),message.encode(),hashlib.sha256).hexdigest())
