"""Produce a separately reviewable patch; default verification never writes."""
import argparse
import hashlib
import json

from prepare_patches import ROOT, TARGETS, diff, original, replace_once


def build(write=False):
    initializer_path = 'controllers/cart/initializers/initializers.py'
    initializer_before = original('api-v2', initializer_path)
    initializer = replace_once(initializer_before, 'class GiftVoucherInitializer(Initializer):',
        'from controllers.cart.pos_gift_card import apply_pos_gift_value\n\n\nclass GiftVoucherInitializer(Initializer):')
    initializer = replace_once(initializer,
        "                item['variant'] = db_product['parent_available_size']\n\n                return item\n\n        if 'gv_id' not in item:",
        "                item['variant'] = db_product['parent_available_size']\n\n                return apply_pos_gift_value(context, item)\n\n        if 'gv_id' not in item:")
    cart_path = 'controllers/cart/Cart.py'
    cart_before = original('api-v2', cart_path)
    cart = replace_once(cart_before, 'def gift_voucher_indexer(item):\n',
        "from controllers.cart.pos_gift_card import apply_pos_gift_identity\n\n\ndef gift_voucher_indexer(item):\n    apply_pos_gift_identity(item, item.get('is_pos') is True)\n")
    validator_path = 'controllers/cart/validators/Validators.py'
    validator_before = original('api-v2', validator_path)
    validator = replace_once(validator_before, 'class GiftVoucherValidator(Validator):',
        'from controllers.cart.pos_gift_card import pos_gift_item_id\n\n\nclass GiftVoucherValidator(Validator):')
    validator = replace_once(validator,
        "            for existing_gv in existing_gift_vouchers:\n                if existing_gv.get('prod_id') == item.get('prod_id'):\n                    raise ValidationException('Gift voucher already exists in cart. Only one gift voucher per product is allowed.')",
        """            physical_id = pos_gift_item_id(item) if is_pos else None
            for existing_gv in existing_gift_vouchers:
                if physical_id and str(existing_gv.get('gv_id')) == physical_id:
                    raise ValidationException('This physical gift card item already exists in the cart.')
                if existing_gv.get('prod_id') == item.get('prod_id') and not physical_id:
                    raise ValidationException('Gift voucher already exists in cart. Only one gift voucher per product is allowed.')""")
    order_path = 'controllers/OrderController.py'
    order_before = original('api-v2', order_path)
    order = replace_once(order_before, 'class PosOrder():',
        'from controllers.cart.pos_gift_card_issuance import persist_pos_gift_voucher\n\n\nclass PosOrder():')
    order = replace_once(order, '''            session.add(purchased_gift_voucher)
            session.commit()
            gift_voucher_id=purchased_gift_voucher.id
            logger.debug(f"PosOrder | gift voucher created | order_id={order.id} gv_id={item.get('gv_id')} gift_voucher_id={gift_voucher_id}")
            if item.get('prod_id', None):
                item["image"] = item['images'][0]
                has_products_row = build_has_products_model(order, item, is_exclusive, calc=calc, gift_voucher_id=gift_voucher_id) # id
                # session.add(has_products_row)
                session.add_all(has_products_row)
                session.commit()''', '''            item["image"] = item['images'][0]
            gift_voucher_id = persist_pos_gift_voucher(
                session, purchased_gift_voucher,
                lambda voucher_id: build_has_products_model(
                    order, item, is_exclusive, calc=calc, gift_voucher_id=voucher_id))''')
    filename = 'patches/api-v2-pos-gift-card.patch'
    patch = ''.join([diff(initializer_path, initializer_before, initializer), diff(cart_path, cart_before, cart), diff(validator_path, validator_before, validator), diff(order_path, order_before, order)])
    for name in ['pos_gift_card.py', 'pos_gift_card_issuance.py']:
        patch += diff('controllers/cart/'+name, None, (ROOT/'payload/controllers/cart'/name).read_text())
    manifest = {'contract':'pos-gift-card-v2','issuanceContract':'pos-gift-card-issuance-v1','source':{'commit':TARGETS['api-v2'][1],'repository':str(TARGETS['api-v2'][0])},'patch':filename,'sha256':hashlib.sha256(patch.encode()).hexdigest()}
    artifacts = {ROOT/filename: patch, ROOT/'gift-card-manifest.json': json.dumps(manifest,indent=2)+'\n'}
    for path, content in artifacts.items():
        if write:
            path.write_text(content)
        elif not path.exists() or path.read_text() != content:
            raise RuntimeError('Saved gift-card patch differs from its reviewed inputs')
    return manifest


if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true')
    print(build(write=parser.parse_args().write)['sha256'])
