"""POS physical-card issuance fence; no log, network or cache operations.

The caller owns its writer session. Collection flags, unique voucher creation
and the corresponding line items commit together. An error is propagated after
rollback; a partially created order must be reconciled rather than recreated.
"""
import re

import falcon
from sqlalchemy import text


def _card_parts(serial_no):
    value = str(serial_no)
    if not re.fullmatch(r'[1-9]\d{5,18}', value) or int(value) > 9223372036854775807:
        raise falcon.HTTPBadRequest('Invalid physical gift card.')
    zero = value.find('0')
    before, after = value[:zero], value[zero + 1:]
    if zero < 2 or not before[-2:].startswith('9') or len(after) < 3:
        raise falcon.HTTPBadRequest('Invalid physical gift card.')
    length = int(after[0])
    if length < 1 or len(after) <= length + 1:
        raise falcon.HTTPBadRequest('Invalid physical gift card.')
    index = after[1:-length]
    if not re.fullmatch(r'[1-9]\d*', index):
        raise falcon.HTTPBadRequest('Invalid physical gift card.')
    return int(after[-length:]), int(index)


def _lock_pos_card_collection(session, voucher):
    collection_id, serial_index = _card_parts(voucher.gift_card_srno)
    if voucher.gv_type != 'GIFT_CARD' or int(voucher.collection_no) != collection_id or collection_id < 1:
        raise falcon.HTTPBadRequest('Invalid physical gift card collection.')
    # Same row/lock as the replacement batch block/print command. Never use a
    # replica or release this lock before the voucher and its HP row commit.
    row = session.execute(text('''
        SELECT size,is_completed,is_block,is_printed FROM gift_card_collection
        WHERE id=:collection_id FOR UPDATE
    '''), {'collection_id': collection_id}).mappings().one_or_none()
    if (not row or row['is_completed'] != 1 or row['is_block'] != 0 or row['is_printed'] != 1
            or type(row['size']) is not int or row['size'] < 1 or serial_index > row['size']):
        raise falcon.HTTPBadRequest('Physical gift card collection is unavailable.')
    # voucher_code is physically UNIQUE. The collection lock also serializes
    # same-card attempts before the insert; an old cancelled order does not
    # remove its voucher or permit silently replacing previously funded value.
    existing = session.execute(text('''
        SELECT id FROM gift_vouchers WHERE voucher_code=:code FOR UPDATE
    '''), {'code': voucher.voucher_code}).mappings().one_or_none()
    if existing:
        raise falcon.HTTPBadRequest('Physical gift card already exists.')


def persist_pos_gift_voucher(session, voucher, build_lines):
    try:
        _lock_pos_card_collection(session, voucher)
        # The source constructor supplies '' for an absent recipient, but the
        # verified column is BIGINT NOT NULL and its ORM default is zero.
        # Preserve absence in strict mode without inventing a phone number.
        if voucher.to_phone == '':
            voucher.to_phone = 0
        session.add(voucher)
        session.flush()
        if not voucher.id:
            raise falcon.HTTPBadRequest('Physical gift card creation is unconfirmed.')
        lines = build_lines(voucher.id)
        if not lines:
            raise falcon.HTTPBadRequest('Physical gift card line is missing.')
        session.add_all(lines)
        session.commit()
        return voucher.id
    except Exception:
        session.rollback()
        raise
