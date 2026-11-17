import json
import unittest
from pathlib import Path
from decimal import Decimal
from prepare import output


class OriginalTender(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.values=json.loads(output())
    def test_all_twenty_source_vectors_are_readonly_reproducible(self):
        self.assertEqual(len(self.values['vectors']),20)
        self.assertEqual(output(),(Path(__file__).parent/'source-vectors.json').read_text())
    def test_every_original_csv_branch_records_no_change_and_its_actual_tender(self):
        for row in self.values['vectors']:
            with self.subTest(vector=row['id'],payment=row['payment']):
                original=row['originalCsv']
                self.assertEqual(original['cashReceived'],original['cash'])
                self.assertEqual(Decimal(str(original['cash']))+Decimal(str(original['manualOther'])),Decimal(original['rawTender']))
                self.assertEqual(original['date'],'2026-06-15 12:00:00')
    def test_tax_rounding_and_discount_are_not_a_tender_difference_formula(self):
        row=next(row for row in self.values['vectors'] if row['id']=='birthday-fraction' and row['payment']=='cash')
        calc=row['calculations']
        self.assertEqual((calc['total'],calc['rounding_off'],calc['coupon_discount']),(45,0.89,5.1))
        self.assertEqual(Decimal(row['originalCsv']['rawTender'])-Decimal(calc['total']),Decimal('5.98'))
        self.assertEqual(Decimal(str(calc['rounding_off']))+Decimal(str(calc['coupon_discount'])),Decimal('5.99'))
    def test_normalized_plan_does_not_prove_the_original_float_addition_sequence(self):
        value=self.values['aggregationCounterexample']
        self.assertEqual(value['originalRaw'],'2.0');self.assertEqual(value['groupedRaw'],'1.9999999999999998')
        self.assertNotEqual(value['originalRaw'],value['groupedRaw'])


if __name__=='__main__':unittest.main()
