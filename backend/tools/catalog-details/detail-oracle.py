"""Run the pinned ShowProductView body against supplied synthetic ORM facts only."""
import ast
import json
import subprocess
import sys
from types import SimpleNamespace

payload = json.load(sys.stdin)
text = subprocess.check_output(["git", "-C", "/Users/rishabhbhatia/code/backend-pos-web", "show", "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:core/views.py"], text=True)
node = next(item for item in ast.parse(text).body if isinstance(item, ast.ClassDef) and item.name == "ShowProductView")

def model(row):
    values = dict(row)
    for key in ["id", "product_id", "parent_prod_id", "pricelist_id", "django_user_id", "store_id", "add_desc_id"]:
        if values.get(key) is not None:
            values[key] = int(values[key])
    if "product_id" in values:
        values["product"] = SimpleNamespace(id=values["product_id"])
    return SimpleNamespace(**values)

class Query:
    def __init__(self, rows):
        self.rows = rows
    def filter(self, **kwargs):
        def matches(row):
            for key, expected in kwargs.items():
                field, _, suffix = key.partition("__")
                actual = getattr(row, field)
                if suffix == "in":
                    allowed = [value[0] if isinstance(value, tuple) else value for value in expected]
                    if actual not in allowed:
                        return False
                elif str(actual) != str(expected) and not (actual == expected):
                    return False
            return True
        return Query([row for row in self.rows if matches(row)])
    def first(self):
        return self.rows[0] if self.rows else None
    def none(self):
        return Query([])
    def exists(self):
        return bool(self.rows)
    def values_list(self, key, flat=False):
        return [getattr(row, key) if flat else (getattr(row, key),) for row in self.rows]
    def __bool__(self):
        return bool(self.rows)
    def __iter__(self):
        return iter(self.rows)

tables = {name: Query([model(row) for row in rows]) for name, rows in payload["tables"].items()}
stock = {}
for row in payload["tables"]["product_store"]:
    stock.setdefault(int(row["product_id"]), {})[int(row["store_id"])] = row["stock"]
checked = payload.get("checkedInStoreId")
checked = int(checked) if checked is not None else None
environment = {
    "LoginRequiredMixin": type("LoginRequiredMixin", (), {}), "View": type("View", (), {}), "json": json,
    "Product": SimpleNamespace(objects=tables["products"]),
    "ProductBarcode": SimpleNamespace(objects=tables["products_gs1"]),
    "ProductDescription": SimpleNamespace(objects=tables["add_desc"]),
    "PriceList": SimpleNamespace(objects=tables["pricelist"]),
    "Store": SimpleNamespace(objects=tables["stores"]),
    "UserStore": SimpleNamespace(objects=tables["user_stores"]),
    "Helpers": SimpleNamespace(live_variant_ids=lambda product_id: [int(value) for value in payload["liveVariantIds"]], get_checkin_data=lambda user_id: [checked], get_product_store_stock=lambda owner, ids: stock),
    "render": lambda request, template, context: context,
}
exec(compile(ast.Module(body=[node], type_ignores=[]), "source/core/views.py", "exec"), environment)
view = environment["ShowProductView"]()
user = payload["user"]
view.request = SimpleNamespace(user=SimpleNamespace(id=int(user["id"]), role=user["role"], user_type=user["userType"]))
result = view.get(view.request, int(payload["productId"]))
print(json.dumps({
    "variants": [{"id": str(value.id), "name": value.product, "barcode": str(value.gtin) if hasattr(value, "gtin") else None} for value in result["varients"]],
    "stores": [str(store.id) for store in result["stores_data"]],
    "stock": [{"productId": str(variant.id), "storeId": str(store.id), "stock": stock.get(variant.id, {}).get(store.id, 0)} for variant in result["varients"] for store in result["stores_data"]],
    "exclusivePrice": getattr(result["product"], "exclusive_price", None),
    "description": {"name": result["desc_name"], "description": result["desc"], "material": result["desc_material"]},
    "male": result["male_obj"], "female": result["female_obj"],
    "checkInRequired": bool(result["checkin_required_message"]),
}, ensure_ascii=False))
