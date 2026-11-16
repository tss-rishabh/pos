"""Project pinned source refunds, with an explicit approved per-line profile.

The original profile remains available for differential evidence. The approved
profile changes only the UPDATE predicate in memory; neither profile runs SQL.
"""

from __future__ import annotations

import ast
import copy
import re
from decimal import ROUND_HALF_UP, Decimal
from types import SimpleNamespace

from patches.refund_query_candidate import (
    CandidateError,
    candidate_bytes,
    verified_manifest,
)
from source_calculator import PricingError, SilentLogger, parse_source
from source_products import checked_tree

CONTROLLER_SHA256 = "821ee475e4e19d0f48c1078e0eaf6dc0f17fbd57506d0e97f125be45b26746ad"
CORRECTED_CONTROLLER_SHA256 = (
    "d8b922d8ddaa5ed4743b51b113bbae344e3853a4f49054f18bb9b1cd8597da18"
)
REFUND_CONTRACT = "pos-refund-per-hp-v1"
REFUND_PATCH_SHA256 = "e156c0c281cf5d846b6ae88cd7824959babe2069ed409ca9dff31b7882945f11"


def refund_tree(source_root, profile):
    path, tree = checked_tree(
        source_root, "controllers/OrderController.py", CONTROLLER_SHA256
    )
    if profile == "source-v1":
        return path, tree
    if profile != REFUND_CONTRACT:
        raise PricingError("SOURCE_REFUND_PROFILE_UNVERIFIED", 503)
    try:
        original = path.read_bytes()
        manifest = verified_manifest(original)
        if (
            manifest["candidate"]["sha256"] != CORRECTED_CONTROLLER_SHA256
            or manifest["candidate"]["patch_sha256"] != REFUND_PATCH_SHA256
        ):
            raise CandidateError("CANDIDATE_MANIFEST_INVALID")
        return path, parse_source(candidate_bytes(original), str(path))
    except (CandidateError, OSError, ValueError, KeyError, TypeError):
        raise PricingError("SOURCE_REFUND_PROFILE_UNVERIFIED", 503) from None


class RefundProjection:
    def __init__(self, header, lines):
        self.header = copy.deepcopy(header)
        self.header["id"] = 0
        self.rows = [
            {**copy.deepcopy(line), "id": index + 1} for index, line in enumerate(lines)
        ]
        self.logs = []
        self.cancellation_message_id = None

    def order(self, session, order_id, _user):
        if session is not self or order_id != 0:
            raise PricingError("SOURCE_REFUND_SCOPE_MISMATCH")
        return copy.deepcopy(self.header)

    def fetch(self, session, query, to_dict=False):
        expected = "select id, hp_tss_points_used, status, prod_id, price, gst, disc, wallet_disc, voucher_disc,store_disc_pg from has_products where order_id = 0"
        if session is not self or query != expected or to_dict is not True:
            raise PricingError("SOURCE_REFUND_QUERY_UNSUPPORTED")
        return copy.deepcopy(self.rows)

    def fetch_one(self, *_args, **_kwargs):
        raise PricingError("SOURCE_NONCASH_REFUND_DEPENDENCY")

    def execute(self, query, params=None):
        normalized = " ".join(query.split())
        update = re.fullmatch(
            r"UPDATE has_products SET amount_to_be_refunded = ([0-9.eE+\-]+), fraction_value = 0 WHERE order_id = 0 and prod_id = ([0-9]+)(?: AND id = ([0-9]+))?",
            normalized,
        )
        if update and params is None:
            amount, product_id = float(update.group(1)), int(update.group(2))
            line_id = int(update.group(3)) if update.group(3) is not None else None
            matched = [
                row
                for row in self.rows
                if row["prod_id"] == product_id
                and (line_id is None or row["id"] == line_id)
            ]
            if not matched:
                raise PricingError("SOURCE_REFUND_SCOPE_MISMATCH")
            for row in matched:
                row["amount_to_be_refunded"], row["fraction_value"] = amount, 0
            return
        if (
            normalized.startswith(
                "INSERT INTO amount_to_be_refunded_log (order_id, prod_id,"
            )
            and params
        ):
            if params["order_id"] != 0 or not 1 <= params["has_product_id"] <= len(
                self.rows
            ):
                raise PricingError("SOURCE_REFUND_SCOPE_MISMATCH")
            self.logs.append(copy.deepcopy(params))
            return
        cancellation = re.fullmatch(
            r'INSERT INTO order_cancel_message_mapping\(message_id, order_id\) VALUES \("([1-4])", 0\);',
            normalized,
        )
        if cancellation and params is None and self.cancellation_message_id is None:
            self.cancellation_message_id = cancellation.group(1)
            return
        raise PricingError("SOURCE_REFUND_MUTATION_UNSUPPORTED")


def source_refund_projection(
    source_root, header, lines, *, reject_inconsistent=True, profile="source-v1"
):
    projection = RefundProjection(header, lines)
    path, tree = refund_tree(source_root, profile)
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name
        in {
            "_round2",
            "_distribute_amount_to_be_refunded",
            "amount_to_be_refunded_calculation",
        }
    ]
    if len(functions) != 3:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    namespace = {
        "Decimal": Decimal,
        "ROUND_HALF_UP": ROUND_HALF_UP,
        "fetch_order": projection.order,
        "fetch": projection.fetch,
        "fetchOne": projection.fetch_one,
        "logger": SilentLogger(),
        "PaymentMethod": SimpleNamespace(COD=SimpleNamespace(value=1)),
    }
    exec(
        compile(ast.Module(body=functions, type_ignores=[]), str(path), "exec"),
        namespace,
    )
    namespace["amount_to_be_refunded_calculation"](
        projection,
        {"user_id": header["user_id"]},
        0,
        {"convenience_fee": 0},
        [],
        is_pos=True,
        is_new_calculation=3,
    )
    if len(projection.logs) != len(lines) or projection.cancellation_message_id != "1":
        raise PricingError("SOURCE_REFUND_EVIDENCE_INCOMPLETE")
    logs = {log["has_product_id"]: log for log in projection.logs}
    if len(logs) != len(lines):
        raise PricingError("SOURCE_REFUND_EVIDENCE_INCOMPLETE")
    total = Decimal(0)
    coherent = True
    for row in projection.rows:
        amount = Decimal(str(row.get("amount_to_be_refunded")))
        logged = Decimal(str(logs[row["id"]]["amount_to_be_refunded"]))
        total += amount
        coherent = (
            coherent
            and amount == logged
            and amount.is_finite()
            and amount >= 0
            and amount * 100 == (amount * 100).to_integral_value()
        )
    coherent = coherent and total == Decimal(str(header["pay_amt"]))
    if reject_inconsistent and not coherent:
        raise PricingError("SOURCE_REFUND_ALLOCATION_INCONSISTENT")
    allocations = [
        {
            "lineIndex": row["id"] - 1,
            **{
                target: format(Decimal(str(logs[row["id"]][source])), "f")
                for target, source in (
                    ("amountToBeRefunded", "amount_to_be_refunded"),
                    ("tssPointsUsed", "tss_point_used"),
                    ("tssMoneyUsed", "tss_money_used"),
                    ("giftVoucherAmount", "gift_voucher_amount"),
                    ("couponAmountUsed", "coupon_amt_used"),
                    ("storeDiscountPg", "store_disc_pg"),
                )
            },
        }
        for row in projection.rows
    ]
    mutated = [
        {key: value for key, value in row.items() if key != "id"}
        for row in projection.rows
    ]
    return mutated, allocations, projection.cancellation_message_id, coherent
