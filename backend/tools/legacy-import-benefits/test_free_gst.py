"""Execute the pinned missing-key outage and its selected technical correction."""
import copy
from decimal import Decimal,ROUND_DOWN
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

HERE=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(HERE/'compatibility/upstream/legacy-order-imports/benefit-profile'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from source_oracle import ROOT
from benefit_source import compile_functions,qualified_has_products
from source_runtime import SilentLogger


def source(line_items):
    ns={'Session':None,'settings':SimpleNamespace(IS_LINE_ITEM_ENABLED=line_items,EXCLUSIVE_PRICELISTS=[1]),
        'fetchOne':lambda *_a,**_k:{'parent_id':123,'normal_price':17,'special_price':0,'exclusive_price':0,'cog':0},
        'HasProductModel':lambda **kw:kw,'logger':SilentLogger(),'Decimal':Decimal,'ROUND_DOWN':ROUND_DOWN,
        'math':__import__('math')}
    compile_functions(ROOT,'libs/helper.py',{'allocate_amount_per_unit','round_down'},ns)
    compile_functions(ROOT,'libs/OrderHelper.py',{'build_has_products_model'},ns)
    return ns['build_has_products_model']


def order():
    return SimpleNamespace(id=5001,flag_id=18,store_disc_pg=0,tss_points_used=0,
        coupon_used=0,coupon_amt_used=0,cashback_used=0,voucher_used=0,voucher_amt_used=0)


def product():return {'prod_id':123,'quantity':3,'price':17,'spl_price':0,'image':''}


class FreeGst(unittest.TestCase):
    def test_unmodified_aggregate_free_branch_really_raises_the_missing_gst_key(self):
        with self.assertRaises(KeyError) as failure:source(False)(order(),product(),False,is_free=True,calc={})
        self.assertEqual(failure.exception.args,('gst',))

    def test_corrected_literal_aggregate_and_per_unit_rows_retain_existing_price_and_zero_free_gst(self):
        for per_unit in (False,True):
            original=product();before=copy.deepcopy(original)
            rows=qualified_has_products(source(per_unit))(order(),original,False,is_free=True,calc={})
            self.assertEqual(len(rows),1)
            self.assertEqual((rows[0]['qty'],rows[0]['price'],rows[0]['gst'],rows[0]['prod_gst'],rows[0]['type']),
                (1,0 if per_unit else 17,0,0,'FREEBIE'))
            self.assertEqual(original,before)
            if per_unit:
                self.assertEqual(rows,source(True)(order(),product(),False,is_free=True,calc={}))

    def test_supplied_free_gst_and_ordinary_dictionaries_are_never_overwritten_or_copied(self):
        seen=[]
        def original(_order,value,_exclusive,**options):seen.append((value,options));return 'delegated'
        wrapper=qualified_has_products(original)
        ordinary=product();existing={**product(),'gst':0.18}
        self.assertEqual(wrapper(None,ordinary,False,is_free=False),'delegated')
        self.assertIs(seen[-1][0],ordinary);self.assertNotIn('gst',ordinary)
        wrapper(None,existing,False,is_free=True)
        self.assertIs(seen[-1][0],existing);self.assertEqual(existing['gst'],0.18)
        wrapper(None,ordinary,False,is_free=1)
        self.assertIs(seen[-1][0],ordinary)


if __name__=='__main__':unittest.main()
