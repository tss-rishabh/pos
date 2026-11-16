"""Transient source constructor, signature and private-resource regression checks."""

from __future__ import annotations

import base64
import io
import json
import sys
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from pricing_service import build_snapshot, freeze_settings
from source_calculator import PricingError, canonical_hash
from source_template import (
    RECEIPT_SQL,
    build_template,
    canonical_bytes,
    physical_values,
    source_models,
)
from template_app import PATH, create_template_app
from test_source_pricing import KEY, NOW, ROOT, SETTINGS, Executor, request


def jwk(private):
    raw = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": base64.urlsafe_b64encode(raw).decode().rstrip("="),
    }


def signature(private, value):
    return (
        base64.urlsafe_b64encode(private.sign(canonical_bytes(value)))
        .decode()
        .rstrip("=")
    )


class CashExecutor:
    def __init__(self, line_items=True, quantities=(3, 1)):
        self.queries = []
        self.approvals = []
        self.categories = {}
        self.settings = SimpleNamespace(
            **{**vars(SETTINGS), "EXCLUSIVE_PRICELISTS": [1]}
        )
        snapshot = build_snapshot(
            ROOT, freeze_settings(self.settings), Executor(), request()
        )
        snapshot["lineItemsEnabled"] = line_items
        self.server, self.device = (
            Ed25519PrivateKey.generate(),
            Ed25519PrivateKey.generate(),
        )
        self.server_key, device_key = jwk(self.server), jwk(self.device)
        authorization_id = "9c4f516f-dfd4-4f3e-801e-3dc766c55fdd"
        self.grant = {
            "version": 1,
            "id": authorization_id,
            "deviceId": "5d6322e2-dc6a-4213-81a3-825e6c8f8786",
            "deviceKeyHash": canonical_hash(device_key),
            "operatorId": "7",
            "operatorAuthVersion": "a" * 64,
            "operatorCustomerId": "777",
            "storeId": "1",
            "counterId": "2",
            "businessDate": "2026-11-16",
            "issuedAt": NOW,
            "expiresAt": NOW + 3600000,
            "snapshotId": snapshot["id"],
            "snapshotHash": canonical_hash(snapshot),
            "stockPolicy": "cached-stock-manager",
            "mode": "cash-only",
            "currency": "INR",
            "receiptPrefix": "OC-" + authorization_id.replace("-", "").upper(),
            "receiptCount": 10,
            "maxReceiptUnits": 1000,
            "maxReceiptCents": 1000000,
            "maxTotalCents": 5000000,
        }
        lines = []
        for product, quantity in zip(snapshot["products"], quantities):
            price = next(
                price
                for price in product["quantities"]
                if price["quantity"] == quantity
            )
            lines.append(
                {
                    **price,
                    **{
                        name: product[name]
                        for name in ("productId", "name", "barcode", "hsn")
                    },
                }
            )
        taxable = sum(line["taxableCents"] for line in lines)
        tax = sum(line["taxCents"] for line in lines)
        total = taxable + tax
        self.receipt = {
            "version": 1,
            "id": "03ec1cc8-dbe2-49c7-9467-8103a6074c8e",
            "authorizationId": authorization_id,
            "deviceId": self.grant["deviceId"],
            "operatorId": "7",
            "storeId": "1",
            "counterId": "2",
            "businessDate": "2026-11-16",
            "draftId": "173f4886-45c5-4681-bba6-84e164ae3a99",
            "draftVersion": 1,
            "sequence": 1,
            "receiptNumber": self.grant["receiptPrefix"] + "-0001",
            "completedAt": NOW + 1000,
            "currency": "INR",
            "snapshotId": snapshot["id"],
            "snapshotHash": self.grant["snapshotHash"],
            "stockPolicy": "cached-stock-manager",
            "lines": lines,
            "taxableCents": taxable,
            "taxCents": tax,
            "roundingCents": total % 100,
            "payableCents": total - total % 100,
            "cashReceivedCents": 100000,
            "changeCents": 100000 - (total - total % 100),
        }
        self.row = {
            "id": self.receipt["id"],
            "authorization_id": authorization_id,
            "operator_id": "7",
            "store_id": "1",
            "counter_id": "2",
            "device_id": self.grant["deviceId"],
            "business_date": "2026-11-16",
            "status": "accepted",
            "version": 1,
            "snapshot_json": json.dumps(snapshot),
            "snapshot_hash": self.grant["snapshotHash"],
            "public_key_json": json.dumps(device_key),
            "key_hash": self.grant["deviceKeyHash"],
            "authorization_json": json.dumps(
                {
                    "authorization": self.grant,
                    "keyId": canonical_hash(self.server_key),
                    "signature": signature(self.server, self.grant),
                }
            ),
        }
        self.resign()

    def resign(self):
        envelope = {
            "receipt": self.receipt,
            "signature": signature(self.device, self.receipt),
        }
        self.row.update(
            receipt_json=json.dumps(envelope),
            request_hash=canonical_hash(envelope),
            completed_at_ms=self.receipt["completedAt"],
            payable_cents=self.receipt["payableCents"],
            cash_received_cents=self.receipt["cashReceivedCents"],
            change_cents=self.receipt["changeCents"],
        )

    def select(self, query, parameters, *, limit):
        self.queries.append((query, parameters))
        if query == RECEIPT_SQL:
            return [self.row] if parameters["receipt_id"] == self.row["id"] else []
        if query.startswith("SELECT public_key_json"):
            return [{"public_key_json": json.dumps(self.server_key)}]
        if query.startswith("SELECT details_json FROM pos_rewrite_offline_cash_events"):
            return self.approvals
        if query.startswith("SELECT p.id,pap.id"):
            return [
                {
                    "id": pid,
                    "parent_id": 100 if pid == 101 else 102,
                    "normal_price": 999,
                    "special_price": 499,
                    "cog": 12.34,
                    "gender_type": 0,
                    "jit_value": "REGULAR",
                    "images_new": '{"male":["fixture-image.jpg"]}',
                    "categories": self.categories.get(pid, ""),
                }
                for pid in (101, 102)
            ]
        if query.startswith("SELECT pl.product_id"):
            return [
                {"product_id": 100, "exclusive_price": 399},
                {"product_id": 102, "exclusive_price": 299},
            ]
        if (
            query
            == "select firstname, lastname, telephone from users where id =:user_id"
        ):
            return [{"firstname": "Fixture", "lastname": "Guest", "telephone": ""}]
        if "FROM\n" in query and "stores AS st" in query:
            return [
                {
                    "store_name": "Fixture store",
                    "address": "Fixture address",
                    "alt_address": "",
                    "phone": "0000000000",
                    "pincode": "000000",
                    "city_name": "Fixture city",
                    "state_name": "Fixture state",
                }
            ]
        raise AssertionError("Unexpected source reference query")

    def template(self):
        return build_template(
            ROOT, freeze_settings(self.settings), self, self.row["id"]
        )


class SourceTemplateTests(unittest.TestCase):
    def test_source_constructors_keep_frozen_prices_and_real_defaults_without_persistence(
        self,
    ):
        executor = CashExecutor()
        result = executor.template()
        self.assertEqual(result["contract"], "pos-offline-cash-template-v1")
        self.assertEqual(result["receiptHash"], executor.row["request_hash"])
        self.assertEqual(len(result["lines"]), 4)
        self.assertEqual(result["header"]["payment_method"], "14")
        self.assertEqual(result["header"]["payment_status"], "0")
        self.assertEqual(result["header"]["order_status"], "0")
        self.assertEqual(result["header"]["order_ref_no"], "")
        self.assertEqual(result["header"]["ship_date"], "")
        self.assertEqual(result["header"]["original_order_id"], "0")
        self.assertEqual(result["header"]["country_id"], "India")
        self.assertNotIn("id", result["header"])
        self.assertEqual(result["orderStore"]["order_id"], "0")
        self.assertEqual(result["orderStore"]["is_offline_order"], "1")
        self.assertEqual(result["orderStore"]["offline_payment"], "0")
        self.assertTrue(all(line["status"] == "INCOMPLETE" for line in result["lines"]))
        self.assertEqual(
            [line["price"] for line in result["lines"][:3]], ["79.125"] * 3
        )
        self.assertEqual(result["lines"][0]["normal_price"], "999.0")
        self.assertEqual(result["lines"][0]["special_price"], "499.0")
        self.assertEqual(result["lines"][0]["images"], "fixture-image.jpg")
        self.assertEqual(len(executor.queries), 6)
        self.assertTrue(
            all(
                query.lstrip().lower().startswith("select ")
                for query, _ in executor.queries
            )
        )

    def test_snapshot_line_mode_overrides_current_settings_without_global_mutation(
        self,
    ):
        executor = CashExecutor(line_items=False)
        self.assertEqual(executor.settings.IS_LINE_ITEM_ENABLED, 1)
        result = executor.template()
        self.assertFalse(result["lineItemsEnabled"])
        self.assertEqual([line["qty"] for line in result["lines"]], ["3", "1"])
        self.assertEqual(result["lines"][0]["price"], "237.375")
        self.assertEqual(executor.settings.IS_LINE_ITEM_ENABLED, 1)
        self.assertEqual(
            sum(Decimal(line["pre_gst_amt"]) for line in result["lines"]),
            Decimal(executor.receipt["taxableCents"]) / 100,
        )

    def test_signed_source_money_and_device_scope_cannot_be_changed(self):
        for mutate in [
            lambda value: value["lines"][0].update(unitPrice="1"),
            lambda value: value.update(storeId="2"),
            lambda value: value.update(payableCents=value["payableCents"] - 100),
            lambda value: value.update(changeCents=0),
        ]:
            executor = CashExecutor()
            mutate(executor.receipt)
            executor.resign()
            with self.assertRaises(PricingError):
                executor.template()
        executor = CashExecutor()
        executor.row["receipt_json"] = executor.row["receipt_json"].replace(
            '"Fixture product"', '"changed"'
        )
        with self.assertRaises(PricingError):
            executor.template()

    def test_clock_conflicts_require_durable_manager_attribution(self):
        for stamp in (NOW - 1000, NOW + 86400000):
            executor = CashExecutor()
            executor.receipt["completedAt"] = stamp
            executor.resign()
            with self.assertRaisesRegex(
                PricingError, "SOURCE_CASH_CLOCK_ATTRIBUTION_REQUIRED"
            ):
                executor.template()

    def test_approved_duplicate_sku_refunds_retain_each_line_allocation(self):
        executor = CashExecutor(quantities=(3, 2))
        result = executor.template()
        self.assertEqual(result["refundAllocationContract"], "pos-refund-per-hp-v1")
        self.assertEqual(
            result["refundSourcePatchHash"],
            "e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11",
        )
        self.assertEqual(result["flagIds"], [19])
        self.assertEqual(
            [Decimal(line["amount_to_be_refunded"]) for line in result["lines"]],
            [
                Decimal(line["amountToBeRefunded"])
                for line in result["refundAllocations"]
            ],
        )
        self.assertEqual(
            sum(Decimal(line["amount_to_be_refunded"]) for line in result["lines"]),
            Decimal(executor.receipt["payableCents"]) / 100,
        )

    def test_source_category_flags_are_retained_without_changing_cash_amounts(self):
        executor = CashExecutor()
        original = executor.template()
        executor.categories = {101: "153", 102: "156,600"}
        result = executor.template()
        self.assertEqual(set(result["flagIds"]), {4, 13, 19})
        self.assertEqual(result["header"]["flag_id"], "19")
        self.assertEqual(result["lines"], original["lines"])
        self.assertEqual(result["refundAllocations"], original["refundAllocations"])

    def test_approved_profile_rejects_unverified_patch_identity(self):
        with patch("source_refunds.REFUND_PATCH_SHA256", "0" * 64):
            with self.assertRaisesRegex(
                PricingError, "SOURCE_REFUND_PROFILE_UNVERIFIED"
            ):
                CashExecutor().template()

    def test_scalar_defaults_match_real_orm_insertion_when_constructor_passes_none(
        self,
    ):
        from sqlalchemy import Column, Integer, create_engine, select
        from sqlalchemy.orm import Session, declarative_base

        source = source_models(ROOT)["OrderModel"]
        fields = ("coupon_used", "voucher_used", "coupon_amt_used", "transaction_id")
        values = physical_values(source(**dict.fromkeys(fields)), "2026-11-16 10:00:00")
        base = declarative_base()
        attributes = {
            "__tablename__": "source_defaults",
            "id": Column(Integer, primary_key=True),
        }
        for name in fields:
            original = source.__table__.columns[name]
            attributes[name] = Column(original.type, default=original.default.arg)
        proof = type("SourceDefaultsProof", (base,), attributes)
        engine = create_engine("sqlite:///:memory:")
        try:
            base.metadata.create_all(engine)
            with Session(engine) as session:
                row = proof(**dict.fromkeys(fields))
                session.add(row)
                session.flush()
                stored = session.execute(select(proof)).scalar_one()
                for name in fields:
                    expected = getattr(stored, name)
                    actual = values[name]
                    if isinstance(expected, (int, float)):
                        self.assertEqual(Decimal(str(expected)), Decimal(actual))
                    else:
                        self.assertEqual(actual, expected)
        finally:
            engine.dispose()

    def test_manager_attribution_is_durable_scoped_and_cannot_rewrite_the_receipt(self):
        executor = CashExecutor()
        executor.receipt["completedAt"] = NOW - 1000
        executor.resign()
        original = executor.receipt["completedAt"]
        attributed = (
            datetime.fromtimestamp((NOW + 10000) / 1000, timezone.utc)
            .astimezone(ZoneInfo("Asia/Kolkata"))
            .strftime("%Y-%m-%d %H:%M:%S")
        )
        approved = {
            "version": 1,
            "receiptHash": executor.row["request_hash"],
            "authorizationId": executor.grant["id"],
            "expectedVersion": 1,
            "orderCreatedAt": attributed,
            "acknowledgedConflicts": ["clock-outside-authorization"],
            "reason": "Fixture clock attribution",
        }
        executor.row["version"] = 2
        executor.approvals = [{"details_json": json.dumps(approved)}]
        self.assertEqual(executor.template()["header"]["created_at"], attributed)
        self.assertEqual(executor.receipt["completedAt"], original)
        for value in [
            {**approved, "orderCreatedAt": "2026-11-15 10:00:00"},
            {**approved, "expectedVersion": 2},
            {**approved, "extra": True},
        ]:
            executor.approvals = [{"details_json": json.dumps(value)}]
            with self.assertRaises(PricingError):
                executor.template()

    def test_changed_source_or_missing_immutable_receipt_fail_closed(self):
        executor = CashExecutor()
        with patch("source_template.MODEL_SHA256", "0" * 64):
            with self.assertRaisesRegex(PricingError, "SOURCE_REVISION_UNVERIFIED"):
                executor.template()
        with self.assertRaisesRegex(PricingError, "SOURCE_CASH_RECEIPT_NOT_VISIBLE"):
            build_template(
                ROOT,
                freeze_settings(executor.settings),
                executor,
                "8500d488-979e-4e73-9024-57cc2b90c117",
            )

    def test_private_template_resource_validates_receipt_only_and_never_logs_constructor_data(
        self,
    ):
        executor, events, entered = CashExecutor(), [], []

        @contextmanager
        def sessions():
            entered.append(True)
            yield executor

        application = create_template_app(
            ROOT, executor.settings, sessions, KEY, emit=events.append
        )
        for payload, key, expected in [
            ({"receiptId": executor.row["id"]}, KEY, 200),
            ({"receiptId": executor.row["id"], "price": "1"}, KEY, 400),
            ({"receiptId": "PII-fixture"}, KEY, 400),
            ({"receiptId": executor.row["id"]}, "bad", 403),
        ]:
            before = len(entered)
            raw = json.dumps(payload).encode()
            statuses = []
            response = b"".join(
                application(
                    {
                        "PATH_INFO": PATH,
                        "QUERY_STRING": "",
                        "REQUEST_METHOD": "POST",
                        "HTTP_X_POS_OFFLINE_KEY": key,
                        "HTTP_X_POS_OPERATOR_ID": "8",
                        "CONTENT_TYPE": "application/json",
                        "CONTENT_LENGTH": str(len(raw)),
                        "wsgi.input": io.BytesIO(raw),
                    },
                    lambda status, _headers, collected=statuses: collected.append(
                        status
                    ),
                )
            )
            self.assertEqual(int(statuses[0][:3]), expected)
            if expected != 200:
                self.assertEqual(before, len(entered))
            self.assertEqual(events[-1]["resource"], "offline-cash-import-template")
            self.assertNotIn("Fixture Guest", json.dumps(events))
            self.assertNotIn("Fixture address", json.dumps(events))
            self.assertNotIn("PII-fixture", json.dumps(events))
            self.assertNotIn(KEY, json.dumps(events))
            self.assertTrue(response)


if __name__ == "__main__":
    if sys.argv[1:] == ["--native-driver-template"]:
        from sqlalchemy import create_engine
        from sqlalchemy.engine import make_url

        from runtime import reader_session

        supplied = json.loads(sys.stdin.readline())
        url = make_url(supplied["url"])
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
        settings = SimpleNamespace(**{**vars(SETTINGS), "EXCLUSIVE_PRICELISTS": [1]})
        try:
            with reader_session(engine) as executor:
                value = build_template(
                    ROOT, freeze_settings(settings), executor, supplied["receiptId"]
                )
            print(json.dumps(value, separators=(",", ":")))
        finally:
            engine.dispose()
    else:
        unittest.main()
