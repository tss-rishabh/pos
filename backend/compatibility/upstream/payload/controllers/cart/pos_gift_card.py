"""POS physical-card compatibility. No database, logging or network side effects.

The ordinary online/default denomination path retains its source pricing. POS
custom values pay the exact face amount and retain the source tax calculation.
"""
import re

import falcon


def _details(item):
    value = item.get('custom_data')
    return value if isinstance(value, dict) else {}


def pos_gift_item_id(item):
    value = _details(item).get('pos_gift_id')
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'[1-9]\d{0,18}', value) or int(value) > 9223372036854775807:
        raise falcon.HTTPBadRequest('Invalid physical gift card item identifier.')
    return value


def apply_pos_gift_identity(item, is_pos):
    identifier = pos_gift_item_id(item)
    if identifier is None:
        return item
    if is_pos is not True or item.get('prod_type') != 8:
        raise falcon.HTTPBadRequest('Physical gift card items require POS checkout.')
    if item.get('gv_id') is not None and str(item['gv_id']) != identifier:
        raise falcon.HTTPBadRequest('Physical gift card item identity changed.')
    if type(item.get('quantity', 1)) is not int or item.get('quantity', 1) != 1:
        raise falcon.HTTPBadRequest('Each physical gift card must have quantity one.')
    item['gv_id'] = identifier
    item['quantity'] = 1
    return item


def apply_pos_gift_value(context, item):
    is_pos = bool(context and context.get('is_pos') is True)
    apply_pos_gift_identity(item, is_pos)
    details = _details(item)
    # A client flag never establishes a custom value. The initializer has just
    # loaded the denomination from the database; retain it unless POS supplies
    # the exact, validated original gvprice request.
    item.pop('custom_price', None)
    if 'gvprice' not in details:
        return item
    value = details['gvprice']
    if not is_pos or item.get('prod_type') != 8 or type(value) is not int or not 1 <= value <= 10000:
        raise falcon.HTTPBadRequest('Gift card value must be a POS whole amount from 1 to 10000.')
    if type(item.get('quantity', 1)) is not int or item.get('quantity', 1) != 1:
        raise falcon.HTTPBadRequest('Each physical gift card must have quantity one.')
    item['price'] = float(value)
    item['gvamount'] = float(value)
    item['spl_price'] = 0.0
    item['spl_price_percent'] = 0.0
    item['custom_price'] = True
    return item
