"""Read-only pinned calculator counterexamples; no source app/network imports."""
import sys
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports/tender-profile'))
from source_tender import calculated, csv_calls


class CorrectionInputs(unittest.TestCase):
    def test_fractional_original_prices_require_independently_attested_tender(self):
        vector={'id':'original','lines':[('25.49',2)],'gst':0}
        self.assertEqual(csv_calls(vector)['rawTender'],'50.98')
        self.assertEqual(calculated(vector).meta['calculations']['total'],50)

    def test_permanent_percentage_is_not_fixed_by_copying_payable_to_price_and_reinferring_tender(self):
        original={'id':'percentage','lines':[('100.00',1)],'gst':0,'couponPercent':10}
        changed={**original,'lines':[('90.00',1)]}
        self.assertEqual(calculated(original).meta['calculations']['total'],90)
        self.assertEqual(csv_calls(changed)['rawTender'],'90.0')
        self.assertEqual(calculated(changed).meta['calculations']['total'],81)

    def test_qualified_full_discount_has_zero_payable_and_no_inferred_cash(self):
        vector={'id':'full','lines':[('100.00',1)],'gst':0,'couponPercent':100}
        self.assertEqual(csv_calls(vector)['rawTender'],'100.0')
        self.assertEqual(calculated(vector).meta['calculations']['total'],0)


if __name__=='__main__':unittest.main()
