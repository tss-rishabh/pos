"""Read-only source model projection for an already accepted immutable cash sale.

No source controller, database session persistence, payment, stock or network
effects execute. The Node importer owns one atomic settlement transaction.
"""

from __future__ import annotations

import ast
import base64
import copy
import datetime
import enum
import json
import math
import re
from decimal import ROUND_DOWN, Decimal
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from budget import check_deadline
from source_calculator import (
    HELPER_SHA256,
    SOURCE_COMMIT,
    ItemTypes,
    PlainCashCart,
    PricingError,
    SilentLogger,
    canonical_hash,
)
from source_products import ORDER_HELPER_SHA256, checked_tree

CONTRACT = "pos-offline-cash-template-v1"
MODEL_SHA256 = "d9ee1cd52546e9d8dce0952e901ecba0d58fe1c1b68d95149781131e1553fca5"
CONFLICTS = {
    "authorization-expired",
    "clock-outside-authorization",
    "authorization-revoked",
    "operator-access-changed",
    "stock-shortage",
    "price-changed",
    "price-snapshot-expired",
    "source-import-unavailable",
    "import-outcome-unknown",
}
MAX_CENTS = 999999999999
RECEIPT_SQL = (
    "SELECT r.id,r.authorization_id,r.operator_id,r.store_id,r.counter_id,r.device_id,"
    "r.business_date,r.completed_at_ms,r.request_hash,r.receipt_json,r.payable_cents,"
    "r.cash_received_cents,r.change_cents,r.status,r.version,a.authorization_json,a.snapshot_json,"
    "a.snapshot_hash,d.public_key_json,d.key_hash FROM pos_rewrite_offline_cash_receipts r "
    "JOIN pos_rewrite_offline_cash_authorizations a ON a.id=r.authorization_id "
    "JOIN pos_rewrite_offline_cash_devices d ON d.id=r.device_id WHERE r.id=:receipt_id "
    "AND OCTET_LENGTH(r.receipt_json)<=256000 AND OCTET_LENGTH(a.authorization_json)<=16000 "
    "AND OCTET_LENGTH(a.snapshot_json)<=8000000 AND OCTET_LENGTH(d.public_key_json)<=2000"
)


def invalid():
    return PricingError("SOURCE_CASH_EVIDENCE_INVALID")


def canonical_bytes(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def integer(value, lower=0, upper=MAX_CENTS):
    if type(value) is not int or not lower <= value <= upper:
        raise invalid()
    return value


def public_key(value):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    if (
        not isinstance(value, dict)
        or set(value) != {"kty", "crv", "x"}
        or value["kty"] != "OKP"
        or value["crv"] != "Ed25519"
        or not isinstance(value["x"], str)
        or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value["x"])
    ):
        raise invalid()
    return Ed25519PublicKey.from_public_bytes(
        base64.urlsafe_b64decode(value["x"] + "=")
    )


def verify_signature(key, value, signature):
    if not isinstance(signature, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{86}", signature
    ):
        raise invalid()
    try:
        public_key(key).verify(
            base64.urlsafe_b64decode(signature + "=="), canonical_bytes(value)
        )
    except Exception:
        raise invalid() from None


def accepted_cash(executor, receipt_id, business_timezone):
    rows = executor.select(RECEIPT_SQL, {"receipt_id": receipt_id}, limit=2)
    if len(rows) != 1:
        raise PricingError("SOURCE_CASH_RECEIPT_NOT_VISIBLE")
    row = rows[0]
    try:
        envelope = json.loads(row["receipt_json"])
        grant_envelope = json.loads(row["authorization_json"])
        snapshot = json.loads(row["snapshot_json"])
        device = json.loads(row["public_key_json"])
        receipt, grant = envelope["receipt"], grant_envelope["authorization"]
        key_id = grant_envelope["keyId"]
        if not re.fullmatch(r"[a-f0-9]{64}", key_id):
            raise invalid()
        keys = executor.select(
            "SELECT public_key_json FROM pos_rewrite_offline_cash_signing_keys WHERE key_id=:key_id "
            "AND OCTET_LENGTH(public_key_json)<=2000",
            {"key_id": key_id},
            limit=2,
        )
        if len(keys) != 1:
            raise invalid()
        server_key = json.loads(keys[0]["public_key_json"])
        if (
            canonical_hash(server_key) != key_id
            or canonical_hash(device) != row["key_hash"]
        ):
            raise invalid()
        verify_signature(server_key, grant, grant_envelope["signature"])
        verify_signature(device, receipt, envelope["signature"])
        if (
            canonical_hash(envelope) != row["request_hash"]
            or canonical_hash(snapshot) != row["snapshot_hash"]
            or row["status"] not in {"accepted", "conflicted", "importing"}
            or receipt["id"] != receipt_id
            or receipt["authorizationId"] != grant["id"]
            or receipt["authorizationId"] != row["authorization_id"]
            or grant["deviceKeyHash"] != row["key_hash"]
            or grant["snapshotHash"] != row["snapshot_hash"]
        ):
            raise invalid()
        for field, column in [
            ("operatorId", "operator_id"),
            ("storeId", "store_id"),
            ("counterId", "counter_id"),
            ("deviceId", "device_id"),
        ]:
            if receipt[field] != grant[field] or receipt[field] != str(row[column]):
                raise invalid()
        if (
            receipt["businessDate"] != grant["businessDate"]
            or receipt["businessDate"] != str(row["business_date"])
            or receipt["snapshotId"] != snapshot["id"]
            or receipt["snapshotId"] != grant["snapshotId"]
            or receipt["snapshotHash"] != row["snapshot_hash"]
            or snapshot["storeId"] != receipt["storeId"]
            or snapshot["counterId"] != receipt["counterId"]
            or snapshot["businessDate"] != receipt["businessDate"]
            or snapshot["sourceContract"] != "pos-offline-cash-prices-v1"
            or snapshot["sourceCommit"] != SOURCE_COMMIT
            or type(snapshot["lineItemsEnabled"]) is not bool
            or receipt["currency"] != "INR"
            or grant["currency"] != "INR"
            or receipt["stockPolicy"] != "cached-stock-manager"
            or grant["mode"] != "cash-only"
        ):
            raise invalid()
        if (
            receipt["completedAt"] != int(row["completed_at_ms"])
            or receipt["payableCents"] != int(row["payable_cents"])
            or receipt["cashReceivedCents"] != int(row["cash_received_cents"])
            or receipt["changeCents"] != int(row["change_cents"])
        ):
            raise invalid()
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise invalid() from None
    return verify_cash_amounts(
        executor, row, grant, snapshot, receipt, business_timezone
    )


def attributed_cash_time(executor, row, grant, receipt, business_zone):
    events = executor.select(
        "SELECT details_json FROM pos_rewrite_offline_cash_events WHERE receipt_id=:receipt_id "
        "AND kind='import-approved' AND OCTET_LENGTH(details_json)<=4000 "
        "ORDER BY created_at_ms DESC,id DESC LIMIT 100",
        {"receipt_id": receipt["id"]},
        limit=101,
    )
    fields = {
        "version",
        "receiptHash",
        "authorizationId",
        "expectedVersion",
        "orderCreatedAt",
        "acknowledgedConflicts",
        "reason",
    }
    for event in events:
        try:
            approval = json.loads(event["details_json"])
            if (
                approval.get("receiptHash") != row["request_hash"]
                or approval.get("authorizationId") != grant["id"]
            ):
                continue
            if (
                set(approval) != fields
                or type(approval["version"]) is not int
                or approval["version"] != 1
                or integer(approval["expectedVersion"], 1, 2147483647) + 1
                > int(row["version"])
                or not isinstance(approval["reason"], str)
                or not 1 <= len(approval["reason"]) <= 500
                or not isinstance(approval["acknowledgedConflicts"], list)
                or any(
                    not isinstance(conflict, str) or conflict not in CONFLICTS
                    for conflict in approval["acknowledgedConflicts"]
                )
                or len(set(approval["acknowledgedConflicts"]))
                != len(approval["acknowledgedConflicts"])
                or "clock-outside-authorization"
                not in approval["acknowledgedConflicts"]
            ):
                raise invalid()
            wall_clock = approval["orderCreatedAt"]
            naive = datetime.datetime.strptime(wall_clock, "%Y-%m-%d %H:%M:%S")
            if (
                naive.strftime("%Y-%m-%d %H:%M:%S") != wall_clock
                or naive.date().isoformat() != receipt["businessDate"]
            ):
                raise invalid()
            possibilities = set()
            for fold in (0, 1):
                candidate = naive.replace(tzinfo=business_zone, fold=fold)
                epoch = round(candidate.timestamp() * 1000)
                back = datetime.datetime.fromtimestamp(
                    epoch / 1000, datetime.timezone.utc
                ).astimezone(business_zone)
                if back.replace(tzinfo=None) == naive:
                    possibilities.add(epoch)
            if (
                len(possibilities) != 1
                or not grant["issuedAt"]
                <= next(iter(possibilities))
                <= grant["expiresAt"]
            ):
                raise invalid()
            return wall_clock
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
            raise invalid() from None
    raise PricingError("SOURCE_CASH_CLOCK_ATTRIBUTION_REQUIRED")


def verify_cash_amounts(executor, row, grant, snapshot, receipt, business_timezone):
    issued, expires = (
        integer(grant[name], 1, 9007199254740991) for name in ("issuedAt", "expiresAt")
    )
    completed = integer(receipt["completedAt"], 1, 9007199254740991)
    zone = ZoneInfo(business_timezone)
    timestamp = None
    if issued <= completed <= expires:
        original = datetime.datetime.fromtimestamp(
            completed / 1000, datetime.timezone.utc
        ).astimezone(zone)
        if original.date().isoformat() == receipt["businessDate"]:
            timestamp = original.strftime("%Y-%m-%d %H:%M:%S")
    if timestamp is None:
        timestamp = attributed_cash_time(executor, row, grant, receipt, zone)
    if not snapshot["issuedAt"] <= issued <= expires <= snapshot["expiresAt"]:
        raise invalid()
    sequence = integer(receipt["sequence"], 1, integer(grant["receiptCount"], 1, 1000))
    if receipt["receiptNumber"] != grant["receiptPrefix"] + "-" + str(sequence).zfill(
        4
    ):
        raise invalid()
    prices = {product["productId"]: product for product in snapshot["products"]}
    lines = receipt["lines"]
    if (
        not isinstance(lines, list)
        or not 1 <= len(lines) <= 100
        or len({line["productId"] for line in lines}) != len(lines)
    ):
        raise invalid()
    units = taxable = tax = 0
    for line in lines:
        product = prices.get(line["productId"])
        if product is None:
            raise invalid()
        quantity = integer(line["quantity"], 1, 99)
        rows = [
            price for price in product["quantities"] if price["quantity"] == quantity
        ]
        if len(rows) != 1:
            raise invalid()
        expected = {
            **rows[0],
            **{name: product[name] for name in ("productId", "name", "barcode", "hsn")},
        }
        if canonical_bytes(line) != canonical_bytes(expected):
            raise invalid()
        units += quantity
        taxable += integer(line["taxableCents"])
        tax += integer(line["taxCents"])
    total = integer(taxable + tax)
    payable, rounding = total - total % 100, total % 100
    if (
        grant.get("maxReceiptUnits") != 1000
        or units > 1000
        or receipt["taxableCents"] != taxable
        or receipt["taxCents"] != tax
        or receipt["roundingCents"] != rounding
        or receipt["payableCents"] != payable
        or not 0 < payable <= grant["maxReceiptCents"]
        or integer(receipt["cashReceivedCents"]) - integer(receipt["changeCents"])
        != payable
    ):
        raise invalid()
    return row, grant, snapshot, receipt, timestamp


def source_models(source_root):
    import sqlalchemy
    from sqlalchemy.orm import declarative_base

    path, tree = checked_tree(source_root, "models/Order.py", MODEL_SHA256)
    selected = []
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        if any(
            isinstance(base, ast.Attribute)
            and isinstance(base.value, ast.Name)
            and base.value.id == "enum"
            for base in node.bases
        ):
            selected.append(node)
        elif node.name in {"OrderModel", "HasProductModel", "OrderStoreModel"}:
            projected = copy.deepcopy(node)
            projected.body = [
                statement
                for statement in node.body
                if isinstance(statement, ast.Assign)
                and (
                    any(
                        isinstance(target, ast.Name) and target.id == "__tablename__"
                        for target in statement.targets
                    )
                    or isinstance(statement.value, ast.Call)
                    and isinstance(statement.value.func, ast.Name)
                    and statement.value.func.id == "Column"
                )
            ]
            selected.append(projected)
    namespace = {
        name: getattr(sqlalchemy, name)
        for name in (
            "Integer",
            "Column",
            "String",
            "DateTime",
            "SmallInteger",
            "Float",
            "Text",
            "DECIMAL",
            "BigInteger",
            "Enum",
            "ForeignKey",
        )
    }
    namespace.update(Base=declarative_base(), enum=enum, datetime=datetime)
    exec(
        compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"),
        namespace,
    )
    return namespace


def source_functions(source_root, settings, executor, product_ids):
    path, tree = checked_tree(source_root, "libs/OrderHelper.py", ORDER_HELPER_SHA256)
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name
        in {
            "build_order_model",
            "build_has_products_model",
            "pos_build_order_store_model",
            "extract_first_image",
            "get_flags",
        }
    ]
    namespace = source_models(source_root)
    resolver = SourceReferences(executor, settings, product_ids)
    namespace.update(
        settings=SimpleNamespace(**settings),
        ItemTypes=ItemTypes,
        Session=executor,
        fetchOne=resolver.fetch_one,
        logger=SilentLogger(),
        # The private plain-cash protocol carries no marketing/app Origin.
        check_wwe=lambda _request: None,
        falcon=SimpleNamespace(
            HTTPBadRequest=lambda *_args, **_kwargs: PricingError(
                "SOURCE_TEMPLATE_REJECTED"
            )
        ),
    )
    helper_path, helper_tree = checked_tree(
        source_root, "libs/helper.py", HELPER_SHA256
    )
    allocation = [
        node
        for node in helper_tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name in {"round_down", "allocate_amount_per_unit"}
    ]
    namespace.update(math=math, Decimal=Decimal, ROUND_DOWN=ROUND_DOWN, json=json)
    exec(
        compile(ast.Module(body=allocation, type_ignores=[]), str(helper_path), "exec"),
        namespace,
    )
    exec(
        compile(ast.Module(body=functions, type_ignores=[]), str(path), "exec"),
        namespace,
    )
    return namespace, resolver.products


class SourceReferences:
    def __init__(self, executor, settings, product_ids):
        self.executor = executor
        rows = executor.select(
            "SELECT p.id,pap.id AS parent_id,pap.spl_price AS special_price,pap.price AS normal_price,"
            "CASE WHEN p.cog>0 THEN p.cog ELSE pap.cog END AS cog,"
            "IFNULL(pap.gender_type,p.gender_type) AS gender_type,"
            "CASE WHEN pap.is_jit=0 THEN 'REGULAR' WHEN pap.is_jit=1 THEN 'JIT' "
            "WHEN pap.is_jit=2 THEN 'PRE_ORDER' WHEN pap.is_jit=3 THEN 'MTO' END AS jit_value,"
            "IFNULL(pap.images_new,p.images_new) AS images_new,"
            "(SELECT GROUP_CONCAT(DISTINCT hc.cat_id ORDER BY hc.cat_id DESC) FROM has_categories hc WHERE hc.prod_id=pap.id) AS categories "
            "FROM products p JOIN products pap ON pap.id="
            "(CASE WHEN p.parent_prod_id>0 THEN p.parent_prod_id ELSE p.id END) WHERE p.id IN :ids",
            {"ids": tuple(int(value) for value in product_ids)},
            limit=101,
        )
        self.products = {int(row["id"]): dict(row) for row in rows}
        if len(self.products) != len(product_ids):
            raise PricingError("SOURCE_PRODUCT_METADATA_MISSING")
        lists = settings["EXCLUSIVE_PRICELISTS"]
        if (
            not isinstance(lists, list)
            or not lists
            or len(lists) > 100
            or any(type(value) is not int or value <= 0 for value in lists)
        ):
            raise PricingError("SOURCE_CONFIGURATION_UNSUPPORTED", 503)
        self.lists_sql = "(" + ",".join(map(str, lists)) + ")"
        rows = executor.select(
            "SELECT pl.product_id,pl.price AS exclusive_price FROM pricelist pl JOIN pricelist_meta plm ON pl.pricelist_id=plm.id "
            "WHERE plm.is_active=1 AND pl.pricelist_id IN :lists AND pl.product_id IN :ids",
            {
                "lists": tuple(lists),
                "ids": tuple(
                    sorted({row["parent_id"] for row in self.products.values()})
                ),
            },
            limit=101,
        )
        self.exclusive = {}
        for row in rows:
            key = int(row["product_id"])
            if key in self.exclusive:
                raise PricingError("SOURCE_PRICELIST_AMBIGUOUS")
            self.exclusive[key] = dict(row)

    def fetch_one(self, session, query, params=None, to_dict=False):
        if session is not self.executor or to_dict is not True:
            raise PricingError("SOURCE_QUERY_UNSUPPORTED")
        normalized = " ".join(query.split())
        if (
            normalized
            == "select firstname, lastname, telephone from users where id =:user_id"
            or normalized.startswith(
                "SELECT st.store_name, st.address, st.alt_address, st.phone, st.pincode, ct.city_name,"
            )
        ):
            rows = self.executor.select(query, params or {}, limit=2)
            if len(rows) != 1:
                raise PricingError("SOURCE_REFERENCE_NOT_VISIBLE")
            return dict(rows[0])
        product = re.search(r"WHERE p.id = ([0-9]+)$", normalized)
        if product and normalized.startswith(
            "SELECT pap.id AS parent_id, pap.spl_price AS special_price,"
        ):
            key = int(product.group(1))
            if key not in self.products:
                raise PricingError("SOURCE_QUERY_SCOPE_MISMATCH")
            return self.products[key]
        exclusive = re.fullmatch(
            r"SELECT pl.price AS exclusive_price FROM pricelist pl JOIN pricelist_meta plm on pl.pricelist_id = plm.id WHERE plm.is_active = 1 and pl.pricelist_id in (\([0-9,]+\)) AND pl.product_id = ([0-9]+)",
            normalized,
        )
        if exclusive and exclusive.group(1) == self.lists_sql:
            return self.exclusive.get(int(exclusive.group(2)), {})
        raise PricingError("SOURCE_QUERY_UNSUPPORTED")


def model_values(model, timestamp):
    result = {}
    supplied = vars(model)
    for column in model.__table__.columns:
        if column.primary_key:
            continue
        if column.key in {"created_at", "updated_at"}:
            value = timestamp
        elif column.key in supplied and supplied[column.key] is not None:
            value = supplied[column.key]
        elif column.default is None:
            value = None
        elif column.default.is_scalar:
            value = column.default.arg
        else:
            raise PricingError("SOURCE_MODEL_DEFAULT_UNSUPPORTED")
        if isinstance(value, enum.Enum):
            value = value.name
        result[column.name] = value
    return result


def serialize_values(values):
    result = {}
    for name, value in values.items():
        if value is None or type(value) is bool or isinstance(value, str):
            result[name] = value
        elif isinstance(value, (int, float, Decimal)):
            decimal = Decimal(str(value))
            if not decimal.is_finite():
                raise PricingError("SOURCE_MODEL_VALUE_UNREPRESENTABLE")
            result[name] = format(decimal, "f")
        else:
            raise PricingError("SOURCE_MODEL_VALUE_UNREPRESENTABLE")
    return result


def physical_values(model, timestamp):
    return serialize_values(model_values(model, timestamp))


def build_template(
    source_root, source_settings, executor, receipt_id, business_timezone="Asia/Kolkata"
):
    row, grant, snapshot, receipt, timestamp = accepted_cash(
        executor, receipt_id, business_timezone
    )
    settings = {
        **source_settings,
        "IS_LINE_ITEM_ENABLED": int(snapshot["lineItemsEnabled"]),
    }
    functions, references = source_functions(
        source_root,
        settings,
        executor,
        [line["productId"] for line in receipt["lines"]],
    )
    cart = PlainCashCart([], executor)
    cart.meta["payment_details"] = {
        "name": "payment_details",
        "id": 14,
        "payment_method": "cash",
    }
    zeros = {
        name: 0
        for name in (
            "used_reward_points",
            "used_tss_money",
            "used_tss_points",
            "hl_charges",
            "gift_wrap_amount",
            "cod_charges",
            "gift_voucher_value",
            "shipping_charges",
            "app_cashback",
            "app_discount",
            "express_charges",
            "coupon_discount",
            "used_store_discount_pg",
        )
    }
    calculations = {
        **zeros,
        "name": "calculations",
        "total": receipt["payableCents"] // 100,
        "rounding_off": receipt["roundingCents"] / 100,
        "main_sub_total": sum(line["mainSubtotalCents"] for line in receipt["lines"])
        / 100,
    }
    cart.meta["calculations"] = calculations
    user = {
        "user_id": int(grant["operatorCustomerId"]),
        "tss_money": 0,
        "tss_points": 0,
    }
    flag_products = [
        {
            "categories": list(
                map(
                    int,
                    (references[int(line["productId"])].get("categories") or "").split(
                        ","
                    ),
                )
            )
            if references[int(line["productId"])].get("categories")
            else []
        }
        for line in receipt["lines"]
    ]
    flag_ids, primary_flag = functions["get_flags"](
        SimpleNamespace(context={"data": {}}),
        flag_products,
        is_pos=True,
        is_shopify_order=False,
    )
    if (
        primary_flag != 19
        or not set(flag_ids).issubset({4, 13, 19})
        or 19 not in flag_ids
    ):
        raise PricingError("SOURCE_FLAG_PROJECTION_UNSUPPORTED")
    order = functions["build_order_model"](
        user, cart, None, primary_flag, is_pos=True, store_id=int(receipt["storeId"])
    )
    order.id = 0
    store = functions["pos_build_order_store_model"](
        order,
        int(receipt["storeId"]),
        int(receipt["counterId"]),
        admin_user_id=int(receipt["operatorId"]),
        is_offline_order=1,
    )
    lines = []
    for line in receipt["lines"]:
        check_deadline()
        reference = references[int(line["productId"])]
        product = {
            "prod_id": int(line["productId"]),
            "quantity": line["quantity"],
            "price": float(line["unitPrice"]),
            "spl_price": 0,
            "invoice_gst": float(line["invoiceGst"]),
            "gst": float(line["invoiceGst"]) / 100,
            "pre_gst_amt": line["taxableCents"] / 100,
            "final_payable": line["mainSubtotalCents"] / 100,
            "gender_type": reference["gender_type"],
            "jit_value": reference["jit_value"],
            "image": functions["extract_first_image"](reference["images_new"]),
            "cashback_earned": 0,
            "exclusive_savings": 0,
        }
        lines.extend(
            functions["build_has_products_model"](
                order, product, False, is_pos=True, calc=calculations
            )
        )
    if not lines or len(lines) > 1000:
        raise PricingError("SOURCE_TEMPLATE_TOO_LARGE")
    from source_refunds import (
        REFUND_CONTRACT,
        REFUND_PATCH_SHA256,
        source_refund_projection,
    )

    header = model_values(order, timestamp)
    mutated, allocations, cancellation_message_id, _ = source_refund_projection(
        source_root,
        header,
        [model_values(line, timestamp) for line in lines],
        profile=REFUND_CONTRACT,
    )
    return {
        "contract": CONTRACT,
        "sourceCommit": SOURCE_COMMIT,
        "receiptId": receipt_id,
        "receiptHash": row["request_hash"],
        "operatorCustomerId": grant["operatorCustomerId"],
        "storeId": receipt["storeId"],
        "counterId": receipt["counterId"],
        "businessDate": receipt["businessDate"],
        "lineItemsEnabled": snapshot["lineItemsEnabled"],
        "header": serialize_values(header),
        "orderStore": physical_values(store, timestamp),
        "lines": [serialize_values(line) for line in mutated],
        "refundAllocations": allocations,
        "cancellationMessageId": cancellation_message_id,
        "flagIds": flag_ids,
        "refundAllocationContract": REFUND_CONTRACT,
        "refundSourcePatchHash": REFUND_PATCH_SHA256,
    }
