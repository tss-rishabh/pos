"""Actual disabled gift issuance bound to its public screening order.

Collection locks precede voucher locks. Funding remains the existing qualified
Go/Node payment transaction; this source staging module cannot invent it.
"""
import importlib.util
from decimal import Decimal,InvalidOperation
from pathlib import Path
from writer_protocol import fail
from native_authority import one,rows

HASH_SQL="LOWER(SHA2(CAST(JSON_OBJECT('voucher_id',gift_vouchers.id,'order_id',gift_vouchers.order_id,'customer_id',gift_vouchers.from_id,'collection_id',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'voucher_code',gift_vouchers.voucher_code,'initial_value',gift_vouchers.voucher_initial_value,'start_date',gift_vouchers.start_date,'end_date',gift_vouchers.end_date) AS CHAR CHARACTER SET utf8mb4),256))"


def helper():
    filename=Path(__file__).resolve().parent.parent/'payload/controllers/cart/pos_gift_card_issuance.py'
    spec=importlib.util.spec_from_file_location('pos_public_gift_issuance',filename)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
    return value


def amount(value):
    try:
        exact=Decimal(str(value))
        if not exact.is_finite() or exact<=0 or exact.quantize(Decimal('.01'))!=exact:raise ValueError()
        return format(exact,'.2f')
    except (ValueError,InvalidOperation):fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')


class PublicGiftProfile:
    def __init__(self):self.helper=helper()

    def admit(self,session,cap,cart,types,payload):
        selected=cart.get(types.GIFT_VOUCHERS)
        if not isinstance(selected,list) or len(selected)>100:fail()
        wires=payload.get('gc_data') or {}
        if not isinstance(wires,dict):fail()
        expected=[];seen=set()
        for item in selected:
            identity=str(item.get('gv_id',''));wire=wires.get(identity)
            if (not identity or identity in seen or not isinstance(wire,dict) or item.get('quantity',1)!=1
                    or not item.get('prod_id') or item.get('prod_type')!=8):fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
            seen.add(identity)
            serial=str(wire.get('gift_card_no',''))
            try:collection,index=self.helper._card_parts(serial)
            except Exception:fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
            expected.append({'productId':str(item['prod_id']),'serial':serial,'collectionId':str(collection),
                             'serialIndex':index,'initialAmount':amount(item['gvamount'])})
        if set(wires)!=seen:fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
        # Stable order across all cards, before the source constructor/insert.
        for collection in sorted({item['collectionId'] for item in expected},key=int):
            native=one(session,'SELECT size,is_completed,is_printed,is_block FROM gift_card_collection WHERE id=:id FOR UPDATE',{'id':collection})
            if (native['is_completed']!=1 or native['is_printed']!=1 or native['is_block']!=0
                    or type(native['size']) is not int or native['size']<1
                    or any(item['serialIndex']>native['size'] for item in expected if item['collectionId']==collection)):
                fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
        return expected

    def constructor(self,original):
        def create(*args,**kwargs):
            voucher=original(*args,**kwargs)
            from source_frame import FRAME
            frame=FRAME.get()
            if frame is None or frame.benefit_state is None:return voucher
            if voucher is None:fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
            self.helper._lock_pos_card_collection(frame.source,voucher)
            if voucher.to_phone=='':voucher.to_phone=0
            return voucher
        return create

    def capture(self,session,cap,order_id,expected):
        actual=rows(session,'SELECT gift_vouchers.id,order_id,from_id,collection_no,gift_card_srno,gv_type,status,'+
                    HASH_SQL+' AS input_hash,voucher_initial_value,voucher_value FROM gift_vouchers WHERE order_id=:id ORDER BY id FOR UPDATE',{'id':order_id},100)
        if len(actual)!=len(expected):fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
        result=[];serials=set()
        for voucher in actual:
            match=[item for item in expected if item['serial']==str(voucher['gift_card_srno'])]
            if (len(match)!=1 or str(voucher['gift_card_srno']) in serials or voucher['gv_type']!='GIFT_CARD' or voucher['status']!=0
                    or str(voucher['from_id'])!=cap['customerId'] or str(voucher['collection_no'])!=match[0]['collectionId']
                    or amount(voucher['voucher_initial_value'])!=match[0]['initialAmount']
                    or amount(voucher['voucher_value'])!=match[0]['initialAmount']):fail('SCREENING_GIFT_ISSUANCE_PROFILE_REQUIRED')
            serials.add(str(voucher['gift_card_srno']))
            lines=rows(session,'SELECT id,prod_id,qty FROM has_products WHERE order_id=:id AND gift_voucher_id=:voucher ORDER BY id LIMIT 2 FOR SHARE',
                       {'id':order_id,'voucher':voucher['id']},2)
            if len(lines)!=1 or lines[0]['qty']!=1 or str(lines[0]['prod_id'])!=match[0]['productId']:fail()
            if rows(session,'SELECT voucher_id FROM pos_rewrite_gift_card_issuances WHERE voucher_id=:id FOR SHARE',{'id':voucher['id']},1):fail()
            result.append({name:match[0][name] for name in ('productId','serial','collectionId','initialAmount')}|
                          {'voucherId':str(voucher['id']),'lineId':str(lines[0]['id']),'inputHash':voucher['input_hash']})
        return result
