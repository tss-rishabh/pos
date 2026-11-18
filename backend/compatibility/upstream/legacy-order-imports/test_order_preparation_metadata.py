"""Closed non-history metadata probes and rollback-only preparation boundary."""
import unittest
from sqlalchemy import create_engine, text, Integer
from sqlalchemy.orm import Session, DeclarativeBase, Mapped, mapped_column
from order_preparation import _preparation_metadata_statement, read_only_source
from protocol import ImportReview
from transaction import VIOLATION
from benefit_fence import coupon_history_statement


class Base(DeclarativeBase):
    pass


class Order(Base):
    __tablename__ = 'orders'
    id: Mapped[int] = mapped_column(Integer, primary_key=True)


class PreparationMetadata(unittest.TestCase):
    def test_exact_readonly_metadata_only(self):
        for statement in (
            'SHOW GRANTS FOR CURRENT_USER()',
            'SELECT 1 FROM `orders` WHERE FALSE',
            'SELECT 1 FROM `pos_rewrite_coupon_history_heads` WHERE FALSE',
            'SHOW CREATE TABLE `orders`',
            'SHOW CREATE TABLE `sys`.`sys_config`',
        ):
            with self.subTest(statement=statement):
                self.assertTrue(_preparation_metadata_statement(statement))
        for statement in (
            "SHOW GRANTS FOR 'other'@'%'", 'SHOW GRANTS',
            'SHOW CREATE TABLE `other_schema`.`orders`',
            'SHOW CREATE TABLE `unknown`', 'SHOW CREATE FUNCTION `untrusted`',
            'SHOW CREATE TABLE `orders`; DELETE FROM orders',
            'SELECT 1 FROM `orders` WHERE FALSE UNION SELECT id FROM orders',
            'SELECT 1 FROM `orders` WHERE TRUE',
            'SELECT COUNT(*) FROM `orders` WHERE FALSE',
            'SELECT 1 FROM `orders` WHERE FALSE; SELECT id FROM orders',
            'SELECT 1 FROM `orders` /* altered */ WHERE FALSE',
            'SELECT 1 FROM `other_schema`.`orders` WHERE FALSE',
        ):
            with self.subTest(statement=statement):
                self.assertFalse(_preparation_metadata_statement(statement))

    def test_coupon_fence_preserves_history_refusal(self):
        for table in ('orders', 'order_coupon_log'):
            self.assertFalse(coupon_history_statement('SELECT 1 FROM `' + table + '` WHERE FALSE'))
        for statement in (
            'SELECT 1 FROM `order_coupon_log` WHERE TRUE',
            'SELECT 1 FROM `order_coupon_log` /* altered */ WHERE FALSE',
            'SELECT 1 FROM `order_coupon_log` JOIN users ON users.id=order_coupon_log.user_id WHERE FALSE',
            'SELECT 1 FROM `order_coupon_log` WHERE FALSE UNION SELECT 1',
            'SELECT 1 FROM `order_coupon_log` WHERE FALSE; SELECT id FROM order_coupon_log',
            'SELECT 1 FROM `other`.`order_coupon_log` WHERE FALSE',
            'SELECT COUNT(*) FROM order_coupon_log',
            'SELECT coupon_used FROM orders',
            'SELECT 1 FROM orders WHERE FALSE UNION SELECT coupon_used FROM orders',
        ):
            with self.subTest(statement=statement):
                self.assertTrue(coupon_history_statement(statement))

    def test_source_history_and_writes_stay_blocked(self):
        engine = create_engine('sqlite://')
        Base.metadata.create_all(engine)
        with engine.begin() as connection:
            connection.execute(text('INSERT INTO orders VALUES(7)'))
        for statement, code in (
            ('SELECT id FROM orders', 'ORDER_IMPORT_PREPARATION_HISTORY_UNQUALIFIED'),
            ('SELECT COUNT(*) FROM orders', 'ORDER_IMPORT_PREPARATION_HISTORY_UNQUALIFIED'),
            ('SELECT 1 UNION SELECT id FROM orders', 'ORDER_IMPORT_PREPARATION_HISTORY_UNQUALIFIED'),
            ('DELETE FROM orders', 'ORDER_IMPORT_PREPARATION_WRITE_BLOCKED'),
            ('UPDATE orders SET id=8', 'ORDER_IMPORT_PREPARATION_WRITE_BLOCKED'),
            ("SHOW GRANTS FOR 'other'@'%'", 'ORDER_IMPORT_PREPARATION_WRITE_BLOCKED'),
            ('SHOW CREATE TABLE unknown', 'ORDER_IMPORT_PREPARATION_WRITE_BLOCKED'),
        ):
            with self.subTest(statement=statement), Session(engine) as session:
                token = VIOLATION.set(False)
                try:
                    with self.assertRaises(ImportReview) as caught:
                        with read_only_source(session):
                            session.execute(text('SELECT 1 FROM `orders` WHERE FALSE')).close()
                            session.execute(text(statement))
                    self.assertEqual(caught.exception.code, code)
                    self.assertTrue(VIOLATION.get())
                finally:
                    session.rollback()
                    VIOLATION.reset(token)
        for action in ('flush', 'commit'):
            with self.subTest(action=action), Session(engine) as session:
                token = VIOLATION.set(False)
                try:
                    with self.assertRaises(ImportReview) as caught:
                        with read_only_source(session):
                            if action == 'flush':
                                session.add(Order(id=9))
                                session.flush()
                            else:
                                session.commit()
                    self.assertEqual(caught.exception.code, 'ORDER_IMPORT_PREPARATION_WRITE_BLOCKED')
                finally:
                    session.rollback()
                    VIOLATION.reset(token)
        with engine.connect() as connection:
            self.assertEqual(connection.execute(text('SELECT id FROM orders')).scalars().all(), [7])
        engine.dispose()


if __name__ == '__main__':
    unittest.main()
