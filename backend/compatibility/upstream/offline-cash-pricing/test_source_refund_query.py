"""Source-executed differential refund SQL oracle; all writes are in-memory SQLite."""

from __future__ import annotations

import ast
import copy
import itertools
import json
import re
import sqlite3
import sys
import tempfile
import unittest
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from types import SimpleNamespace

from source_calculator import PricingError, SilentLogger, parse_source
from source_refunds import CONTROLLER_SHA256, source_refund_projection

PATCHES = Path(__file__).resolve().parent / "patches"
sys.path.insert(0, str(PATCHES))
from refund_query_candidate import (  # noqa: E402
    RELATIVE,
    SOURCE_SHA256,
    CandidateError,
    applied_candidate,
    sha256,
)

ROOT = Path(__file__).resolve().parents[5] / "backend-tss-api_v2"
FUNCTIONS = {
    "_round2",
    "_distribute_amount_to_be_refunded",
    "amount_to_be_refunded_calculation",
}


def header(total):
    return {
        "user_id": 7,
        "pay_amt": float(total),
        "payment_method": 0,
        "coupon_used": 0,
        "coupon_amt_used": 0,
        "voucher_used": 0,
        "voucher_amt_used": 0,
        "tss_money_used": 0,
        "tss_points_used": 0,
        "cod_charges": 0,
        "gifting_charges": 0,
        "shipping_amt": 0,
        "hl_charges": 0,
        "express_charges": 0,
    }


def line(product_id, price, *, hp_id=None, store_discount=0):
    result = {
        "prod_id": product_id,
        "price": float(price),
        "gst": 18,
        "hp_tss_points_used": 0,
        "disc": 0,
        "wallet_disc": 0,
        "voucher_disc": 0,
        "store_disc_pg": float(store_discount),
        "status": "PLACED",
    }
    if hp_id is not None:
        result["id"] = hp_id
    return result


def money(value):
    return format(Decimal(str(value)).quantize(Decimal("0.01")), "f")


class SqlRefundProjection:
    """Execute the literal source SQL locally instead of assigning mocked row values."""

    def __init__(self, raw_header, raw_rows):
        self.header = {**copy.deepcopy(raw_header), "id": 0}
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(
            """
            CREATE TABLE has_products (
              id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,prod_id INTEGER NOT NULL,
              price REAL NOT NULL,gst REAL NOT NULL,hp_tss_points_used REAL NOT NULL,
              disc REAL NOT NULL,wallet_disc REAL NOT NULL,voucher_disc REAL NOT NULL,
              store_disc_pg REAL NOT NULL,status TEXT NOT NULL,
              amount_to_be_refunded REAL,fraction_value INTEGER
            );
            CREATE TABLE amount_to_be_refunded_log (
              order_id INTEGER,prod_id INTEGER,tss_point_used REAL,tss_money_used REAL,
              gift_voucher_amount REAL,coupon_amt_used REAL,amount_to_be_refunded REAL,
              has_product_id INTEGER
            );
            CREATE TABLE order_cancel_message_mapping(message_id TEXT,order_id INTEGER);
            """
        )
        self.ids = []
        self.audit_descriptors = []
        self.updates = []
        columns = [
            "id",
            "order_id",
            "prod_id",
            "price",
            "gst",
            "hp_tss_points_used",
            "disc",
            "wallet_disc",
            "voucher_disc",
            "store_disc_pg",
            "status",
            "amount_to_be_refunded",
            "fraction_value",
        ]
        for index, value in enumerate(raw_rows):
            row = {
                **copy.deepcopy(value),
                "id": value.get("id", index + 1),
                "order_id": 0,
                "amount_to_be_refunded": None,
                "fraction_value": None,
            }
            if type(row["id"]) is not int or row["id"] in self.ids or row["id"] < 1:
                raise ValueError("INVALID_SYNTHETIC_HP_ID")
            self.ids.append(row["id"])
            self.connection.execute(
                "INSERT INTO has_products("
                + ",".join(columns)
                + ") VALUES ("
                + ",".join(":" + key for key in columns)
                + ")",
                row,
            )
        self.foreign_id = max(self.ids) + 1
        self.connection.execute(
            "INSERT INTO has_products VALUES(?,99,?,1,0,0,0,0,0,0,'PLACED',777,9)",
            (self.foreign_id, raw_rows[0]["prod_id"]),
        )

    def fetch_order(self, session, order_id, _user):
        if session is not self or order_id != 0:
            raise AssertionError("SOURCE_ORDER_SCOPE_INVALID")
        return copy.deepcopy(self.header)

    def fetch(self, session, query, to_dict=False):
        if (
            session is not self
            or to_dict is not True
            or " ".join(query.split())
            != (
                "select id, hp_tss_points_used, status, prod_id, price, gst, disc, wallet_disc, "
                "voucher_disc,store_disc_pg from has_products where order_id = 0"
            )
        ):
            raise AssertionError("SOURCE_SELECT_SCOPE_INVALID")
        rows = {row["id"]: dict(row) for row in self.connection.execute(query)}
        # The source SELECT has no ORDER BY. Exercise each legal fixture return order.
        return [rows[hp_id] for hp_id in self.ids]

    @staticmethod
    def fetch_one(*_arguments, **_keywords):
        raise AssertionError("NONCASH_SOURCE_DEPENDENCY")

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        if (
            re.fullmatch(
                r"UPDATE has_products SET amount_to_be_refunded = [0-9.eE+\-]+, "
                r"fraction_value = 0 WHERE order_id = 0 and prod_id = [0-9]+(?: AND id = [0-9]+)?",
                normalized,
            )
            and params is None
        ):
            predicate = normalized.split(" WHERE ", 1)[1]
            matched = [
                row[0]
                for row in self.connection.execute(
                    "SELECT id FROM has_products WHERE " + predicate + " ORDER BY id"
                )
            ]
            self.updates.append(matched)
        elif (
            normalized.startswith("INSERT INTO amount_to_be_refunded_log (") and params
        ):
            self.audit_descriptors.append(copy.deepcopy(params))
        elif (
            not re.fullmatch(
                r'INSERT INTO order_cancel_message_mapping\(message_id, order_id\) VALUES \("[1-4]", 0\);',
                normalized,
            )
            or params is not None
        ):
            raise AssertionError("SOURCE_MUTATION_SCOPE_INVALID")
        self.connection.execute(query, params or {})

    def result(self):
        rows = [
            dict(row)
            for row in self.connection.execute(
                "SELECT * FROM has_products WHERE order_id=0 ORDER BY id"
            )
        ]
        logs = [
            dict(row)
            for row in self.connection.execute(
                "SELECT * FROM amount_to_be_refunded_log ORDER BY has_product_id"
            )
        ]
        by_id = {row["has_product_id"]: row for row in logs}
        stored_total = sum(Decimal(str(row["amount_to_be_refunded"])) for row in rows)
        audit_total = sum(Decimal(str(row["amount_to_be_refunded"])) for row in logs)
        aligned = len(by_id) == len(rows) and all(
            Decimal(str(row["amount_to_be_refunded"]))
            == Decimal(str(by_id[row["id"]]["amount_to_be_refunded"]))
            for row in rows
        )
        nonnegative = all(
            Decimal(str(row["amount_to_be_refunded"])) >= 0 for row in rows
        )
        cancellation = [
            dict(row)
            for row in self.connection.execute(
                "SELECT * FROM order_cancel_message_mapping"
            )
        ]
        foreign = dict(
            self.connection.execute(
                "SELECT * FROM has_products WHERE id=?", (self.foreign_id,)
            ).fetchone()
        )
        return {
            "rows": rows,
            "logs": logs,
            "auditDescriptors": self.audit_descriptors,
            "storedTotal": stored_total,
            "auditTotal": audit_total,
            "aligned": aligned,
            "nonnegative": nonnegative,
            "coherent": aligned
            and nonnegative
            and stored_total == Decimal(str(self.header["pay_amt"])),
            "cancellation": cancellation,
            "updates": self.updates,
            "foreign": foreign,
        }


def project(contents, raw_header, rows):
    tree = parse_source(contents, "verified-refund-controller.py")
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in FUNCTIONS
    ]
    if len(functions) != 3:
        raise AssertionError("SOURCE_REFUND_FUNCTIONS_INVALID")
    projection = SqlRefundProjection(raw_header, rows)
    try:
        namespace = {
            "Decimal": Decimal,
            "ROUND_HALF_UP": ROUND_HALF_UP,
            "fetch_order": projection.fetch_order,
            "fetch": projection.fetch,
            "fetchOne": projection.fetch_one,
            "logger": SilentLogger(),
            "PaymentMethod": SimpleNamespace(COD=SimpleNamespace(value=1)),
        }
        exec(
            compile(
                ast.Module(body=functions, type_ignores=[]),
                "<verified-source-refund>",
                "exec",
            ),
            namespace,
        )
        namespace["amount_to_be_refunded_calculation"](
            projection,
            {"user_id": raw_header["user_id"]},
            0,
            {"convenience_fee": 0},
            [],
            is_pos=True,
            is_new_calculation=3,
        )
        return projection.result()
    finally:
        projection.connection.close()


def successful_vectors():
    vectors = []
    for index, order in enumerate(
        itertools.permutations(
            [
                line(7, 1, hp_id=11),
                line(7, 2, hp_id=22),
            ]
        )
    ):
        vectors.append(("duplicate-permutation-" + str(index), header(3), list(order)))
    for index, order in enumerate(
        itertools.permutations(
            [
                line(7, 1, hp_id=11),
                line(8, 2, hp_id=22),
                line(7, 3, hp_id=33),
                line(8, 4, hp_id=44),
            ]
        )
    ):
        vectors.append(
            ("multiple-groups-permutation-" + str(index), header(10), list(order))
        )
    for target in ["1.00", "1.01", "0.01"]:
        for index, order in enumerate(
            itertools.permutations(
                [
                    line(7, 1, hp_id=11),
                    line(7, 1, hp_id=22),
                    line(7, 1, hp_id=33),
                ]
            )
        ):
            vectors.append(
                ("rounding-" + target + "-" + str(index), header(target), list(order))
            )
    for index, rows in enumerate(
        [
            [line(7, 1), line(8, 2)],
            [line(7, "9.99")],
            [line(7, 1), line(7, 1)],
            [line(7, 1), line(7, 1)],
        ]
    ):
        vectors.append(("unchanged-" + str(index), header([3, 9, 2, 3][index]), rows))
    vectors.extend(
        [
            (
                "fractional-inputs",
                header("2.35"),
                [line(7, "0.10"), line(8, "0.20"), line(7, "0.30")],
            ),
            (
                "unequal-per-hp-store-discount",
                header(190),
                [line(7, 100), line(7, 100, store_discount=10)],
            ),
            (
                "lossless-hp-and-product-ids",
                header(3),
                [
                    line(9007199254740993, 1, hp_id=9007199254740995),
                    line(9007199254740993, 2, hp_id=9007199254740996),
                ],
            ),
        ]
    )
    return vectors


class RefundQueryCandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = applied_candidate(ROOT)
        cls.copy_root, cls.original, cls.corrected, cls.manifest = (
            cls.context.__enter__()
        )

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)

    def assert_corrected(self, raw_header, rows):
        original, corrected = (
            project(self.original, raw_header, rows),
            project(self.corrected, raw_header, rows),
        )
        self.assertTrue(corrected["aligned"])
        self.assertTrue(corrected["coherent"])
        self.assertEqual(corrected["storedTotal"], Decimal(str(raw_header["pay_amt"])))
        self.assertEqual(original["auditTotal"], corrected["auditTotal"])
        self.assertEqual(original["auditDescriptors"], corrected["auditDescriptors"])
        self.assertEqual(original["logs"], corrected["logs"])
        self.assertEqual(original["cancellation"], corrected["cancellation"])
        self.assertTrue(all(len(matched) == 1 for matched in corrected["updates"]))
        self.assertEqual(original["foreign"], corrected["foreign"])
        self.assertEqual(corrected["foreign"]["amount_to_be_refunded"], 777)
        for old, new in zip(original["rows"], corrected["rows"]):
            self.assertEqual(
                {
                    key: value
                    for key, value in old.items()
                    if key != "amount_to_be_refunded"
                },
                {
                    key: value
                    for key, value in new.items()
                    if key != "amount_to_be_refunded"
                },
            )
        return original, corrected

    def test_manifest_and_temporary_dry_apply_preserve_the_source(self):
        self.assertEqual(sha256((ROOT / RELATIVE).read_bytes()), SOURCE_SHA256)
        self.assertEqual(sha256(self.corrected), self.manifest["candidate"]["sha256"])
        self.assertFalse(self.manifest["enabled"])
        self.assertFalse(self.manifest["response_identical"])
        self.assertEqual(CONTROLLER_SHA256, SOURCE_SHA256)

    def test_literal_duplicate_update_overwrites_rows_while_candidate_aligns_to_existing_audit(
        self,
    ):
        raw_header, rows = header(3), [line(7, 1), line(7, 2)]
        original, corrected = self.assert_corrected(raw_header, rows)
        self.assertEqual(
            [money(row["amount_to_be_refunded"]) for row in original["rows"]],
            ["2.00", "2.00"],
        )
        self.assertEqual(
            [money(row["amount_to_be_refunded"]) for row in corrected["rows"]],
            ["1.00", "2.00"],
        )
        self.assertEqual(original["storedTotal"], Decimal(4))
        self.assertFalse(original["coherent"])

    def test_duplicate_and_rounding_permutations_preserve_source_audit_and_fix_per_hp_storage(
        self,
    ):
        vectors = successful_vectors()
        self.assertEqual(len(vectors), 51)
        changed = 0
        for name, raw_header, rows in vectors:
            with self.subTest(name=name):
                original, corrected = self.assert_corrected(raw_header, rows)
                changed += original["rows"] != corrected["rows"]
        self.assertEqual(changed, 47)

    def test_unique_products_and_equal_duplicate_allocations_are_unchanged(self):
        for name, raw_header, rows in successful_vectors():
            if not name.startswith("unchanged-"):
                continue
            with self.subTest(name=name):
                original, corrected = self.assert_corrected(raw_header, rows)
                self.assertEqual(original["rows"], corrected["rows"])
                self.assertTrue(original["coherent"])

    def test_existing_default_provider_continues_to_reject_original_mismatches(self):
        raw_header, rows = header(1), [line(7, 1), line(7, 1), line(7, 1)]
        _, _, _, coherent = source_refund_projection(
            ROOT, raw_header, rows, reject_inconsistent=False
        )
        self.assertFalse(coherent)
        with self.assertRaises(PricingError) as failure:
            source_refund_projection(ROOT, raw_header, rows)
        self.assertEqual(
            failure.exception.code, "SOURCE_REFUND_ALLOCATION_INCONSISTENT"
        )

    def test_candidate_source_is_not_accepted_by_the_unchanged_default_provider(self):
        with self.assertRaises(PricingError) as failure:
            source_refund_projection(self.copy_root, header(1), [line(7, 1)])
        self.assertEqual(failure.exception.code, "SOURCE_REVISION_UNVERIFIED")

    def test_query_fix_does_not_silently_fix_or_accept_negative_remainder_arithmetic(
        self,
    ):
        raw_header, rows = header("0.02"), [line(7, 1) for _ in range(4)]
        candidate = project(self.corrected, raw_header, rows)
        self.assertTrue(candidate["aligned"])
        self.assertEqual(candidate["storedTotal"], Decimal("0.02"))
        self.assertFalse(candidate["nonnegative"])
        self.assertFalse(candidate["coherent"])
        with self.assertRaises(PricingError):
            source_refund_projection(ROOT, raw_header, rows)

    def test_source_drift_fails_before_candidate_application(self):
        with tempfile.TemporaryDirectory(
            prefix="pos-refund-drift-fixture-"
        ) as directory:
            root = Path(directory)
            target = root / RELATIVE
            target.parent.mkdir(parents=True)
            target.write_bytes(self.original + b"\n# synthetic source drift\n")
            with self.assertRaises(CandidateError):
                with applied_candidate(root):
                    self.fail(
                        "An unverified source must not yield an applied candidate."
                    )


def report():
    records = []
    with applied_candidate(ROOT) as (copy_root, original, corrected, manifest):
        for name, raw_header, rows in successful_vectors():
            before, after = (
                project(original, raw_header, rows),
                project(corrected, raw_header, rows),
            )
            records.append(
                {
                    "case": name,
                    "hasProductIds": [str(row["id"]) for row in after["rows"]],
                    "target": money(raw_header["pay_amt"]),
                    "originalStored": [
                        money(row["amount_to_be_refunded"]) for row in before["rows"]
                    ],
                    "candidateStored": [
                        money(row["amount_to_be_refunded"]) for row in after["rows"]
                    ],
                    "audit": [
                        money(row["amount_to_be_refunded"]) for row in after["logs"]
                    ],
                    "originalStoredTotal": money(before["storedTotal"]),
                    "candidateStoredTotal": money(after["storedTotal"]),
                    "changed": before["rows"] != after["rows"],
                    "candidateCoherent": after["coherent"],
                }
            )
        negative = project(corrected, header("0.02"), [line(7, 1) for _ in range(4)])
        guard_results = {}
        for name, source, total, rows in [
            ("originalMismatch", ROOT, 1, [line(7, 1) for _ in range(3)]),
            ("unacceptedCandidateSource", copy_root, 1, [line(7, 1)]),
        ]:
            try:
                source_refund_projection(source, header(total), rows)
            except PricingError as failure:
                guard_results[name] = failure.code
            else:
                raise AssertionError("DEFAULT_GUARD_DID_NOT_REJECT")
        evidence = {
            "sourceSha256": SOURCE_SHA256,
            "candidateSha256": manifest["candidate"]["sha256"],
            "patchSha256": manifest["candidate"]["patch_sha256"],
            "enabled": False,
            "responseIdentical": False,
            "successfulVectors": len(records),
            "changedVectors": sum(row["changed"] for row in records),
            "execution": "Actual extracted source helpers and literal SQL executed only in separate in-memory SQLite databases.",
            "limits": "Plain-cash synthetic inputs; not a MySQL driver/plan test, runtime enablement, live-data backfill or full refund/cancel workflow certification.",
            "defaultGuardObserved": guard_results,
            "additionalNegativeRemainderGuard": {
                "target": "0.02",
                "candidateStored": [
                    money(row["amount_to_be_refunded"]) for row in negative["rows"]
                ],
                "aligned": negative["aligned"],
                "coherent": negative["coherent"],
                "note": "Adversarial helper input, not proof of eligibility as a signed offline cash receipt. The query patch does not change allocator arithmetic.",
            },
            "cases": records,
        }
    return evidence


if __name__ == "__main__":
    if "--report" in sys.argv:
        result = unittest.main(argv=[sys.argv[0], "-q"], exit=False)
        if not result.result.wasSuccessful():
            raise SystemExit(1)
        destination = PATCHES / "refund-query-evidence.json"
        destination.write_text(json.dumps(report(), indent=2, sort_keys=True) + "\n")
        print(
            json.dumps(
                {
                    "module": "offline-cash-refund-query",
                    "resource": "candidate-oracle",
                    "eventId": "candidate-oracle.verified",
                    "report": destination.name,
                    "enabled": False,
                }
            )
        )
    else:
        unittest.main()
