"""Execute the pinned stock datatable and ERP/stock helpers over synthetic verified-MySQL facts."""
import ast
import json
import math
import subprocess
import sys
from types import SimpleNamespace
SOURCE = "/Users/rishabhbhatia/code/backend-pos-web"
BASELINE = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
data = json.load(sys.stdin)
def read(path):
    return ast.parse(subprocess.check_output(["git", "-C", SOURCE, "show", BASELINE + ":" + path], text=True))
def model(row, stock=False):
    row = dict(row)
    for key in ["id", "product_id", "store_id", "parent_prod_id", "prod_type"]:
        if row.get(key) is not None:
            row[key] = int(row[key])
    if stock:
        row["is_avail"], row["is_del"] = bool(row["is_avail"]), bool(row["is_del"])
    return SimpleNamespace(**row)
class Q:
    def __init__(self, **kwargs):
        def test(row):
            for name, expected in kwargs.items():
                key, _, lookup = name.partition("__")
                actual = getattr(row, key)
                if lookup == "in":
                    values = [next(iter(value.values())) if isinstance(value, dict) else value for value in expected]
                    if actual not in values:
                        return False
                elif lookup == "icontains":
                    if str(expected).lower() not in str(actual).lower():
                        return False
                elif lookup == "gt":
                    if actual <= expected:
                        return False
                elif actual != expected:
                    return False
            return True
        self.test = test
    def __and__(self, other):
        result = Q(); result.test = lambda row: self.test(row) and other.test(row); return result
    def __or__(self, other):
        result = Q(); result.test = lambda row: self.test(row) or other.test(row); return result
    def __invert__(self):
        result = Q(); result.test = lambda row: not self.test(row); return result
class Query:
    def __init__(self, rows):
        self.rows = rows
    def using(self, alias):
        return self
    def filter(self, *conditions, **kwargs):
        return Query([row for row in self.rows if all(condition.test(row) for condition in conditions) and Q(**kwargs).test(row)])
    def exclude(self, condition):
        return self.filter(~condition)
    def order_by(self, column):
        key = column.lstrip("-")
        return Query(sorted(self.rows, key=lambda row: (getattr(row, key) is not None, str(getattr(row, key)).lower() if key not in {"id", "parent_prod_id"} else getattr(row, key)), reverse=column.startswith("-")))
    def values(self, key):
        return [{key: getattr(row, key)} for row in self.rows]
    def count(self):
        return len(self.rows)
    def first(self):
        return self.rows[0] if self.rows else None
    def __iter__(self):
        return iter(self.rows)
    def __bool__(self):
        return bool(self.rows)
class EmptyPage(Exception):
    pass
class PageNotAnInteger(Exception):
    pass
class Paginator:
    def __init__(self, rows, length):
        self.rows, self.length = rows.rows, length
    def page(self, number):
        if number != int(number):
            raise PageNotAnInteger()
        if number < 1 or number > max(1, math.ceil(len(self.rows) / self.length)):
            raise EmptyPage()
        start = (int(number) - 1) * self.length
        return SimpleNamespace(object_list=self.rows[start:start + self.length])
environment = {"Q": Q, "Subquery": lambda value: value, "READ_DB_ALIAS": "read_db", "Product": SimpleNamespace(objects=Query([model(row) for row in data["products"]])), "ProductStore": SimpleNamespace(objects=Query([model(row, True) for row in data["stock"]])), "LoginRequiredMixin": type("LoginRequiredMixin", (), {}), "View": type("View", (), {}), "Paginator": Paginator, "EmptyPage": EmptyPage, "PageNotAnInteger": PageNotAnInteger}
helper_class = next(node for node in read("helpers/helpers.py").body if isinstance(node, ast.ClassDef) and node.name == "Helpers")
helper_names = ["get_erp_name", "get_product_stores", "get_product_store_stock", "get_product_store_is_avail", "get_product_store_is_del"]
helpers = [node for node in helper_class.body if isinstance(node, ast.FunctionDef) and node.name in helper_names]
for helper in helpers:
    helper.decorator_list = []
exec(compile(ast.Module(body=helpers, type_ignores=[]), "source/helpers/helpers.py", "exec"), environment)
environment["Helpers"] = SimpleNamespace(**{name: environment[name] for name in helper_names})
node = next(node for node in read("core/datatables/store_products_datatable.py").body if isinstance(node, ast.ClassDef) and node.name == "AjaxProductsStockListView")
exec(compile(ast.Module(body=[node], type_ignores=[]), "source/core/datatables/store_products_datatable.py", "exec"), environment)
def render(parameters):
    return environment["AjaxProductsStockListView"]().datatables(SimpleNamespace(POST=parameters))
result = [render(parameters) for parameters in data["parameterCases"]] if "parameterCases" in data else render(data["parameters"])
print(json.dumps(result, ensure_ascii=False))
