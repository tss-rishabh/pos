"""Pinned source hydration with bounded, read-only batch queries.

The source initializer and price guard execute unchanged. Only its per-variant
store-stock reads are memoized in one query. Unsupported coupled products fail
the complete snapshot, so an authorization never silently loses a requested SKU.
"""

from __future__ import annotations

import ast
import hashlib
import json
import re
import time
from collections import defaultdict
from types import SimpleNamespace

from source_calculator import ItemTypes, PricingError, SilentLogger, parse_source

INITIALIZER_SHA256 = "e427ef0e6cabaa0fee5f790cf057482f906f7fa4708ce1e10165988d063d9371"
PRICELIST_SHA256 = "86ad9c5335e73d157f2fb49ded98991103d443b254b2777562812f6b6281b127"
WRAPPERS_SHA256 = "53a0555515c6cc728ec71a41ff09d6db9a71d6ef4c58fe937c14c413c8412882"
ORDER_HELPER_SHA256 = "a3ec2d593ddfb990b6462fe4f71a8c70f5aa7b95a6704ffb4a0566b14e515e46"


def checked_tree(source_root, relative, expected):
    path = source_root / relative
    contents = path.read_bytes()
    if hashlib.sha256(contents).hexdigest() != expected:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    return path, parse_source(contents, path)


def reject_coupled(*_args, **_kwargs):
    raise PricingError("SOURCE_PRODUCT_REQUIRES_ONLINE_CHECKOUT")


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows


class SourceProductSession:
    def __init__(self, executor, store_id):
        self.executor = executor
        self.store_id = store_id
        self.product_query = self.variant_query = None
        self.ids = set()
        self.store_stocks = None
        self.failed = False

    def execute(self, statement, parameters):
        if statement not in (self.product_query, self.variant_query):
            raise PricingError("SOURCE_QUERY_UNSUPPORTED")
        try:
            rows = self.executor.select(statement, parameters, limit=25001)
        except Exception:
            self.failed = True
            raise
        if len(rows) > 25000:
            raise PricingError("SOURCE_CATALOG_TOO_LARGE")
        if statement == self.product_query:
            if len(rows) > 1000 or len({int(row["id"]) for row in rows}) != len(rows):
                self.failed = True
                raise PricingError("SOURCE_CATALOG_AMBIGUOUS")
            eligible = []
            for row in rows:
                self.ids.add(int(row["id"]))
                # A bundle would invoke unrelated source helpers during hydration.
                kind = (
                    row["prod_prod_type"]
                    if row["parent_prod_id"] == 0
                    else row["parent_prod_type"]
                )
                if kind in (6, 8):
                    continue
                eligible.append(row)
            rows = eligible
        else:
            self.ids.update(int(row[1]) for row in rows)
        return Rows(rows)

    def stock(self, _session, store_id, product_id):
        if store_id != self.store_id or int(product_id) not in self.ids:
            raise PricingError("SOURCE_STOCK_SCOPE_MISMATCH")
        if self.store_stocks is None:
            rows = self.executor.select(
                "SELECT product_id, stock, is_del, is_avail FROM product_store "
                "WHERE store_id = :store_id AND product_id IN :ids",
                {"store_id": store_id, "ids": tuple(sorted(self.ids))},
                limit=25001,
            )
            self.store_stocks = {}
            for row in rows:
                key = int(row["product_id"])
                if key in self.store_stocks:
                    raise PricingError("SOURCE_STOCK_AMBIGUOUS")
                self.store_stocks[key] = dict(row)
        return self.store_stocks.get(int(product_id))


def hydrate_products(source_root, source_settings, executor, store_id, product_ids):
    source_session = SourceProductSession(executor, store_id)
    sizes = source_settings["SIZE_ATTR"]
    if (
        not isinstance(sizes, list)
        or not sizes
        or len(sizes) > 256
        or any(
            not isinstance(size, str)
            or not re.fullmatch(r"[A-Za-z0-9 .+()/\-]{1,40}", size)
            for size in sizes
        )
    ):
        raise PricingError("SOURCE_SIZE_CONFIGURATION_UNSUPPORTED", 503)
    settings = SimpleNamespace(**source_settings)
    path, tree = checked_tree(
        source_root, "controllers/cart/initializers/initializers.py", INITIALIZER_SHA256
    )
    selected = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name)
            and target.id in {"PRODUCTS_QUERY", "_size_field_list", "VARIANTS_QUERY"}
            for target in node.targets
        ):
            selected.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == "ProductInitializer":
            # Its full batch method runs; unused single-product startup dependencies do not.
            selected.append(node)
    namespace = {
        "Initializer": object,
        "SessionR": source_session,
        "settings": settings,
        "json": json,
        "time": time,
        "defaultdict": defaultdict,
        "logger": SilentLogger(),
        "get_pos_prod_stock": source_session.stock,
        "fetch_bundle_products": reject_coupled,
        "prepare_combo_product": reject_coupled,
        "get_mystery_product_details": reject_coupled,
    }
    exec(
        compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"),
        namespace,
    )
    source_session.product_query = namespace["PRODUCTS_QUERY"]
    source_session.variant_query = namespace["VARIANTS_QUERY"]
    items = namespace["ProductInitializer"]().batch_initialize(
        {"session": source_session, "user": None, "is_pos": True, "store_id": store_id},
        [{"prod_id": int(product_id), "quantity": 1} for product_id in product_ids],
    )
    if source_session.failed:
        raise PricingError("SOURCE_CATALOG_UNAVAILABLE", 503)
    # Anonymous cash excludes membership, customization and basket-coupled rules.
    excluded_ids = {
        int(key)
        for name in ("EXCLUSIVE_PRODUCT", "EXCLUSIVE_UPGRADE_PRODUCT")
        for key in source_settings[name]
    }
    _, order_tree = checked_tree(
        source_root, "libs/OrderHelper.py", ORDER_HELPER_SHA256
    )
    screening = [
        node.value.value
        for node in order_tree.body
        if isinstance(node, ast.Assign)
        and isinstance(node.value, ast.Constant)
        and any(
            isinstance(target, ast.Name) and target.id == "SCREENING_TICKET_SKU"
            for target in node.targets
        )
    ]
    if len(screening) != 1 or type(screening[0]) is not int:
        raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
    excluded_ids.add(screening[0])
    eligible = []
    for item in items:
        if (
            item["prod_id"] in excluded_ids
            or item.get("is_mystery_product")
            or item.get("combo_type")
            or item.get("is_printable")
            or item.get("artist_slug")
            in source_settings["SINGLE_PRODUCT_ALLOWED_ARTIST"]
        ):
            continue
        association = source_session.stock(source_session, store_id, item["prod_id"])
        if (
            not association
            or association["is_del"] != 0
            or association["is_avail"] != 1
        ):
            continue
        stock = association["stock"]
        if type(stock) is not int or not 0 <= stock <= 1000000:
            raise PricingError("SOURCE_STOCK_UNREPRESENTABLE")
        item["stock"] = stock
        eligible.append(item)

    price_path, price_tree = checked_tree(
        source_root, "controllers/priceList/PricelistManager.py", PRICELIST_SHA256
    )
    selected_prices = [
        node
        for node in price_tree.body
        if isinstance(node, ast.ClassDef)
        and node.name in {"PriceGuard", "PricelistManager"}
    ]
    price_namespace = {"ItemTypes": ItemTypes, "settings": settings}
    exec(
        compile(
            ast.Module(body=selected_prices, type_ignores=[]), str(price_path), "exec"
        ),
        price_namespace,
    )
    # The source constructor's unused listing/cache lookup does not participate in
    # update_cart_products. Empty anonymous pricelists never call apply_pricelist.
    manager = price_namespace["PricelistManager"].__new__(
        price_namespace["PricelistManager"]
    )
    manager.context = {"session": source_session}
    manager.price_lists, manager.strict = [], False
    manager.update_cart_products(eligible, is_pos=True, custom_data={})
    checked_tree(source_root, "controllers/cart/wrappers/Wrappers.py", WRAPPERS_SHA256)
    if not eligible:
        raise PricingError("NO_ELIGIBLE_OFFLINE_PRODUCTS")
    included = {str(item["prod_id"]) for item in eligible}
    return eligible, [
        product_id for product_id in product_ids if product_id not in included
    ]
