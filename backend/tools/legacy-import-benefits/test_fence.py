"""Native coupon-history escape prevention; no source DB/provider is opened."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from sqlalchemy import create_engine,text
from sqlalchemy.orm import Session

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports'))
sys.path.insert(0,str(ROOT/'compatibility/upstream/legacy-order-imports/benefit-profile'))
from benefit_fence import coupon_history_statement,guard_coupon_history
from benefit_source import BenefitReview
from transaction import private_session,VIOLATION


class Fence(unittest.TestCase):
    def test_literal_usage_monthly_join_and_lot_history_never_reaches_a_native_reader(self):
        statements=(
            'select count(id) from orders where date(created_at)=:day and user_id=:user and coupon_used=:coupon',
            'SELECT COUNT(1) FROM tss.orders o WHERE o.coupon_used=222',
            'SELECT * FROM coupons_users cu LEFT JOIN `orders` o ON cu.user_id=o.user_id AND cu.c_id=o.coupon_used',
            'SELECT count(ocl.id) FROM order_coupon_log ocl JOIN orders o ON ocl.user_id=o.user_id',
            'SELECT count(*) FROM `tss`.`order_coupon_log`',
        )
        calls=[]
        for query in statements:
            with self.subTest(statement=statements.index(query)):
                self.assertTrue(coupon_history_statement(query))
                with self.assertRaises(BenefitReview):
                    with guard_coupon_history(SimpleNamespace(execute=lambda *_a,**_k:calls.append(True))) as current:
                        current.execute(query,{'user':77})
        self.assertEqual(calls,[])
        VIOLATION.set(False)

    def test_current_control_and_exact_financial_reads_are_not_mislabeled(self):
        for query in ('SELECT id FROM orders LIMIT 0','SELECT id FROM order_coupon_log LIMIT 0',
                      'SELECT id FROM orders WHERE id=:id FOR UPDATE',
                      'SELECT id,qty FROM has_products WHERE order_id=:id FOR UPDATE',
                      'SELECT id FROM coupons WHERE id=:id FOR SHARE',
                      'SELECT revision FROM pos_rewrite_coupon_history_heads WHERE id=:id',
                      'SELECT id FROM users WHERE id=:id FOR UPDATE'):
            self.assertFalse(coupon_history_statement(query))

    def test_imported_native_alias_and_swallowed_exception_cannot_bypass_the_guard(self):
        engine=create_engine('sqlite+pysqlite:///:memory:')
        try:
            with Session(engine) as session:
                with self.assertRaises(BenefitReview):
                    with private_session(session):
                        with guard_coupon_history(session):
                            try:session.execute(text('SELECT count(*) FROM orders WHERE coupon_used=:coupon'),{'coupon':222})
                            except Exception:pass
                self.assertFalse(VIOLATION.get())
                # Listener is invocation-local and removed even after refusal.
                self.assertEqual(session.execute(text('SELECT 1')).scalar_one(),1)
        finally:engine.dispose()


if __name__=='__main__':unittest.main()
