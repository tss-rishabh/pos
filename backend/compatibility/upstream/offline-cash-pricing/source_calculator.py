"""Execute the pinned source price/tax method without importing application startup.

This is a price-only projection for anonymous plain cash. Unused loyalty display
metrics and network/cache reads cannot affect its payable/tax fields. Hydration,
pricelists and authoritative configuration remain server-owned dependencies.
"""

from __future__ import annotations

import ast
import copy
import enum
import hashlib
import json
import math
import re
import warnings
from decimal import ROUND_DOWN, Decimal
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace

SOURCE_COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"
CALCULATOR_SHA256 = "8752c59ec48f9cde7c74d3016f4cf93b48cb38b746cdcf9ace3c05623e247f77"
HELPER_SHA256 = "4070e7da46499c8041c6831777b0403b2ffbf9d30911551da2da9ef0575b7766"


class PricingError(Exception):
    def __init__(self, code: str, status: int = 409):
        super().__init__(code)
        self.code = code
        self.status = status


class ItemTypes(enum.Enum):
    PRODUCTS = {"name": "products"}
    META = {"name": "meta"}
    WIDGETS = {"name": "widgets"}
    GIFT_VOUCHERS = {"name": "giftvouchers"}


class SilentLogger:
    def debug(self, *_args, **_kwargs):
        pass

    info = warning = error = exception = debug


class ReadOnlyCashCache:
    """Cash never adds COD charges; no cache miss may perform a network write."""

    def exists(self, key):
        if key != "COD_CHARGES":
            raise PricingError("SOURCE_NONCASH_DEPENDENCY")
        return True

    def get(self, key):
        if key != "COD_CHARGES":
            raise PricingError("SOURCE_NONCASH_DEPENDENCY")
        return b"0"


class PlainCashCart:
    def __init__(self, products, session):
        self.products = copy.deepcopy(products)
        self.meta = {
            "payment_details": {"name": "payment_details", "payment_method": "cash"}
        }
        self.context = {"session": session, "user": None, "cart": self}
        self.is_express = self.is_split_order = self.is_hyperlocal = False
        self.contents = {
            "products": SimpleNamespace(get_key=lambda item: str(item["prod_id"]))
        }

    def get(self, kind):
        if kind is ItemTypes.PRODUCTS:
            return self.products
        if kind is ItemTypes.META:
            return list(self.meta.values())
        return []

    def get_item(self, kind, selector):
        if kind is ItemTypes.META:
            return self.meta.get(selector.get("name"))
        if kind is ItemTypes.PRODUCTS:
            return next(
                (
                    item
                    for item in self.products
                    if all(item.get(key) == value for key, value in selector.items())
                ),
                None,
            )
        return None

    def update(self, value):
        if value.get("type") != "meta" or "name" not in value.get("data", {}):
            raise PricingError("SOURCE_NONCASH_MUTATION")
        self.meta[value["data"]["name"]] = dict(value["data"])

    def reset(self, kind):
        if kind not in (ItemTypes.WIDGETS, ItemTypes.GIFT_VOUCHERS):
            raise PricingError("SOURCE_NONCASH_MUTATION")


def minor_units(value):
    amount = Decimal(str(value)) * 100
    if (
        not amount.is_finite()
        or amount != amount.to_integral_value()
        or not 0 <= amount <= 1_000_000_000_000
    ):
        raise PricingError("SOURCE_AMOUNT_UNREPRESENTABLE")
    return int(amount)


def exact_unit_price(value):
    amount = Decimal(str(value))
    if (
        not amount.is_finite()
        or not 0 < amount < 10000000000
        or amount.as_tuple().exponent < -8
    ):
        raise PricingError("SOURCE_UNIT_PRICE_UNREPRESENTABLE")
    return format(amount, "f")


def canonical_hash(value):
    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    ).hexdigest()


@lru_cache(maxsize=16)
def parse_source(contents, path):
    # The pinned helper contains an invalid escape in an unrelated docstring.
    # Keep interpreter warnings out of the closed resource logging channel.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        warnings.simplefilter("ignore", SyntaxWarning)
        return ast.parse(contents, filename=str(path))


def load_calculator(source_root: Path, source_settings, tax_lookup):
    path = source_root / "controllers/cart/wrappers/CalculationsWrapper.py"
    contents = path.read_bytes()
    if hashlib.sha256(contents).hexdigest() != CALCULATOR_SHA256:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    tree = parse_source(contents, path)
    selected = [
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "CalculationsWrapper"
    ]
    if len(selected) != 1:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    settings = SimpleNamespace(**copy.deepcopy(source_settings))
    query_shape = re.compile(
        r"^select id, tax from tax_categories where ([0-9.eE+\-]+) between amt_from and amt_to and \(tax_slab_platform='([^'\\]*)'\)$"
    )

    def fetch_one(_session, query, to_dict=False):
        match = query_shape.fullmatch(query)
        if not match or to_dict is not True:
            raise PricingError("SOURCE_TAX_QUERY_UNSUPPORTED")
        amount = Decimal(match.group(1))
        if not amount.is_finite() or amount < 0:
            raise PricingError("SOURCE_TAX_QUERY_UNSUPPORTED")
        return tax_lookup(amount, match.group(2))

    namespace = {
        "Wrapper": object,
        "ItemTypes": ItemTypes,
        "settings": settings,
        "math": math,
        "Decimal": Decimal,
        "ROUND_DOWN": ROUND_DOWN,
        "json": json,
        "logger": SilentLogger(),
        "fetchOne": fetch_one,
        "APP_DISCOUNT_PERCENT": source_settings["APP_DISCOUNT_PERCENT"],
        "CASHBACK_PERCENT": source_settings["CASHBACK_PERCENT"],
        "TSS_POINT_DISCOUNT_AMOUNT": source_settings["TSS_POINT_DISCOUNT_AMOUNT"],
        "SHIPPING_FREE_PRODUCTS": source_settings["SHIPPING_FREE_PRODUCTS"],
        "get_exclusive_product": lambda _cart: None,
        # These source helpers affect only excluded benefit/display fields for this context.
        "get_exclusive_saving": lambda _session, _item: 0,
        "get_app_cashback_data_status": dict,
        "redis_object": ReadOnlyCashCache(),
    }
    helper_path = source_root / "libs/helper.py"
    helper = helper_path.read_bytes()
    if hashlib.sha256(helper).hexdigest() != HELPER_SHA256:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    helper_tree = parse_source(helper, helper_path)
    rounding = [
        node
        for node in helper_tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "round_down"
    ]
    if len(rounding) != 1:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    exec(
        compile(ast.Module(body=rounding, type_ignores=[]), str(helper_path), "exec"),
        namespace,
    )
    exec(
        compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"),
        namespace,
    )
    return namespace["CalculationsWrapper"]()


def calculate_quantity(calculator, hydrated_product, quantity, session=None):
    from budget import check_deadline

    check_deadline()
    if type(quantity) is not int or not 1 <= quantity <= 99:
        raise PricingError("INVALID_QUANTITY", 400)
    item = copy.deepcopy(hydrated_product)
    # ProductWrapper/PricelistManager already established these source selling prices.
    unit_price = item["spl_price"] if item["spl_price"] > 0 else item["price"]
    item.update(
        quantity=quantity,
        sub_total=unit_price * quantity,
        select=True,
        index_key=str(item["prod_id"]),
    )
    if (
        item.get("print_name")
        or item.get("is_app") == "app"
        or item.get("combo_prod_id")
        or item.get("options")
    ):
        raise PricingError("SOURCE_NONCASH_PRODUCT")
    cart = PlainCashCart([item], session)
    calculator.apply(cart, platform="web", is_pos=True, custom_data={})
    check_deadline()
    result = cart.get_item(ItemTypes.META, {"name": "calculations"})
    product = cart.products[0]
    if not result or any(
        result[key]
        for key in (
            "used_tss_money",
            "used_tss_points",
            "used_store_discount_pg",
            "gift_voucher_value",
            "gift_wrap_amount",
            "shipping_charges",
            "convenience_fee",
            "express_charges",
        )
    ):
        raise PricingError("SOURCE_NONCASH_CALCULATION")
    return {
        "quantity": quantity,
        "unitPrice": exact_unit_price(unit_price),
        "mainSubtotalCents": minor_units(product["main_sub_total"]),
        "taxableCents": minor_units(product["pre_gst_amt"]),
        "taxCents": minor_units(result["gst_total"]),
        "invoiceGst": str(product["invoice_gst"]),
    }
