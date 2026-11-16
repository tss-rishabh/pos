"""Private, stateless snapshot projection; no cart, order, payment or cache writes."""

from __future__ import annotations

import copy
import json
import math
from decimal import Decimal

from source_calculator import (
    SOURCE_COMMIT,
    PricingError,
    calculate_quantity,
    canonical_hash,
    load_calculator,
)
from source_products import hydrate_products

CONTRACT = "pos-offline-cash-prices-v1"
TAX_SQL = (
    "SELECT q.row_id, t.id, t.tax FROM JSON_TABLE(:prices, '$[*]' COLUMNS("
    "row_id INT PATH '$.key', amount DECIMAL(38,18) PATH '$.amount', "
    "platform VARCHAR(2) CHARACTER SET latin1 COLLATE latin1_swedish_ci PATH '$.platform')) q "
    "LEFT JOIN tax_categories t ON q.amount BETWEEN t.amt_from AND t.amt_to "
    "AND t.tax_slab_platform = q.platform"
)
SETTINGS = (
    "SIZE_ATTR",
    "IS_LINE_ITEM_ENABLED",
    "IS_DYNAMIC_GST_ENABLED",
    "DYNAMIC_GST_THRESHOLD",
    "DYNAMIC_GST_VALUE_ABOVE_THRESHOLD",
    "DYNAMIC_GST_VALUE_BELOW_THRESHOLD",
    "EXCLUDE_CATEGORY_FOR_DYNAMIC_GST",
    "SINGLE_PRODUCT_ALLOWED_ARTIST",
    "EXCLUSIVE_PRODUCT",
    "EXCLUSIVE_UPGRADE_PRODUCT",
    "EXCLUSIVE_PRICELISTS",
    "APP_DISCOUNT_PERCENT",
    "CASHBACK_PERCENT",
    "TSS_POINT_DISCOUNT_AMOUNT",
    "SHIPPING_FREE_PRODUCTS",
)


def freeze_settings(settings):
    result = {name: copy.deepcopy(getattr(settings, name)) for name in SETTINGS}
    if type(result["IS_LINE_ITEM_ENABLED"]) is not int or result[
        "IS_LINE_ITEM_ENABLED"
    ] not in (0, 1):
        raise PricingError("SOURCE_CONFIGURATION_UNSUPPORTED", 503)
    if type(result["IS_DYNAMIC_GST_ENABLED"]) is not int or result[
        "IS_DYNAMIC_GST_ENABLED"
    ] not in (0, 1):
        raise PricingError("SOURCE_CONFIGURATION_UNSUPPORTED", 503)
    for name in (
        "DYNAMIC_GST_THRESHOLD",
        "DYNAMIC_GST_VALUE_ABOVE_THRESHOLD",
        "DYNAMIC_GST_VALUE_BELOW_THRESHOLD",
    ):
        value = result[name]
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= 1000000
        ):
            raise PricingError("SOURCE_CONFIGURATION_UNSUPPORTED", 503)
    # This also rejects non-finite/unsupported values before they can enter a grant.
    canonical_hash(result)
    return result


def tax_key(amount, platform):
    return (format(Decimal(str(amount)), "f"), platform)


def build_snapshot(source_root, settings, executor, request):
    store_id = int(request["storeId"])
    stores = executor.select(
        "SELECT id, location_code, is_active FROM stores WHERE id = :store_id",
        {"store_id": store_id},
        limit=2,
    )
    counters = executor.select(
        "SELECT id FROM store_counters WHERE id = :counter_id AND store_id = :store_id AND is_active = 1",
        {"counter_id": int(request["counterId"]), "store_id": store_id},
        limit=2,
    )
    if len(stores) != 1 or len(counters) != 1 or stores[0]["is_active"] != 1:
        raise PricingError("SOURCE_STORE_NOT_AVAILABLE")
    products, excluded = hydrate_products(
        source_root, settings, executor, store_id, request["productIds"]
    )
    metadata = executor.select(
        "SELECT a.id, (SELECT gs.gtin FROM products_gs1 gs WHERE gs.product_id = a.id ORDER BY gs.id LIMIT 1) AS barcode, "
        "(SELECT c.hsn_code FROM has_categories hc JOIN categories c ON c.id = hc.cat_id "
        "WHERE hc.prod_id = IFNULL(NULLIF(a.parent_prod_id, 0), a.id) ORDER BY hc.id LIMIT 1) AS hsn "
        "FROM products a WHERE a.id IN :ids",
        {"ids": tuple(int(product["prod_id"]) for product in products)},
        limit=1001,
    )
    metadata_by_id = {int(row["id"]): row for row in metadata}
    if len(metadata_by_id) != len(products):
        raise PricingError("SOURCE_PRODUCT_METADATA_MISSING")
    tax_requests = {}
    for product in products:
        platform = product["tax_slab_platform"]
        if platform:
            if not isinstance(platform, str) or platform not in (
                "TA",
                "TB",
                "TC",
                "TD",
            ):
                raise PricingError("SOURCE_TAX_PLATFORM_UNSUPPORTED")
            unit_price = (
                product["spl_price"] if product["spl_price"] > 0 else product["price"]
            )
            for quantity in request["quantities"]:
                key = tax_key(unit_price * quantity, platform)
                if key not in tax_requests:
                    tax_requests[key] = {
                        "key": len(tax_requests),
                        "amount": key[0],
                        "platform": platform,
                    }
    # Decimal JSON_TABLE values reproduce the source numeric SQL literals. MySQL
    # performs the FLOAT slab comparisons and collation, never a JS/Python guess.
    tax_rows = []
    if tax_requests:
        tax_rows = executor.select(
            TAX_SQL,
            {
                "prices": json.dumps(
                    list(tax_requests.values()), separators=(",", ":"), allow_nan=False
                )
            },
            limit=len(tax_requests) + 1,
        )
    tax_by_id = {}
    for row in tax_rows:
        key = int(row["row_id"])
        if key in tax_by_id:
            raise PricingError("SOURCE_TAX_SLAB_AMBIGUOUS")
        tax_by_id[key] = (
            {} if row["id"] is None else {"id": row["id"], "tax": float(row["tax"])}
        )
    if len(tax_by_id) != len(tax_requests):
        raise PricingError("SOURCE_TAX_SNAPSHOT_INCOMPLETE")

    def lookup(amount, platform):
        key = tax_key(amount, platform)
        if key not in tax_requests:
            raise PricingError("SOURCE_TAX_SNAPSHOT_INCOMPLETE")
        return tax_by_id[tax_requests[key]["key"]]

    calculator = load_calculator(source_root, settings, lookup)
    output = []
    for product in products:
        extra = metadata_by_id[int(product["prod_id"])]
        name = product["product"]
        barcode = "" if extra["barcode"] is None else str(extra["barcode"])
        hsn = "" if extra["hsn"] is None else str(extra["hsn"])
        if not isinstance(name, str) or not 1 <= len(name) <= 255:
            raise PricingError("SOURCE_PRODUCT_NAME_UNREPRESENTABLE")
        if len(barcode) > 128:
            raise PricingError("SOURCE_BARCODE_UNREPRESENTABLE")
        if len(hsn) > 32:
            raise PricingError("SOURCE_HSN_UNREPRESENTABLE")
        output.append(
            {
                "productId": str(product["prod_id"]),
                "name": name,
                "barcode": barcode,
                "hsn": hsn,
                "cachedStock": product["stock"],
                "quantities": [
                    calculate_quantity(calculator, product, quantity)
                    for quantity in request["quantities"]
                ],
            }
        )
    return {
        "version": 1,
        "id": request["snapshotId"],
        "storeId": request["storeId"],
        "counterId": request["counterId"],
        "businessDate": request["businessDate"],
        "issuedAt": request["issuedAt"],
        "expiresAt": request["expiresAt"],
        "sourceContract": CONTRACT,
        "sourceCommit": SOURCE_COMMIT,
        "sourceSettingsHash": canonical_hash(
            {
                "settings": settings,
                "tax": sorted(
                    [
                        {
                            "amount": key[0],
                            "platform": key[1],
                            "result": tax_by_id[value["key"]],
                        }
                        for key, value in tax_requests.items()
                    ],
                    key=lambda row: (row["platform"], row["amount"]),
                ),
            }
        ),
        "locationSettingsHash": canonical_hash(
            {
                "storeId": request["storeId"],
                "counterId": request["counterId"],
                "locationCode": stores[0]["location_code"],
                "anonymousPricelists": [],
            }
        ),
        "lineItemsEnabled": bool(settings["IS_LINE_ITEM_ENABLED"]),
        "excludedProductIds": excluded,
        "products": output,
    }
