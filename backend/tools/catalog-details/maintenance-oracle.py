"""Run pinned inventory-pull/troubleshoot view bodies with in-memory facts and captured HTTP only."""
import ast
import csv
import io
import json
import subprocess
import sys
from types import SimpleNamespace
data = json.load(sys.stdin)
source = subprocess.check_output(["git", "-C", "/Users/rishabhbhatia/code/backend-pos-web", "show", "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a:core/views.py"], text=True)
tree = ast.parse(source)
def model(row):
    row = dict(row)
    for key in ["id", "product_id", "parent_prod_id", "prod_type", "gtin"]:
        if row.get(key) is not None:
            row[key] = int(row[key])
    return SimpleNamespace(**row)
products = [model(row) for row in data.get("products", [])]
stock = [model(row) for row in data.get("stock", [])]
barcodes = [model(row) for row in data.get("barcodes", [])]
class Query:
    def __init__(self, rows):
        self.rows = rows
    def filter(self, **kwargs):
        def matches(row):
            for key, expected in kwargs.items():
                field, _, suffix = key.partition("__")
                actual = getattr(row, field)
                if suffix == "in":
                    if actual not in [int(value) for value in expected]:
                        return False
                elif str(actual) != str(expected):
                    return False
            return True
        return Query([row for row in self.rows if matches(row)])
    def exclude(self, **kwargs):
        selected = self.filter(**kwargs).rows
        return Query([row for row in self.rows if row not in selected])
    def first(self):
        return self.rows[0] if self.rows else None
    def values_list(self, key, flat=False):
        return [getattr(row, key) if flat else (getattr(row, key),) for row in self.rows]
    def update(self, **kwargs):
        for row in self.rows:
            for key, value in kwargs.items():
                setattr(row, key, value)
    def __bool__(self):
        return bool(self.rows)
for product in products:
    product.pb_product = SimpleNamespace(all=lambda product=product: Query([barcode for barcode in barcodes if barcode.product_id == product.id]))
calls = []
warnings = []
environment = {"LoginRequiredMixin": type("LoginRequiredMixin", (), {}), "View": type("View", (), {}), "Product": SimpleNamespace(objects=Query(products)), "ProductStore": SimpleNamespace(objects=Query(stock)), "ProductBarcode": SimpleNamespace(objects=Query(barcodes)), "json": json, "csv": csv, "io": io, "print": lambda *args, **kwargs: None, "INVENTORY_SYNC_URL": "https://fixture.invalid/pull", "INVENTORY_SYNC_API_KEY": "fixture-key", "requests": SimpleNamespace(post=lambda url, **kwargs: calls.append(kwargs) or SimpleNamespace(status_code=200)), "messages": SimpleNamespace(warning=lambda request, text: warnings.append(text), success=lambda *args: None), "render": lambda *args: None, "Helpers": SimpleNamespace(sync_pos_product=lambda ids, is_troubleshoot=False: calls.append({"ids": [str(value) for value in ids], "troubleshoot": is_troubleshoot})), "HttpResponse": lambda text, **kwargs: json.loads(text)}
name = "InventorySyncView" if data["kind"] == "inventory-pull" else "AjaxTroubleshootProductView"
node = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
exec(compile(ast.Module(body=[node], type_ignores=[]), "source/core/views.py", "exec"), environment)
files = {}
if data.get("mode") == "csv":
    files["csv_file"] = SimpleNamespace(name="fixture.csv", read=lambda: data["csv"].encode("utf8"))
parameters = {"is_upload": int(data.get("mode") == "csv"), "skus": data.get("skus", ""), "product_id": data.get("productId", "0")}
environment[name]().post(SimpleNamespace(POST=parameters, FILES=files))
if data["kind"] == "inventory-pull":
    print(json.dumps({"payloads": [call["json"] for call in calls], "warnings": warnings}))
else:
    print(json.dumps({"products": [{"id": str(row.id), "images_new": row.images_new} for row in products], "stock": [{"id": str(row.id), "stock": row.stock, "is_avail": int(row.is_avail), "is_del": int(row.is_del)} for row in stock], "barcodes": [{"id": str(row.id), "gtin": str(row.gtin)} for row in barcodes], "calls": calls}))
