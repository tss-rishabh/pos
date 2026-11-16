"""Execute both pinned pending-cancellation handlers with inert synthetic adapters.

No source initialization, network, database or generated-file writes occur.
The stock call is recorded, not interpreted as proof of the old stored procedure.
"""
import ast
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
WEB_COMMIT = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
API_COMMIT = "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5"


def pinned(repo, commit, path, class_name, method_name):
    source = subprocess.check_output(["git", "show", commit + ":" + path], cwd=ROOT / repo, text=True)
    cls = next(node for node in ast.parse(source).body if isinstance(node, ast.ClassDef) and node.name == class_name)
    method = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == method_name)
    return compile(ast.Module(body=[method], type_ignores=[]), "<pinned-cancellation>", "exec"), hashlib.sha256(source.encode()).hexdigest()


api_code, api_sha = pinned("backend-tss-api_v2", API_COMMIT, "controllers/OrderController.py", "CancelPosorder", "on_post")
web_code, web_sha = pinned("backend-pos-web", WEB_COMMIT, "order/views.py", "AjaxOrderCancelView", "post")
cases = []
for name, products, bad_second, missing_stock in [
    ("one-line", [(10, 2)], False, False),
    ("duplicate-sku", [(10, 2), (10, 3)], False, False),
    ("two-skus", [(10, 2), (11, 1)], False, False),
    ("long-identifiers", [(9007199254740995, 2)], False, False),
    ("partial-source-error", [(10, 2), (11, 1)], True, False),
    ("missing-stock-source-success", [(10, 2)], False, True),
]:
    order_id = 9007199254740993
    lines = [{"id": 9007199254741000 + index, "prod_id": product_id, "qty": quantity, "status": "DELIVERED" if bad_second and index == 1 else "PLACED", "hp_tss_points_used": 0, "price": 99.95, "gst": 5} for index, (product_id, quantity) in enumerate(products)]
    stock = {product_id: SimpleNamespace(stock=10, save=lambda: None) for product_id, _ in products if not missing_stock}
    api_effects, calls, logs = [], [], []
    statuses = {"order": 1, "payment": 1}

    class Session:
        def execute(self, statement):
            text = str(statement)
            if "UPDATE amount_to_be_refunded_log" in text:
                api_effects.append({"kind": "mark-refunded", "lineId": re.search(r"has_product_id = (\d+)", text).group(1)})
            elif "UPDATE has_products" in text:
                api_effects.append({"kind": "cashback-refunded", "lineId": re.search(r"and id =(\d+)", text).group(1)})
            else:
                raise RuntimeError("Unexpected source SQL")

    def fetch(_session, _query, **_kwargs):
        return copy.deepcopy(lines)

    def fetch_one(_session, query, **kwargs):
        if "tss_messages" in query:
            return None
        if "amount_to_be_refunded_log" in query:
            key = kwargs["params"]["has_prod_id"]
            if not any(row["id"] == key for row in lines):
                raise RuntimeError("Source lost exact line binding")
            return {"amount_to_be_refunded": 99.95, "tss_money_used": 0, "tss_point_used": 0, "gift_voucher_amount": 0}
        raise RuntimeError("Unexpected source reader")

    api_scope = {"json": json, "falcon": SimpleNamespace(HTTPBadRequest=ValueError, HTTP_400="400"), "pt": SimpleNamespace(ORDER_CANCELLED="ORDER_CANCELLED"),
                 "fetch_order": lambda *_args: {"payment_method": 14, "voucher_used": 0}, "fetch": fetch, "fetchOne": fetch_one,
                 "settings": SimpleNamespace(EXCLUSIVE_PRODUCT={}, EXCLUSIVE_UPGRADE_PRODUCT={}), "logger": SimpleNamespace(info=lambda *_: None)}
    exec(api_code, api_scope)

    def post(_url, json, headers):
        if json != {"user_id": 777, "order_id": order_id} or headers != {"Content-Type": "application/json"}:
            raise RuntimeError("Pinned cancellation request changed")
        response = SimpleNamespace()
        try:
            api_scope["on_post"](None, SimpleNamespace(context={"data": json, "session": Session()}), response)
            return SimpleNamespace(status_code=200, json=lambda: {"message": "refund on order cancel"})
        except ValueError:
            return SimpleNamespace(status_code=400, json=lambda: {"message": "source rejection"})

    class Query:
        def __init__(self, kind, filters):
            self.kind, self.filters = kind, filters

        def first(self):
            if self.kind == "order":
                return SimpleNamespace(user=SimpleNamespace(id=777), order_store=SimpleNamespace(first=lambda: SimpleNamespace(store_id=1)))
            if self.kind == "status":
                return SimpleNamespace(order_status="CANCELLED")
            if self.kind == "stock":
                return stock.get(self.filters["product_id"])
            raise RuntimeError("Unexpected source model")

        def update(self, **values):
            if self.kind == "order":
                statuses.update(order=values["order_statuses"], payment=values["payment_statuses"])
            elif self.kind == "lines":
                for row in lines:
                    row["status"] = values["status"]
            else:
                raise RuntimeError("Unexpected source update")

        def __iter__(self):
            return iter([SimpleNamespace(product=SimpleNamespace(id=row["prod_id"]), qty=row["qty"]) for row in lines])

    def model(kind):
        return SimpleNamespace(objects=SimpleNamespace(filter=lambda **filters: Query(kind, filters)))

    web_scope = {"json": json, "Order": model("order"), "OrderStatus": model("status"), "HasProduct": model("lines"), "ProductStore": model("stock"),
                 "MIGRATION_TO_API_V2": True, "MAIN_API_V2_URL": "https://source.invalid/", "API_V2_URL": "https://source.invalid/", "requests": SimpleNamespace(post=post),
                 "HttpResponse": lambda body, **_kwargs: json.loads(body),
                 "Helpers": SimpleNamespace(transaction_logger=lambda *args: logs.append({"payDict": args[4], "comment": args[5]}), cancel_transaction_logger=lambda *_: None,
                                            sync_pos_inventory=lambda store_id, ids, after, **_kwargs: calls.append({"storeId": str(store_id), "productIds": [str(item) for item in ids], "after": after}), sync_pos_product=lambda *_: None)}
    exec(web_code, web_scope)
    request = SimpleNamespace(POST={"order_id": str(order_id)}, user=SimpleNamespace(id=44))
    result = web_scope["post"](SimpleNamespace(request=request), request)
    cases.append({"name": name, "result": result, "statuses": statuses, "lines": [{"id": str(row["id"]), "productId": str(row["prod_id"]), "quantity": row["qty"], "status": row["status"]} for row in lines],
                  "stocks": {str(key): value.stock for key, value in stock.items()}, "stockCalls": calls, "apiEffects": api_effects, "logs": logs})
print(json.dumps({"sourceCommits": {"web": WEB_COMMIT, "apiV2": API_COMMIT}, "sourceHashes": {"web": web_sha, "apiV2": api_sha}, "cases": cases}))
