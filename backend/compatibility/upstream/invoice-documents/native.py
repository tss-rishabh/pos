"""Identical native MySQL fingerprint as the Node writer-side scope capture."""
import hashlib
import json
from sqlalchemy import text

HEADER_SQL = "@@HEADER_SQL@@"
LINE_SQL = "@@LINE_SQL@@"


def native_snapshot(reader, scope, include_parts=False):
    order_id, store_id = scope["orderId"], scope["storeId"]
    order = reader.execute(text("SELECT CAST(id AS CHAR) AS id,CAST(user_id AS CHAR) AS customer_id,location_type,CAST(location_id AS CHAR) AS location_id,is_split_order,CAST(has_address_id AS CHAR) AS address_id," + HEADER_SQL + " AS native_hash FROM orders WHERE id=:order_id LIMIT 1"), {"order_id": order_id}).mappings().first()
    if not order:
        raise ValueError("Invoice snapshot unavailable")
    mappings = list(reader.execute(text("SELECT CAST(id AS CHAR) AS id,CAST(store_id AS CHAR) AS store_id,CAST(counter_id AS CHAR) AS counter_id,order_invoice FROM order_stores WHERE order_id=:order_id ORDER BY order_stores.id LIMIT 2"), {"order_id": order_id}).mappings())
    lines = list(reader.execute(text("SELECT CAST(id AS CHAR) AS id,CAST(order_platform_id AS CHAR) AS platform_id," + LINE_SQL + " AS native_hash FROM has_products WHERE order_id=:order_id ORDER BY has_products.id LIMIT 10001"), {"order_id": order_id}).mappings())
    express = list(reader.execute(text("SELECT CAST(id AS CHAR) AS id,CAST(has_product_id AS CHAR) AS line_id,CAST(store_id AS CHAR) AS store_id FROM express_line_item WHERE order_id=:order_id ORDER BY express_line_item.id LIMIT 10001"), {"order_id": order_id}).mappings())
    if len(mappings) > 1 or not 0 < len(lines) <= 10000 or len(express) > 10000:
        raise ValueError("Invoice snapshot unavailable")
    parts = [store_id, order_id, str(order["customer_id"]), order["address_id"], order["native_hash"], order["location_type"], order["location_id"], order["is_split_order"] != 0,
             [[str(row["id"]), str(row["store_id"]), str(row["counter_id"]), row["order_invoice"]] for row in mappings],
             [[str(row["id"]), str(row["platform_id"]), row["native_hash"]] for row in lines],
             [[str(row["id"]), str(row["line_id"]), row["store_id"]] for row in express]]
    value = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    result = {"binding": hashlib.sha256(value).hexdigest(), "customerId": str(order["customer_id"])}
    if include_parts:
        result["parts"] = parts
    return result
