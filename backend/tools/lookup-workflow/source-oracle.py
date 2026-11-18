"""Execute pinned lookup views/model with Django and the same local native rows.

This runner never imports the legacy application or calls external services.
Its database must be a new synthetic localhost barcode fixture schema. Source
classes, their LoginRequiredMixin dispatch and ORM/raw SQL are executed intact.
"""
import ast
import hashlib
import json
import platform
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import unquote, urlparse

urlpatterns = []


def main():
    payload = json.load(sys.stdin)
    database = urlparse(payload["database"])
    if (database.scheme != "mysql" or database.hostname not in ("127.0.0.1", "localhost")
            or not database.port or database.query or database.fragment
            or not re.fullmatch(r"/pos_rewrite_barcodes_[a-f0-9]{12}", database.path)):
        raise ValueError("ISOLATED_LOOKUP_SCHEMA_REQUIRED")
    source = Path(payload["sourceRoot"]).resolve()
    backend = Path(__file__).resolve().parents[2]
    inventory = json.loads((backend / "parity/legacy-inventory.json").read_text())
    hashes = {row["path"]: row["sha256"] for row in inventory["source_hashes"]}
    trees = {}
    for name in ("core/views.py", "core/urls.py", "stores/models.py"):
        content = (source / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != hashes[name]:
            raise ValueError("SOURCE_BASELINE_CHANGED")
        trees[name] = ast.parse(content)
    bindings = {}
    for node in ast.walk(trees["core/urls.py"]):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "path":
            if node.args and isinstance(node.args[0], ast.Constant):
                bindings[node.args[0].value] = ast.unparse(node.args[1])
    for route, cls in (("get-country-name/", "GetCountryNameView"),
                       ("get-location-by-pincode/", "GetLocationByPincodeView")):
        if f"core_views.{cls}.as_view()" not in bindings.get(route, ""):
            raise ValueError("SOURCE_ROUTE_BINDING_CHANGED")

    import django
    import pymysql
    if django.get_version() != "4.2.5":
        raise ValueError("PINNED_DJANGO_REQUIRED")
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    settings.configure(
        SECRET_KEY="synthetic-lookup-oracle", USE_TZ=False, USE_I18N=False,
        ALLOWED_HOSTS=["testserver"], ROOT_URLCONF=__name__, LOGIN_URL="/login/",
        INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes"],
        DATABASES={"default": {
            "ENGINE": "django.db.backends.mysql", "NAME": database.path[1:],
            "HOST": database.hostname, "PORT": str(database.port),
            "USER": unquote(database.username or ""), "PASSWORD": unquote(database.password or ""),
            "OPTIONS": {"charset": "utf8mb4", "init_command": "SET sql_mode='STRICT_TRANS_TABLES'"},
        }},
    )
    django.setup()
    from django.contrib.auth.mixins import LoginRequiredMixin
    from django.db import connection, models
    from django.http import HttpResponse
    from django.test import RequestFactory
    from django.views import View

    names = {"GetCountryNameView", "GetLocationByPincodeView"}
    country = next(node for node in trees["stores/models.py"].body
                   if isinstance(node, ast.ClassDef) and node.name == "Country")
    views = [node for node in trees["core/views.py"].body
             if isinstance(node, ast.ClassDef) and node.name in names]
    namespace = {"__name__": "lookup_source_fixture", "models": models,
                 "LoginRequiredMixin": LoginRequiredMixin, "View": View,
                 "connection": connection, "HttpResponse": HttpResponse, "json": json}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[country, *views], type_ignores=[])),
                 "<pinned-native-lookup-source>", "exec"), namespace)
    factory = RequestFactory()
    # Framework connection initialization precedes the SELECT-only business
    # execution boundary; its session setup never changes fixture rows.
    connection.ensure_connection()
    statements = []

    def execute(executor, statement, parameters, many, context):
        if not statement.lstrip().upper().startswith("SELECT"):
            raise ValueError("SOURCE_LOOKUP_MUST_BE_READ_ONLY")
        statements.append(statement)
        return executor(statement, parameters, many, context)

    def request(cls, path, query, authenticated=True):
        incoming = factory.get(path, data=query)
        incoming.user = SimpleNamespace(is_authenticated=authenticated, role=1, user_type=1)
        response = namespace[cls].as_view()(incoming)
        return response

    countries = []
    postals = []
    with connection.execute_wrapper(execute):
        for search in payload["countries"]:
            response = request("GetCountryNameView", "/get-country-name/",
                               {} if search is None else {"q": search})
            value = json.loads(response.content)
            for row in value["data"].get("country", []):
                row["id"] = str(row["id"])
            countries.append(value)
        for postal in payload["postals"]:
            response = request("GetLocationByPincodeView", "/get-location-by-pincode/",
                               {} if postal is None else {"pincode": postal})
            postals.append(json.loads(response.content))
        before = len(statements)
        anonymous = [request(cls, path, query, False).status_code for cls, path, query in (
            ("GetCountryNameView", "/get-country-name/", {"q": "India"}),
            ("GetLocationByPincodeView", "/get-location-by-pincode/", {"pincode": "400001"}),
        )]
        if len(statements) != before or anonymous != [302, 302]:
            raise ValueError("SOURCE_AUTHENTICATION_BOUNDARY_CHANGED")
    connection.close()
    json.dump({"countries": countries, "postals": postals, "anonymous": anonymous,
               "sourceHashes": {name: hashes[name] for name in trees},
               "nativeSelects": len(statements), "nativeWrites": 0,
               "pythonVersion": platform.python_version(), "djangoVersion": django.get_version()}, sys.stdout)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        json.dump({"error": "LOOKUP_SOURCE_ORACLE_FAILED", "kind": type(error).__name__}, sys.stdout)
        sys.exit(1)
