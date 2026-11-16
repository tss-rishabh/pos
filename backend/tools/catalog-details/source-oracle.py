"""Execute pinned source datatable methods with local SQL rows; no Django/network/database imports."""
import ast
import datetime
import json
import math
import subprocess
import sys
from types import SimpleNamespace
from functools import lru_cache

BASELINE = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
SOURCE = "/Users/rishabhbhatia/code/backend-pos-web"
TARGETS = {
    "catalog": ("core/datatables/products_datatable.py", "AjaxProductsListView"),
    "product": ("core/datatables/product_inventory_datatable.py", "AjaxProductInventoryListView"),
    "held": ("core/datatables/hold_stock_datatable.py", "AjaxHoldStockInventoryListView"),
    "storage": ("core/datatables/storage_stock_datatable.py", "AjaxStorageStockInventoryListView"),
}
@lru_cache(maxsize=4)
def source_node(kind):
    path, class_name = TARGETS[kind]
    source = subprocess.check_output(["git", "-C", SOURCE, "show", BASELINE + ":" + path], text=True)
    tree = ast.parse(source)
    node = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == class_name)
    return path, class_name, node

def run_case(data):
    path, class_name, node = source_node(data.get("kind", "catalog"))
    queries = []
    results = iter(data.get("results", []))

    class EmptyPage(Exception):
        pass
    class PageNotAnInteger(Exception):
        pass
    class Paginator:
        def __init__(self, rows, size):
            self.rows, self.size = rows, size
        def page(self, number):
            if number != int(number):
                raise PageNotAnInteger()
            if number < 1 or number > max(1, math.ceil(len(self.rows) / self.size)):
                raise EmptyPage()
            start = (int(number) - 1) * self.size
            return SimpleNamespace(object_list=self.rows[start:start + self.size])
    class Cursor:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, query):
            queries.append(query)
            result = next(results, {"columns": [], "rows": []})
            self.description = [(name,) for name in result["columns"]]
            self.rows = []
            for row in result["rows"]:
                converted = list(row)
                for index, name in enumerate(result["columns"]):
                    if name in {"id", "product_id", "pos_user_id", "user_id"} and converted[index] is not None:
                        converted[index] = int(converted[index])
                if "created_at" in result["columns"]:
                    index = result["columns"].index("created_at")
                    if converted[index]:
                        converted[index] = datetime.datetime.fromisoformat(converted[index])
                self.rows.append(converted)
        def fetchall(self):
            return self.rows
    class Parameters(dict):
        def getlist(self, key):
            return self.get(key, [])
    class Users:
        def filter(self, **kwargs):
            value = data.get("users", {}).get(str(kwargs["pk"]))
            user = SimpleNamespace(get_full_name=lambda: value) if value is not None else None
            return SimpleNamespace(first=lambda: user)

    environment = {
        "LoginRequiredMixin": type("LoginRequiredMixin", (), {}),
        "View": type("View", (), {}),
        "connections": {"mysql_db": SimpleNamespace(cursor=Cursor), "read_db": SimpleNamespace(cursor=Cursor)},
        "READ_DB_ALIAS": "read_db", "SimpleNamespace": SimpleNamespace,
        "Paginator": Paginator, "EmptyPage": EmptyPage, "PageNotAnInteger": PageNotAnInteger,
        "Helpers": SimpleNamespace(get_product_stores=lambda *args: {}),
        "User": SimpleNamespace(objects=Users()), "json": json,
    }
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), environment)
    operator = environment[class_name]()
    if data.get("mode") == "delta":
        return [operator.get_added_reduced_no(item[0], item[1]) for item in data["cases"]]
    else:
        output = operator.datatables(SimpleNamespace(POST=Parameters(data["parameters"])))
        return {"queries": queries, "output": output}

payload = json.load(sys.stdin)
print(json.dumps([run_case(case) for case in payload] if isinstance(payload, list) else run_case(payload), ensure_ascii=False))
