"""Real source-origin member/voucher causal evidence, without POS/CSV caps.

This producer records the original native asset mutation; it cannot declare a
payment, activate a voucher, or authorize a different customer/source command.
"""
import copy
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType
from sqlalchemy import text,null
from native import one,rows
from origin_contracts import canonical,digest,fail

CONTRACT='pos-screening-origin-assets-v1'
SOURCE='2960acbea10c4eaf16b6d99e15ff6e03ef7724c5'
LINE_SQL="LOWER(SHA2(CAST(JSON_OBJECT('lineId',has_products.id,'orderId',has_products.order_id,'productId',has_products.prod_id,'subProductId',has_products.sub_prod_id,'giftId',has_products.gift_voucher_id,'quantity',has_products.qty) AS CHAR CHARACTER SET utf8mb4),256))"
GIFT_SQL="LOWER(SHA2(CAST(JSON_OBJECT('id',gift_vouchers.id,'fromId',gift_vouchers.from_id,'toId',gift_vouchers.to_id,'code',gift_vouchers.voucher_code,'theme',gift_vouchers.theme,'toName',gift_vouchers.to_name,'toPhone',gift_vouchers.to_phone,'value',gift_vouchers.voucher_value,'initialValue',gift_vouchers.voucher_initial_value,'message',gift_vouchers.message,'status',gift_vouchers.status,'orderId',gift_vouchers.order_id,'couponId',gift_vouchers.coupon_id,'occasion',gift_vouchers.occassion_name,'occasionMessage',gift_vouchers.occassion_custom_msg,'type',gift_vouchers.gv_type,'start',gift_vouchers.start_date,'end',gift_vouchers.end_date,'collection',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'isPin',gift_vouchers.is_gcpin,'platform',gift_vouchers.platform) AS CHAR CHARACTER SET utf8mb4),256))"


def ordinary():
    root=Path(__file__).resolve().parent.parent/'pending-cancellation'
    location=str(root)
    if location not in sys.path:sys.path.insert(0,location)
    value=ModuleType('screening_origin_ordinary_member_state')
    exec(compile((root/'membership_provenance.py').read_text(),'<ordinary-origin-member-state>','exec'),value.__dict__)
    return value


def gifts_helper():
    path=Path(__file__).resolve().parent.parent/'payload/controllers/cart/pos_gift_card_issuance.py'
    spec=importlib.util.spec_from_file_location('screening_origin_physical_gifts',path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


class OriginAssets:
    def __init__(self,settings,key,contract):
        if contract!=CONTRACT:fail('SCREENING_ORIGIN_ASSET_PROFILE_REQUIRED')
        self.settings,self.key=settings,key
        self.members=ordinary();self.member_key,self.member_ids=self.members.config(settings)
        if self.member_key==key:fail('SCREENING_ORIGIN_KEY_REQUIRED')
        self.gifts=gifts_helper()
    def before(self,frame):
        # Customer and current member version precede every source Order lock.
        email=frame.customer['email'];before=[];revision=None
        if email:
            native,revision=self.members.lock_customer(frame.session,frame.value['customerId'])
            if native['email']!=email:fail('SCREENING_ORIGIN_ASSET_CONTACT_CHANGED')
            before=self.members.current(frame.session,email)
        selected=[]
        from controllers.cart.Cart import ItemTypes
        if frame.kind=='pos':
            wires=frame.req.context['data'].get('gc_data') or {}
            if not isinstance(wires,dict):fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
            for item in frame.cart.get(ItemTypes.GIFT_VOUCHERS):
                wire=wires.get(str(item.get('gv_id')))
                if not isinstance(wire,dict) or item.get('quantity',1)!=1:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
                serial=str(wire.get('gift_card_no',''))
                try:collection,index=self.gifts._card_parts(serial)
                except Exception:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
                selected.append({'serial':serial,'collection':str(collection),'index':index})
            for collection in sorted({item['collection'] for item in selected},key=int):
                row=one(frame.session,'SELECT size,is_completed,is_printed,is_block FROM gift_card_collection WHERE id=:id FOR UPDATE',{'id':collection})
                if (row['is_completed']!=1 or row['is_printed']!=1 or row['is_block']!=0 or type(row['size']) is not int
                        or row['size']<1 or any(item['index']>row['size'] for item in selected if item['collection']==collection)):fail('SCREENING_ORIGIN_GIFT_COLLECTION_CHANGED')
        if len(selected)>100 or len({item['serial'] for item in selected})!=len(selected):fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
        return {'email':email,'before':copy.deepcopy(before),'revision':revision,'physical':selected}
    def construct(self,original,*args,**kwargs):
        voucher=original(*args,**kwargs)
        from origin_frame import CURRENT_ORIGIN
        frame=CURRENT_ORIGIN.get()
        if frame is None or frame.owner.assets is not self:return voucher
        if voucher is None:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
        voucher_type=getattr(voucher.gv_type,'value',voucher.gv_type)
        if voucher_type=='GIFT_CARD':
            serial=str(voucher.gift_card_srno)
            if serial not in {item['serial'] for item in frame.asset_state['physical']}:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
            # Reuse the ordinary physical collection/unique voucher fence, not
            # PublicGiftProfile or its Node authorization namespace.
            self.gifts._lock_pos_card_collection(frame.session,voucher)
        if voucher.to_phone=='':voucher.to_phone=0
        # Real SQL NULL preserves absent dates; never manufacture an expiry.
        dates=rows(frame.session,"SELECT COLUMN_NAME,IS_NULLABLE,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='gift_vouchers' AND COLUMN_NAME IN ('start_date','end_date')",limit=3)
        if len(dates)!=2 or any(row['IS_NULLABLE']!='YES' or row['DATA_TYPE'] not in ('date','datetime','timestamp') for row in dates):fail('SCREENING_ORIGIN_GIFT_SCHEMA_UNQUALIFIED')
        for name in ('start_date','end_date'):
            if getattr(voucher,name,None) in ('',None):setattr(voucher,name,null())
        if voucher.status!=0:fail('SCREENING_ORIGIN_GIFT_FUNDING_UNQUALIFIED')
        return voucher
    def capture(self,frame,header_hash,now):
        state=frame.asset_state;session=frame.session
        identity=one(session,'SELECT email FROM users WHERE id=:id FOR SHARE',{'id':frame.value['customerId']})
        if identity['email']!=state['email']:fail('SCREENING_ORIGIN_ASSET_CONTACT_CHANGED')
        after=[];revision_after=None
        if state['email']:
            after=self.members.current(session,state['email'])
            revision_after=int(one(session,'SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR UPDATE',{'id':frame.value['customerId']})['revision'])
            if after!=state['before'] and revision_after==state['revision']:revision_after=self.members.bump(session,frame.value['customerId'])
            if revision_after<state['revision']:fail('SCREENING_ORIGIN_MEMBERSHIP_RECONCILIATION_REQUIRED')
        line_rows=rows(session,'SELECT id,prod_id,gift_voucher_id,'+LINE_SQL+' AS hash FROM has_products WHERE order_id=:id ORDER BY id LIMIT 1001 FOR SHARE',{'id':frame.order_id},1002)
        if not line_rows or len(line_rows)>1000:fail('SCREENING_ORIGIN_LINE_LIMIT')
        line_assets=[{'lineId':str(row['id']),'productId':str(row['prod_id']),
                      'giftId':None if row['gift_voucher_id'] in (None,0) else str(row['gift_voucher_id']),'inputHash':row['hash']} for row in line_rows]
        actual=rows(session,'SELECT id,order_id,from_id,status,collection_no,gift_card_srno,gv_type,'+GIFT_SQL+' AS hash FROM gift_vouchers WHERE order_id=:id ORDER BY id LIMIT 101 FOR UPDATE',{'id':frame.order_id},102)
        if len(actual)>100:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
        gifts=[]
        for row in actual:
            if str(row['from_id'])!=frame.value['customerId'] or str(row['order_id'])!=frame.order_id or row['status']!=0:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
            if row['gv_type']=='GIFT_CARD':
                matched=[item for item in state['physical'] if item['serial']==str(row['gift_card_srno']) and item['collection']==str(row['collection_no'])]
                if len(matched)!=1:fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
            gifts.append({'id':str(row['id']),'fromId':str(row['from_id']),'orderId':str(row['order_id']),
                          'lineIds':[line['lineId'] for line in line_assets if line['giftId']==str(row['id'])],'inputHash':row['hash']})
        if any(line['giftId'] is not None and line['giftId'] not in {row['id'] for row in gifts} for line in line_assets):fail('SCREENING_ORIGIN_GIFT_SCOPE_CHANGED')
        member_lines=[line for line in line_assets if int(line['productId']) in self.member_ids]
        changed=after!=state['before']
        if (member_lines or changed) and not state['email']:fail('SCREENING_ORIGIN_MEMBERSHIP_CONTACT_REQUIRED')
        member=None
        if member_lines or changed:
            if not member_lines or len(after)!=2:fail('SCREENING_ORIGIN_MEMBERSHIP_CAUSAL_PROOF_REQUIRED')
            provenance=rows(session,'SELECT order_id,contract_version,operation_id,proof_hash FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=:id FOR SHARE',{'id':frame.order_id},2)
            # Existing genuine ordinary provenance is retained when present.
            # A missing record remains null, not a manufactured staged-v2 seal.
            saved=None
            if provenance:
                full=one(session,'SELECT * FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=:id FOR SHARE',{'id':frame.order_id})
                record=self.members._decode(full)
                if record['customerId']!=frame.value['customerId'] or not hmac_compare(self.members.proof_hash(record,self.member_key),record['proofHash']):fail()
                saved={'orderId':str(provenance[0]['order_id']),'contract':provenance[0]['contract_version'],
                       'operationId':provenance[0]['operation_id'],'proofHash':provenance[0]['proof_hash']}
            member={'entityHash':digest(self.key,'asset-entity',state['email']),'productIds':[str(value) for value in sorted(self.member_ids)],
                    'lineIds':[line['lineId'] for line in member_lines],'beforeRevision':str(state['revision']),'afterRevision':str(revision_after),
                    'before':state['before'],'after':copy.deepcopy(after),'provenance':saved}
        if not gifts and member is None:return None
        value={'contract':CONTRACT,'commandId':frame.value['id'],'origin':frame.value['origin'],'customerId':frame.value['customerId'],
            'orderId':frame.order_id,'requestHash':frame.value['requestHash'],'cartHash':frame.value['cartHash'],'headerHash':header_hash,
            'lineAssets':line_assets,'gifts':gifts,'membership':member,'sourceCommit':SOURCE,'createdAt':now}
        if len(canonical(value).encode())>250000:fail('SCREENING_ORIGIN_ASSET_PROOF_TOO_LARGE')
        proof=digest(self.key,'assets',value)
        session.execute(text('INSERT INTO pos_rewrite_screening_origin_assets(command_id,order_id,data,proof_hash) VALUES(:id,:order,:data,:proof)'),
                        {'id':frame.value['id'],'order':frame.order_id,'data':canonical(value),'proof':proof})
        return proof


def hmac_compare(left,right):
    import hmac
    return isinstance(left,str) and isinstance(right,str) and hmac.compare_digest(left,right)
