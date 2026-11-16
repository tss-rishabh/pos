import ast
from pathlib import Path
import re
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BadRequest(Exception):
    pass


def contract():
    source = (ROOT/'payload/controllers/cart/pos_gift_card_issuance.py').read_text()
    nodes = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)]
    scope = {'re':re,'text':lambda value:value,'falcon':SimpleNamespace(HTTPBadRequest=BadRequest)}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])), '<gift-card-issuance>', 'exec'),scope)
    return scope


class Session:
    def __init__(self, collection=None, existing=None, fail_lines=False):
        self.collection = collection or dict(size=3,is_completed=1,is_block=0,is_printed=1)
        self.existing = existing
        self.fail_lines = fail_lines
        self.calls = []
        self.pending = []
        self.committed = []

    def execute(self, query, parameters):
        self.calls.append((query,parameters))
        result = self.collection if 'gift_card_collection' in query else self.existing
        return SimpleNamespace(mappings=lambda:SimpleNamespace(one_or_none=lambda:result))

    def add(self, value):
        self.pending.append(value)

    def flush(self):
        self.pending[0].id=7001

    def add_all(self, values):
        if self.fail_lines:
            raise RuntimeError('isolated line write failed')
        self.pending.extend(values)

    def commit(self):
        self.calls.append(('COMMIT',{}))
        self.committed.extend(self.pending)
        self.pending=[]

    def rollback(self):
        self.calls.append(('ROLLBACK',{}))
        self.pending=[]


def voucher(**changes):
    return SimpleNamespace(id=None,gv_type='GIFT_CARD',collection_no=1,gift_card_srno=990111,voucher_code='GC-CONTROLLED',voucher_value=1234,to_phone='',**changes)


class GiftCardIssuanceTests(unittest.TestCase):
    def test_collection_and_duplicate_checks_lock_the_writer_before_inserts_and_one_commit(self):
        session=Session()
        card=voucher()
        line=object()
        self.assertEqual(contract()['persist_pos_gift_voucher'](session,card,lambda identifier:[line] if identifier==7001 else []),7001)
        self.assertEqual(session.committed,[card,line])
        self.assertEqual(len([query for query,_ in session.calls if query=='COMMIT']),1)
        self.assertTrue(all('FOR UPDATE' in query for query,_ in session.calls[:2]))
        self.assertEqual(session.calls[0][1],{'collection_id':1})
        self.assertEqual(session.calls[1][1],{'code':'GC-CONTROLLED'})
        self.assertEqual(card.voucher_value,1234)
        self.assertEqual(card.to_phone,0)

    def test_blocked_unprinted_incomplete_and_anomalous_flags_never_insert(self):
        base=dict(size=3,is_completed=1,is_block=0,is_printed=1)
        for changed in [dict(is_block=1),dict(is_block=2),dict(is_printed=0),dict(is_printed=2),dict(is_completed=0),dict(size=0)]:
            with self.subTest(changed=changed):
                session=Session(collection={**base,**changed})
                with self.assertRaises(BadRequest):
                    contract()['persist_pos_gift_voucher'](session,voucher(),lambda identifier:[object()])
                self.assertEqual(session.committed,[])
                self.assertEqual(session.pending,[])

    def test_duplicate_code_never_overwrites_an_existing_or_cancelled_order_card(self):
        session=Session(existing={'id':9001})
        with self.assertRaises(BadRequest):
            contract()['persist_pos_gift_voucher'](session,voucher(),lambda identifier:[object()])
        self.assertEqual(session.committed,[])
        self.assertEqual(session.calls[-1][0],'ROLLBACK')

    def test_line_write_or_missing_line_rolls_back_the_created_voucher(self):
        for session,lines in [(Session(fail_lines=True),[object()]),(Session(),[])]:
            with self.subTest(missing=not lines):
                with self.assertRaises(Exception):
                    contract()['persist_pos_gift_voucher'](session,voucher(),lambda identifier:lines)
                self.assertEqual(session.committed,[])
                self.assertEqual(session.pending,[])
                self.assertEqual(session.calls[-1][0],'ROLLBACK')

    def test_serial_structure_and_collection_cannot_be_forged(self):
        for serial in [0,1,123456,990101,9901112,9223372036854775808,'99011x','0990111']:
            with self.subTest(serial=serial):
                card=voucher();card.gift_card_srno=serial
                with self.assertRaises(BadRequest):
                    contract()['persist_pos_gift_voucher'](Session(),card,lambda identifier:[object()])


if __name__=='__main__':
    unittest.main()
