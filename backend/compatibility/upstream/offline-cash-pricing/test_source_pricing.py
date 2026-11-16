"""Source-executed pricing, batching and closed-log resource regression checks."""

from __future__ import annotations

import copy
import io
import json
import random
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import PATH, create_app
from budget import remaining_milliseconds, request_budget
from pricing_service import TAX_SQL, build_snapshot, freeze_settings
from runtime import SourceRow
from source_calculator import (
    ItemTypes,
    PlainCashCart,
    PricingError,
    calculate_quantity,
    load_calculator,
    minor_units,
)

ROOT = Path(__file__).resolve().parents[5] / "backend-tss-api_v2"
NOW = 1794801600000  # 2026-11-16 04:00 UTC, same signed Asia/Kolkata business day.
KEY = "offline-pricing-fixture-key-" * 2
SETTINGS = SimpleNamespace(
    SIZE_ATTR=["S", "M", "L", "OS"],
    IS_LINE_ITEM_ENABLED=1,
    IS_DYNAMIC_GST_ENABLED=0,
    DYNAMIC_GST_THRESHOLD=2625,
    DYNAMIC_GST_VALUE_ABOVE_THRESHOLD=18,
    DYNAMIC_GST_VALUE_BELOW_THRESHOLD=5,
    EXCLUDE_CATEGORY_FOR_DYNAMIC_GST=[99],
    SINGLE_PRODUCT_ALLOWED_ARTIST=["coupled-fixture"],
    EXCLUSIVE_PRODUCT={"900": {}},
    EXCLUSIVE_UPGRADE_PRODUCT={"901": {}},
    EXCLUSIVE_PRICELISTS=[],
    APP_DISCOUNT_PERCENT="0",
    CASHBACK_PERCENT=0,
    TSS_POINT_DISCOUNT_AMOUNT="0",
    SHIPPING_FREE_PRODUCTS=[],
)


def request():
    return {
        "snapshotId": "8500d488-979e-4e73-9024-57cc2b90c117",
        "operatorId": "7",
        "storeId": "1",
        "counterId": "2",
        "productIds": ["101", "102"],
        "quantities": [1, 2, 3, 5, 20],
        "businessDate": "2026-11-16",
        "issuedAt": NOW,
        "expiresAt": NOW + 3600000,
    }


def source_product(product_id=101, price=99.99, special=0, **values):
    return {
        "prod_id": product_id,
        "parent_prod_id": 100,
        "quantity": 1,
        "price": price,
        "spl_price": special,
        "categories": [11, 9],
        "category_id": 11,
        "gst": 0.18,
        "invoice_gst": 18,
        "tax_slab_platform": "TA",
        "added_by": 1,
        "prod_type": 3,
        "extra_price": 0,
        **values,
    }


def database_product(product_id, parent_id, price, special):
    row = {
        "id": product_id,
        "parent_prod_id": parent_id,
        "product": "Fixture product",
        "prod_stock": 100,
        "images": "[]",
        "images_new": None,
        "images_b": None,
        "is_printable": 0,
        "gender_type": 0,
        "url_key": "fixture",
        "categories": "11,9",
        "artist_name": "Fixture Artist",
        "artist_slug": "fixture",
        "is_mystery_product": 0,
        "combo_type": 0,
        "category_name": "Fixture category",
    }
    for prefix in ("prod_", "parent_"):
        row.update(
            {
                prefix + "price": price,
                prefix + "spl_price": special,
                prefix + "spl_price_percent": 0,
                prefix + "is_cod": 1,
                prefix + "jit_value": "REGULAR",
                prefix + "extra_price": 0,
                prefix + "gst": 18,
                prefix + "tax_slab_platform": "TA",
                prefix + "prod_type": 3 if parent_id else 1,
                prefix + "added_by": 1,
            }
        )
    if parent_id:
        row["prod_price"] = (
            1  # Proves the parent price, not the child catalog price, is used.
        )
    return SourceRow(row)


class Executor:
    def __init__(self):
        self.queries = []
        self.products = [
            database_product(101, 100, 99.99, 79.125),
            database_product(102, 0, 300, 400),
        ]
        self.duplicate_tax = False

    def select(self, query, parameters, *, limit):
        self.queries.append((query, copy.deepcopy(parameters)))
        if query.startswith("SELECT id, location_code"):
            return [SourceRow(id=1, location_code="FIX1", is_active=1)]
        if query.startswith("SELECT id FROM store_counters"):
            return [SourceRow(id=2)]
        if "a.id as id" in query:
            return self.products
        if "COALESCE(ho.attr_val" in query:
            return [SourceRow(parent_prod_id=100, id=101, stock=100, size="S")]
        if query.startswith("SELECT product_id, stock"):
            return [
                SourceRow(product_id=pid, stock=50, is_del=0, is_avail=1)
                for pid in (101, 102)
            ]
        if query.startswith("SELECT a.id, (SELECT gs.gtin"):
            return [
                SourceRow(id=pid, barcode=8900000000000 + pid, hsn="61091000")
                for pid in parameters["ids"]
            ]
        if query == TAX_SQL:
            rows = [
                SourceRow(row_id=row["key"], id=1, tax=18)
                for row in json.loads(parameters["prices"])
            ]
            return rows + rows[:1] if self.duplicate_tax else rows
        raise AssertionError("Unexpected projection query")


def snapshot():
    return build_snapshot(ROOT, freeze_settings(SETTINGS), Executor(), request())


class SourcePricingTests(unittest.TestCase):
    def test_one_deadline_covers_source_work_and_is_isolated_between_requests(self):
        tick = [0.0]
        with request_budget(2, clock=lambda: tick[0]):
            self.assertEqual(remaining_milliseconds(), 2000)
            tick[0] = 0.75
            self.assertEqual(remaining_milliseconds(), 1250)
            with request_budget(1, clock=lambda: tick[0]):
                tick[0] = 1.0
                self.assertEqual(remaining_milliseconds(), 750)
            self.assertEqual(remaining_milliseconds(), 1000)
            tick[0] = 2.0
            with self.assertRaisesRegex(PricingError, "SOURCE_DEADLINE_EXCEEDED"):
                build_snapshot(ROOT, freeze_settings(SETTINGS), Executor(), request())
        self.assertEqual(remaining_milliseconds(), 20000)
        self.assertEqual(
            len(
                build_snapshot(ROOT, freeze_settings(SETTINGS), Executor(), request())[
                    "products"
                ]
            ),
            2,
        )

    def test_full_source_hydration_and_rectification_use_seven_batch_reads(self):
        executor = Executor()
        result = build_snapshot(ROOT, freeze_settings(SETTINGS), executor, request())
        self.assertEqual(len(executor.queries), 7)
        self.assertEqual(
            [p["quantities"][0]["unitPrice"] for p in result["products"]],
            ["79.125", "300.0"],
        )
        self.assertEqual([p["cachedStock"] for p in result["products"]], [50, 50])
        self.assertEqual(result["products"][0]["barcode"], "8900000000101")
        self.assertTrue(result["lineItemsEnabled"])
        self.assertTrue(
            all(q.lstrip().startswith("SELECT") for q, _ in executor.queries)
        )

    def test_quantity_tables_preserve_full_source_basket_tax_and_rounding(self):
        settings = freeze_settings(SETTINGS)
        rng = random.Random(1641)
        checks = 0
        for dynamic in (0, 1):
            settings["IS_DYNAMIC_GST_ENABLED"] = dynamic
            calculator = load_calculator(
                ROOT, settings, lambda _amount, _platform: {"id": 1, "tax": 18}
            )
            for _ in range(60):
                products, projected = [], []
                for index in range(rng.randint(1, 18)):
                    price = rng.choice(
                        [0.01, 0.03, 19.995, 79.125, 99.99, 2624.99, 2625, 2625.01]
                    )
                    quantity = rng.randint(1, 20)
                    item = source_product(
                        101 + index, price, categories=rng.choice([[11], [99]])
                    )
                    projected.append(calculate_quantity(calculator, item, quantity))
                    item.update(
                        quantity=quantity,
                        sub_total=price * quantity,
                        select=True,
                        index_key=str(item["prod_id"]),
                    )
                    products.append(item)
                cart = PlainCashCart(products, None)
                calculator.apply(cart, platform="web", is_pos=True, custom_data={})
                actual = cart.get_item(ItemTypes.META, {"name": "calculations"})
                tax = sum(row["taxCents"] for row in projected)
                subtotal = sum(row["taxableCents"] for row in projected)
                self.assertEqual(tax, minor_units(actual["gst_total"]))
                self.assertEqual(subtotal, minor_units(actual["sub_total"]))
                self.assertEqual(
                    (tax + subtotal) // 100 * 100, minor_units(actual["total"])
                )
                self.assertEqual(
                    (tax + subtotal) % 100, minor_units(actual["rounding_off"])
                )
                checks += len(projected)
        self.assertGreater(checks, 900)

    def test_eligibility_is_explicit_and_ambiguous_data_rejects_the_snapshot(self):
        for field, value in [
            ("combo_type", 1),
            ("is_mystery_product", 1),
            ("artist_slug", "coupled-fixture"),
            ("is_printable", 1),
            ("parent_prod_type", 8),
            ("parent_prod_type", 6),
        ]:
            executor = Executor()
            executor.products[0][field] = value
            result = build_snapshot(
                ROOT, freeze_settings(SETTINGS), executor, request()
            )
            self.assertEqual(result["excludedProductIds"], ["101"])
            self.assertEqual(
                [product["productId"] for product in result["products"]], ["102"]
            )
        executor = Executor()
        executor.products[0]["id"] = 390238
        value = request()
        value["productIds"] = ["390238", "102"]
        result = build_snapshot(ROOT, freeze_settings(SETTINGS), executor, value)
        self.assertEqual(result["excludedProductIds"], ["390238"])
        executor = Executor()
        executor.products = []
        with self.assertRaisesRegex(PricingError, "NO_ELIGIBLE_OFFLINE_PRODUCTS"):
            build_snapshot(ROOT, freeze_settings(SETTINGS), executor, request())
        executor = Executor()
        executor.duplicate_tax = True
        with self.assertRaisesRegex(PricingError, "SOURCE_TAX_SLAB_AMBIGUOUS"):
            build_snapshot(ROOT, freeze_settings(SETTINGS), executor, request())

    def call_resource(self, payload=None, **changes):
        events, entered, statuses = [], [], []

        @contextmanager
        def sessions():
            entered.append(True)
            yield Executor()

        resource = create_app(
            ROOT, SETTINGS, sessions, KEY, clock=lambda: NOW, emit=events.append
        )
        body = json.dumps(request() if payload is None else payload).encode()
        environment = {
            "PATH_INFO": PATH,
            "REQUEST_METHOD": "POST",
            "QUERY_STRING": "",
            "HTTP_X_POS_OFFLINE_KEY": KEY,
            "HTTP_X_POS_OPERATOR_ID": "7",
            "CONTENT_TYPE": "application/json",
            "CONTENT_LENGTH": str(len(body)),
            "wsgi.input": io.BytesIO(body),
            **changes,
        }
        response = b"".join(
            resource(
                environment,
                lambda status, headers: statuses.append((status, dict(headers))),
            )
        )
        return statuses[0], json.loads(response), events, entered

    def test_private_resource_validates_before_database_and_has_closed_logs(self):
        status, result, events, entered = self.call_resource()
        self.assertEqual(status[0], "200 OK")
        self.assertEqual(len(entered), 1)
        self.assertEqual(result, snapshot())
        self.assertEqual(status[1]["Cache-Control"], "private, no-store")
        for changes in [
            {"HTTP_X_POS_OFFLINE_KEY": "bad"},
            {"QUERY_STRING": "phone=PII-fixture"},
            {"REQUEST_METHOD": "GET"},
            {"HTTP_X_POS_OPERATOR_ID": "8"},
            {"HTTP_X_POS_OPERATOR_ID": "PII-fixture"},
            {"CONTENT_LENGTH": "999999"},
        ]:
            status, result, events, entered = self.call_resource(**changes)
            self.assertNotEqual(status[0], "200 OK")
            self.assertEqual(entered, [])
            self.assertEqual(
                set(events[0]),
                {
                    "module",
                    "resource",
                    "eventId",
                    "eventInstanceId",
                    "requestId",
                    "userId",
                    "statusCode",
                    "resultCode",
                },
            )
            self.assertNotIn("PII-fixture", json.dumps(events))
            self.assertNotIn(KEY, json.dumps(events))

    def test_signed_window_scope_and_strict_types_reject_before_database(self):
        for key, value in [
            ("quantities", [True]),
            ("quantities", [1, 1]),
            ("productIds", ["101", "101"]),
            ("businessDate", "2026-11-15"),
            ("issuedAt", NOW - 60001),
            ("expiresAt", NOW + 9 * 3600000),
            ("operatorId", "8"),
            ("storeId", "18446744073709551616"),
            ("unexpected", "PII-fixture"),
        ]:
            payload = request()
            payload[key] = value
            status, _, _, entered = self.call_resource(payload)
            self.assertNotEqual(status[0], "200 OK")
            self.assertFalse(entered)

    def test_source_exception_and_changed_source_never_escape(self):
        with patch(
            "app.build_snapshot", side_effect=ValueError("PII-fixture password secret")
        ):
            status, result, events, _ = self.call_resource()
        self.assertEqual(status[0], "503 Service Unavailable")
        self.assertNotIn("PII-fixture", json.dumps([result, events]))
        with patch("source_calculator.CALCULATOR_SHA256", "0" * 64):
            with self.assertRaisesRegex(PricingError, "SOURCE_REVISION_UNVERIFIED"):
                snapshot()


if __name__ == "__main__":
    if sys.argv[1:] == ["--snapshot"]:
        print(json.dumps(snapshot(), separators=(",", ":")))
    elif sys.argv[1:] == ["--tax-plan"]:
        amounts = [
            "0",
            "0.1",
            "0.100000001",
            "0.2",
            "0.200000003",
            "99.99",
            "100",
            "100.00001",
            "2624.99",
            "2625",
            "999999.99",
        ]
        rows = [
            {"key": i, "amount": amount, "platform": platform}
            for i, (platform, amount) in enumerate(
                (p, a) for p in ("TA", "TB", "TC", "TD") for a in amounts
            )
        ]
        print(json.dumps({"query": TAX_SQL, "prices": rows}))
    elif sys.argv[1:] == ["--native-snapshot"]:

        class NativeExecutor:
            def select(self, query, parameters, *, limit):
                print(
                    json.dumps(
                        {
                            "kind": "query",
                            "query": query,
                            "parameters": parameters,
                            "limit": limit,
                        },
                        separators=(",", ":"),
                    ),
                    flush=True,
                )
                reply = json.loads(sys.stdin.readline())
                if set(reply) != {"rows"}:
                    raise RuntimeError("Native fixture rejected projection query")
                integer_columns = {
                    "id",
                    "parent_prod_id",
                    "product_id",
                    "parent_stock",
                    "prod_stock",
                }
                return [
                    SourceRow(
                        {
                            key: int(value)
                            if key in integer_columns and isinstance(value, str)
                            else value
                            for key, value in row.items()
                        }
                    )
                    for row in reply["rows"]
                ]

        print(
            json.dumps(
                {
                    "kind": "snapshot",
                    "value": build_snapshot(
                        ROOT, freeze_settings(SETTINGS), NativeExecutor(), request()
                    ),
                },
                separators=(",", ":"),
            ),
            flush=True,
        )
    elif sys.argv[1:] == ["--native-driver-snapshot"]:
        from sqlalchemy import create_engine, text
        from sqlalchemy.engine import make_url

        from runtime import reader_session

        url = make_url(json.loads(sys.stdin.readline())["url"])
        if (
            url.drivername != "mysql"
            or url.host not in {"127.0.0.1", "localhost"}
            or not url.database.startswith("pos_rewrite_offline_tax_test_")
            or url.query
        ):
            raise ValueError("Only the isolated local pricing fixture is permitted")
        engine = create_engine(
            url.set(drivername="mysql+pymysql"), echo=False, hide_parameters=True
        )
        try:
            with reader_session(engine) as executor:
                result = build_snapshot(
                    ROOT, freeze_settings(SETTINGS), executor, request()
                )
                read_only = executor.connection.execute(
                    text("SELECT @@session.transaction_read_only")
                ).scalar_one()
                try:
                    executor.select("DELETE FROM products", {}, limit=1)
                    raise AssertionError("Write statement was accepted")
                except PricingError as error:
                    if error.code != "SOURCE_QUERY_UNSUPPORTED":
                        raise
            print(
                json.dumps(
                    {"kind": "driver-snapshot", "value": result, "readOnly": read_only},
                    separators=(",", ":"),
                )
            )
        finally:
            engine.dispose()
    else:
        unittest.main()
