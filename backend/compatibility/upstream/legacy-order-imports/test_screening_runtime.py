"""Actual private selector/ScreeningSourceRuntime wiring; no source or DB I/O."""
import unittest
from types import SimpleNamespace,ModuleType
from protocol import ImportReview
from profiles import assert_plain_profile
from screening_runtime import options,install
from screening_profile import ScreeningSourceRuntime

AUTH='fixture-authentication-key-0123456789'
PROOF='fixture-independent-source-key-0123456789'


def environment():
    return {'POS_LEGACY_IMPORT_SCREENING_CONTRACT':'pos-csv-screening-2960-v1',
        'POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT':'pos-screening-schema-v1',
        'POS_LEGACY_IMPORT_SCREENING_WRITER_CONTRACT':'pos-screening-all-writers-v1',
        'POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED':'0',
        'POS_SCREENING_COUNTER_CONTRACT':'pos-screening-current-counter-v1',
        'POS_SCREENING_COUNTER_PUBLICATION_KEY':'fixture-counter-publication-key-0123456789',
        'POS_SCREENING_ORIGIN_HISTORY_AUDIT_DEFINER':'fixture_audit@%',
        'POS_SCREENING_ORIGIN_HISTORY_DEFINER':'fixture_origin@%',
        'POS_SCREENING_COUNTER_TRIGGER_DEFINER':'fixture_counter@%',
        'POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES':'["root@localhost"]'}


def source(mode):
    # Isolated namespace lets the real wrapper install its exact one-refusal
    # composition without mutating a worker or another test's source globals.
    module=ModuleType('fixture_private_source')
    module.__dict__['assert_plain_profile']=assert_plain_profile
    exec('class Source:\n def __init__(self):self.settings=None\n def order_pipeline(self,*args):return "original-ordinary-order"\n',module.__dict__)
    value=module.Source();value.settings=SimpleNamespace(IS_LINE_ITEM_ENABLED=mode)
    return value


class Selection(unittest.TestCase):
    def test_actual_wrapper_selected_both_source_line_modes(self):
        for mode in (0,1):
            with self.subTest(mode=mode):
                selected=options({**environment(),'POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED':str(mode)},AUTH,PROOF)
                original=source(mode)
                wrapped=install(original,selected,AUTH,PROOF,lambda:1)
                self.assertIsInstance(wrapped,ScreeningSourceRuntime)
                self.assertIs(wrapped.source,original)
                self.assertEqual(wrapped.order_pipeline(None,None,{'lines':[{'productId':'42'}]},None),'original-ordinary-order')
                cart=SimpleNamespace(get=lambda kind:[{'prod_id':390238,'quantity':1}] if kind=='products' else [])
                types=SimpleNamespace(PRODUCTS='products',GIFT_VOUCHERS='gifts',COMPLEMENTARY_PRODUCTS='complementary')
                settings=SimpleNamespace(EXCLUSIVE_PRODUCT={},EXCLUSIVE_UPGRADE_PRODUCT={})
                plan={'kind':'offline','lines':[{'productId':'390238','quantity':1}],'originalTenderAmount':'100.00'}
                with self.assertRaises(ImportReview):assert_plain_profile(cart,types,settings,plan,{'total':100})
                self.assertIsNone(wrapped.base(cart,types,settings,plan,{'total':100}))

    def test_disabled_does_not_read_unused_options_or_wrap_source(self):
        original=object()
        selected=options({'POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED':'invalid','POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES':'invalid'},AUTH,PROOF)
        self.assertIsNone(selected);self.assertIs(install(original,selected,AUTH,PROOF,None),original)

    def test_missing_or_changed_selected_configuration_is_refused(self):
        for changed in ({'POS_LEGACY_IMPORT_SCREENING_SCHEMA_CONTRACT':''},
                        {'POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED':''},
                        {'POS_LEGACY_IMPORT_SCREENING_LINE_ITEMS_ENABLED':'true'},
                        {'POS_SCREENING_COUNTER_PUBLICATION_KEY':PROOF},
                        {'POS_SCREENING_ORIGIN_HISTORY_ADMIN_GRANTEES':'null'},
                        {'POS_SCREENING_COUNTER_TRIGGER_DEFINER':'fixture_audit@%'}):
            with self.subTest(fields=list(changed)):
                with self.assertRaises(ImportReview):options({**environment(),**changed},AUTH,PROOF)

    def test_actual_source_line_mode_must_match_explicit_declaration(self):
        selected=options(environment(),AUTH,PROOF)
        with self.assertRaises(ImportReview):install(source(1),selected,AUTH,PROOF,lambda:1)


if __name__=='__main__':unittest.main()
