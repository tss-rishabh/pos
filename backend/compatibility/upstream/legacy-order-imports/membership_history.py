"""Typed, purpose-bound history input for literal AddFreeMembership criteria.

The original SELECT decisions execute against a complete qualified publication,
never an old-order MySQL fallback. The production BigQuery provider is a separate
integration: no provider/proof means no history-dependent membership import.
"""
from datetime import datetime,timedelta
import hashlib
import hmac
import re
from typing import Protocol,TypedDict
from protocol import ImportReview,canonical

CONTRACT='pos-csv-membership-history-v1'
class HistoryRequest(TypedDict):
    contract:str
    operationId:str
    requestHash:str
    planHash:str
    customerId:str
    asOf:str
    cutoff:str
class QualifiedHistoryPort(Protocol):
    def read(self,request:HistoryRequest)->dict: ...


def review(code='ORDER_IMPORT_MEMBERSHIP_HISTORY_REQUIRED'):
    from membership_profile import refuse
    refuse(code)


def signature(value,key):
    if not isinstance(key,str) or not 32<=len(key.encode())<=4096:
        review()
    encoded='{"kind":"legacy-order-imports.membership-history.v1","input":'+canonical(value)+'}'
    return hmac.new(key.encode(),encoded.encode(),hashlib.sha256).hexdigest()


def request(state,clock):
    return {'contract':CONTRACT,'operationId':state['capability']['operationId'],
            'requestHash':state['capability']['requestHash'],'planHash':state['capability']['planHash'],
            'customerId':str(state['user']['user_id']),'asOf':clock.strftime('%Y-%m-%d %H:%M:%S'),
            'cutoff':(clock-timedelta(days=45)).strftime('%Y-%m-%d %H:%M:%S')}


def validate(value,expected,key,member_ids,now_ms):
    if not isinstance(value,dict) or set(value)!={'scope','reader','generationId','complete','fetchedAt','lastDeliveredOrder','recentDeliveredOrders','signature'}:
        review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    body={key:value for key,value in value.items() if key!='signature'}
    if (value['scope']!=expected or value['reader']!='bigquery' or value['complete'] is not True
            or not isinstance(value['generationId'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['generationId'])
            or type(value['fetchedAt']) is not int or not 0<=now_ms-value['fetchedAt']<=60000
            or not isinstance(value['signature'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['signature'])):
        review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    recent=value['recentDeliveredOrders'];last=value['lastDeliveredOrder']
    if not isinstance(recent,list) or len(recent)>5000:
        review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    orders=([last] if last is not None else [])+recent
    total_lines=0
    for order in orders:
        if not isinstance(order,dict) or set(order)!={'id','paymentMethod','createdAt','lines'}:
            review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
        if (not isinstance(order['id'],str) or not re.fullmatch(r'[1-9]\d{0,18}',order['id'])
                or type(order['paymentMethod']) is not int or not 0<=order['paymentMethod']<=32767
                or not isinstance(order['createdAt'],str)):
            review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
        try:
            datetime.strptime(order['createdAt'],'%Y-%m-%d %H:%M:%S')
        except (ValueError,TypeError):review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
        if not isinstance(order['lines'],list) or len(order['lines'])>10000:
            review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
        total_lines+=len(order['lines'])
        if total_lines>20000:review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
        ids=set();flags=set()
        for row in order['lines']:
            if (not isinstance(row,dict) or set(row)!={'lineId','productId','isExclusiveOrder'}
                    or any(not isinstance(row[name],str) or not re.fullmatch(r'[1-9]\d{0,18}',row[name]) for name in ('lineId','productId'))
                    or type(row['isExclusiveOrder']) is not int or row['isExclusiveOrder'] not in (0,1) or row['lineId'] in ids):
                review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
            ids.add(row['lineId'])
            if row['productId'] not in member_ids:flags.add(row['isExclusiveOrder'])
        # The literal source has no HP ORDER BY and uses first ordinary row.
        # A mixed exclusive/nonexclusive order has no determinate parity input.
        if len(flags)>1:review('ORDER_IMPORT_MEMBERSHIP_HISTORY_AMBIGUOUS')
    if len(canonical(body).encode())>1000000 or not hmac.compare_digest(value['signature'],signature(body,key)):
        review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    # Literal source has only a lower cutoff, including future-dated delivered
    # records when present. Do not invent an upper timestamp predicate.
    if len({order['id'] for order in recent})!=len(recent) or any(not expected['cutoff']<order['createdAt'] for order in recent):
        review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    if any(first['createdAt']<=second['createdAt'] for first,second in zip(recent,recent[1:])):
        review('ORDER_IMPORT_MEMBERSHIP_HISTORY_AMBIGUOUS')
    if recent and (last is None or last!=recent[0]):review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    if last is not None and last['createdAt']>expected['cutoff'] and not recent:review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
    return value


class Result:
    def __init__(self,rows):self.rows=rows
    def fetchone(self):return self.rows[0] if self.rows else None
    def fetchall(self):return list(self.rows)


class HistorySession:
    """Only the three exact original history SELECT shapes are substituted."""
    def __init__(self,session,facts):self.session,self.facts=session,facts
    def execute(self,statement,params=None,**kwargs):
        compact=' '.join(str(statement).split()).strip()
        params=params or kwargs.get('parameters') or {}
        scope=self.facts['scope']
        if compact=='SELECT id, payment_method, order_status FROM orders WHERE user_id = :user_id AND order_status = 3 ORDER BY created_at DESC LIMIT 1':
            if str(params.get('user_id'))!=scope['customerId']:review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
            last=self.facts['lastDeliveredOrder'];return Result([] if last is None else [self.order(last)])
        if compact=='SELECT id, payment_method, order_status FROM orders WHERE user_id = :user_id AND order_status = 3 AND created_at > :date_before ORDER BY created_at DESC':
            if str(params.get('user_id'))!=scope['customerId'] or params.get('date_before')!=scope['cutoff']:review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
            return Result([self.order(row) for row in self.facts['recentDeliveredOrders']])
        if compact=='SELECT prod_id,is_exclusive_order FROM has_products WHERE order_id = :order_id':
            candidates=([self.facts['lastDeliveredOrder']] if self.facts['lastDeliveredOrder'] is not None else [])+self.facts['recentDeliveredOrders']
            match=next((order for order in candidates if order['id']==str(params.get('order_id'))),None)
            if match is None:review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
            return Result([{'prod_id':int(row['productId']),'is_exclusive_order':row['isExclusiveOrder']} for row in match['lines']])
        # Only ordinary, current catalog SQL may still use the supplied native TX.
        if re.search(r'\b(?:orders|has_products)\b',compact,re.I):review('ORDER_IMPORT_MEMBERSHIP_HISTORY_INVALID')
        return self.session.execute(statement,params,**kwargs)
    @staticmethod
    def order(row):return {'id':int(row['id']),'payment_method':row['paymentMethod'],'order_status':3}
    def __getattr__(self,name):return getattr(self.session,name)
