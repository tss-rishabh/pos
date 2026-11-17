"""Real legacy cash funding of genuine source-origin gift/member assets.

The original Go COC receipt remains immutable and truthfully unpaid. The actual
Django cash helper and native gift issuance are one transaction, not a new Go
confirmation or a reconstructed bank/CSV/public-POS proof.
"""
import copy
import hashlib
import hmac
import json
import os
from sqlalchemy import text
from sqlalchemy.dialects.mysql import dialect
from origin_contracts import canonical,digest,fail
from origin_assets import LINE_SQL,GIFT_SQL,ordinary,gifts_helper
from legacy_staff import one,rows

CONTRACT='pos-screening-origin-legacy-cash-assets-v1'
CARD_SQL="LOWER(SHA2(CAST(JSON_OBJECT('voucher_id',gift_vouchers.id,'order_id',gift_vouchers.order_id,'customer_id',gift_vouchers.from_id,'collection_id',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'voucher_code',gift_vouchers.voucher_code,'initial_value',gift_vouchers.voucher_initial_value,'start_date',gift_vouchers.start_date,'end_date',gift_vouchers.end_date) AS CHAR CHARACTER SET utf8mb4),256))"


class NativeResult:
    def __init__(self,value):self.value=value
    def mappings(self):return self
    def all(self):return list(self.value)
    def fetchall(self):return list(self.value)
    def fetchone(self):return self.value[0] if self.value else None
    def fetchmany(self,limit):return self.value[:limit]
    def close(self):pass


class NativeSession:
    """Bound SQLAlchemy leaf queries on the caller's same Django cursor."""
    def __init__(self,cursor):self.cursor=cursor
    def execute(self,statement,parameters=None):
        clause=text(statement) if isinstance(statement,str) else statement
        compiled=clause.compile(dialect=dialect(paramstyle='format'))
        values=parameters or {}
        self.cursor.execute(str(compiled),tuple(values[name] for name in compiled.positiontup or ()))
        if self.cursor.description:
            names=[field[0] for field in self.cursor.description]
            values=[dict(zip(names,row)) for row in self.cursor.fetchmany(2002)]
            if len(values)>2000:fail()
            return NativeResult(values)
        return NativeResult([])


def document(row,purpose,secret):
    value=json.loads(row['data']) if isinstance(row['data'],str) else row['data']
    if not isinstance(value,dict) or not hmac.compare_digest(digest(secret,purpose,value),row['proof_hash']):fail()
    return value


def member_state(cursor,customer,secret):
    member=ordinary();session=NativeSession(cursor)
    user=one(cursor,'SELECT email FROM users WHERE id=%s FOR UPDATE',(customer,))
    if not user['email']:return {'entityHash':None,'revision':None,'state':[]}
    # This is a factual current dimension snapshot. No member grant is issued
    # and no current entitlement/key is substituted for the old Go receipt.
    member.assert_fence(session,user['email'])
    revision=rows(cursor,'SELECT CAST(revision AS CHAR) AS revision FROM pos_rewrite_membership_versions WHERE customer_id=%s FOR UPDATE',(customer,))
    return {'entityHash':digest(secret,'asset-entity',user['email']),
            'revision':None if not revision else revision[0]['revision'],'state':member.current(session,user['email'])}


def prepare(cursor,creation,creation_hash,paid,payment_hash,secret):
    asset_hash=creation.get('assetsHash')
    if asset_hash is None:
        if rows(cursor,'SELECT id FROM gift_vouchers WHERE order_id=%s LIMIT 1',(creation['orderId'],)) or rows(cursor,'SELECT id FROM has_products WHERE order_id=%s AND gift_voucher_id IS NOT NULL AND gift_voucher_id<>0 LIMIT 1',(creation['orderId'],)):fail('SCREENING_ORIGIN_ASSET_PROOF_REQUIRED')
        return None
    if os.environ.get('POS_SCREENING_ORIGIN_LEGACY_ASSETS_CONTRACT')!=CONTRACT:fail('SCREENING_ORIGIN_ASSET_PROFILE_REQUIRED')
    row=one(cursor,'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_assets WHERE command_id=%s FOR SHARE',(creation['commandId'],))
    value=document(row,'assets',secret)
    if (row['proof_hash']!=asset_hash or str(row['order_id'])!=creation['orderId'] or any(value.get(name)!=creation[name] for name in ('commandId','origin','customerId','orderId','requestHash','cartHash','headerHash'))):fail()
    activation_row=one(cursor,'SELECT order_id,data,proof_hash FROM pos_rewrite_screening_origin_asset_activations WHERE command_id=%s FOR SHARE',(creation['commandId'],))
    activation=document(activation_row,'asset-activation',secret)
    if (activation_row['proof_hash']!=paid.get('assetActivationHash') or str(activation_row['order_id'])!=creation['orderId']
            or activation.get('contract')!='pos-screening-origin-asset-activation-v1' or activation.get('commandId')!=creation['commandId']
            or activation.get('customerId')!=creation['customerId'] or activation.get('assetsHash')!=asset_hash or activation.get('creationHash')!=creation_hash
            or type(activation.get('funded')) is not bool):fail('SCREENING_ORIGIN_ASSET_PROOF_REQUIRED')
    before_member=member_state(cursor,creation['customerId'],secret) if value['membership'] is not None else None
    cards=rows(cursor,"SELECT id,collection_no,gift_card_srno FROM gift_vouchers WHERE order_id=%s AND gv_type='GIFT_CARD' ORDER BY id",(creation['orderId'],))
    if len(cards)>100:fail()
    sizes={}
    for collection in sorted({str(card['collection_no']) for card in cards},key=int):
        native=one(cursor,'SELECT size,is_completed,is_printed,is_block FROM gift_card_collection WHERE id=%s FOR UPDATE',(collection,))
        if native['is_completed']!=1 or native['is_printed']!=1 or native['is_block']!=0 or type(native['size']) is not int or native['size']<1:fail('SCREENING_ORIGIN_GIFT_COLLECTION_CHANGED')
        sizes[collection]=native['size']
    parser=gifts_helper()
    for card in cards:
        collection,index=parser._card_parts(card['gift_card_srno'])
        if str(collection)!=str(card['collection_no']) or index>sizes[str(collection)]:fail()
    return {'source':value,'go':activation,'goHash':activation_row['proof_hash'],'paymentHash':payment_hash,'beforeMember':before_member,'cards':cards}


def line_assets(cursor,order):
    found=rows(cursor,'SELECT id,prod_id,gift_voucher_id,'+LINE_SQL+' AS hash FROM has_products WHERE order_id=%s ORDER BY id LIMIT 1001 FOR UPDATE',(order,))
    if not found or len(found)>1000:fail()
    return [{'lineId':str(row['id']),'productId':str(row['prod_id']),'giftId':None if row['gift_voucher_id'] in (None,0) else str(row['gift_voucher_id']),'inputHash':row['hash']} for row in found]


def lock_order_assets(cursor,creation,state):
    if state is None:return
    if line_assets(cursor,creation['orderId'])!=state['source']['lineAssets']:fail('SCREENING_ORIGIN_ASSET_CHANGED')
    normalized=GIFT_SQL.replace("'status',gift_vouchers.status","'status',0")
    found=rows(cursor,'SELECT id,status,'+normalized+' AS hash FROM gift_vouchers WHERE order_id=%s ORDER BY id LIMIT 101 FOR UPDATE',(creation['orderId'],))
    if len(found)!=len(state['source']['gifts']) or len(found)>100:fail()
    for native,saved in zip(found,state['source']['gifts']):
        if str(native['id'])!=saved['id'] or native['hash']!=saved['inputHash'] or native['status']!=(1 if state['go']['funded'] else 0):fail('SCREENING_ORIGIN_ASSET_CHANGED')
    physical=rows(cursor,'SELECT voucher_id,input_hash,contract_version FROM pos_rewrite_gift_card_issuances WHERE order_id=%s ORDER BY voucher_id FOR UPDATE',(creation['orderId'],))
    if (not state['go']['funded'] and physical) or state['go']['funded'] and len(physical)!=len(state['cards']):fail()


def finish(cursor,creation,creation_hash,state,cash,secret,now):
    if state is None:return None
    native=one(cursor,'SELECT user_id,payment_status FROM orders WHERE id=%s FOR UPDATE',(creation['orderId'],))
    if str(native['user_id'])!=creation['customerId'] or native['payment_status']!=4:fail('SCREENING_ORIGIN_CASH_RECONCILIATION_REQUIRED')
    if line_assets(cursor,creation['orderId'])!=state['source']['lineAssets']:fail()
    normalized=GIFT_SQL.replace("'status',gift_vouchers.status","'status',0")
    gifts=rows(cursor,'SELECT id,status,gv_type,collection_no,gift_card_srno,'+normalized+' AS hash,'+CARD_SQL+' AS card_hash FROM gift_vouchers WHERE order_id=%s ORDER BY id LIMIT 101 FOR UPDATE',(creation['orderId'],))
    if len(gifts)!=len(state['source']['gifts']):fail()
    funding=[]
    for gift,saved in zip(gifts,state['source']['gifts']):
        if str(gift['id'])!=saved['id'] or gift['status']!=1 or gift['hash']!=saved['inputHash']:fail()
        if gift['gv_type']!='GIFT_CARD':continue
        linked=[line['lineId'] for line in state['source']['lineAssets'] if line['giftId']==str(gift['id'])]
        if len(linked)!=1:fail()
        line=one(cursor,'SELECT qty FROM has_products WHERE id=%s AND order_id=%s FOR SHARE',(linked[0],creation['orderId']))
        if line['qty']!=1:fail()
        existing=rows(cursor,'SELECT order_id,collection_id,serial,input_hash,contract_version FROM pos_rewrite_gift_card_issuances WHERE voucher_id=%s FOR UPDATE',(gift['id'],))
        if existing:
            record=existing[0]
            if (not state['go']['funded'] or str(record['order_id'])!=creation['orderId'] or record['input_hash']!=gift['card_hash']
                    or str(record['collection_id'])!=str(gift['collection_no']) or str(record['serial'])!=str(gift['gift_card_srno']) or record['contract_version']!='pos-gift-card-issuance-v1'):fail()
        else:
            if state['go']['funded']:fail()
            cursor.execute('INSERT INTO pos_rewrite_gift_card_issuances(voucher_id,order_id,collection_id,serial,input_hash,contract_version,activated_at) VALUES(%s,%s,%s,%s,%s,%s,CURRENT_TIMESTAMP)',
                           (gift['id'],creation['orderId'],gift['collection_no'],gift['gift_card_srno'],gift['card_hash'],'pos-gift-card-issuance-v1'))
        funding.append({'voucherId':str(gift['id']),'lineId':linked[0],'inputHash':gift['card_hash']})
    after_member=member_state(cursor,creation['customerId'],secret) if state['beforeMember'] is not None else None
    # The pinned cash helper never writes member EAV. Preserve a newer current
    # entitlement; do not reactivate or invent an absent ordinary provenance.
    if after_member!=state['beforeMember']:fail('SCREENING_ORIGIN_MEMBERSHIP_CHANGED')
    proof={'contract':CONTRACT,'commandId':creation['commandId'],'orderId':creation['orderId'],'customerId':creation['customerId'],
        'creationHash':creation_hash,'assetsHash':creation['assetsHash'],'goAssetActivationHash':state['goHash'],'paymentHash':state['paymentHash'],
        'cashInputHash':cash['inputHash'],'nativeFinalHash':cash['nativeFinalHash'],'funded':True,'issuances':funding,
        'membershipBefore':state['beforeMember'],'membershipAfter':after_member,'createdAt':now}
    seal=digest(secret,'legacy-cash-assets',proof)
    cursor.execute('INSERT INTO pos_rewrite_screening_origin_legacy_cash_assets(command_id,order_id,data,proof_hash) VALUES(%s,%s,%s,%s)',
                   (creation['commandId'],creation['orderId'],canonical(proof),seal))
    return seal
