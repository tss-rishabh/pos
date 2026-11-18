"""Persistent native Django catalog benchmark oracle, synthetic localhost only.

The complete pinned post()/datatables() handlers, models, real paginator and
helpers execute unchanged. Request construction, connection setup, normalization
and IPC are outside the source-handler-to-serialized-bytes timer. Authentication
is pre-resolved; this does not measure the deployed legacy middleware stack.
"""
import ast
from contextlib import ExitStack
import hashlib
import json
from pathlib import Path
import platform
import re
import sys
import traceback
from time import perf_counter_ns
from types import SimpleNamespace
from urllib.parse import unquote, urlencode, urlparse


SOURCE_PIN = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
SOURCE_FILES = ("core/models.py", "stores/models.py", "helpers/helpers.py",
                "core/datatables/products_datatable.py", "core/datatables/store_products_datatable.py")
CLASS_NAMES = {"catalog": "AjaxProductsListView", "matrix": "AjaxProductsStockListView"}
TARGETS = {"catalog": SOURCE_FILES[3], "matrix": SOURCE_FILES[4]}
HELPERS = ("get_product_stores", "get_erp_name", "get_product_store_stock",
           "get_product_store_is_avail", "get_product_store_is_del")


def require(value, code):
    if not value:
        raise ValueError(code)


def source_class(tree, name):
    return next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)


def configure(payload):
    require(set(payload) == {"command", "database", "sourceRoot"}, "INVALID_SOURCE_INITIALIZATION")
    database = urlparse(payload["database"])
    require(database.scheme == "mysql" and database.hostname == "127.0.0.1" and database.port
            and not database.query and not database.fragment
            and re.fullmatch(r"/pos_rewrite_catalog_workflow_[a-f0-9]{12}", database.path),
            "EXPLICIT_LOCAL_WORKFLOW_SCHEMA_REQUIRED")
    backend = Path(__file__).resolve().parents[2]
    inventory = json.loads((backend / "parity/legacy-inventory.json").read_text())
    require(inventory["source_commit"] == SOURCE_PIN, "SOURCE_INVENTORY_PIN_CHANGED")
    recorded = {row["path"]: row["sha256"] for row in inventory["source_hashes"]}
    root = Path(payload["sourceRoot"]).resolve()
    trees, hashes = {}, {}
    for name in SOURCE_FILES:
        content = (root / name).read_bytes()
        hashes[name] = hashlib.sha256(content).hexdigest()
        require(hashes[name] == recorded[name], "SOURCE_BYTES_CHANGED")
        trees[name] = ast.parse(content)

    import django
    import pymysql
    require(django.get_version() == "4.2.5", "PINNED_SOURCE_DJANGO_REQUIRED")
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    options = {"ENGINE": "django.db.backends.mysql", "NAME": database.path[1:],
               "HOST": database.hostname, "PORT": str(database.port),
               "USER": unquote(database.username or ""), "PASSWORD": unquote(database.password or ""),
               "CONN_MAX_AGE": None,
               "OPTIONS": {"charset": "utf8mb4", "init_command": "SET sql_mode='STRICT_TRANS_TABLES'"}}
    settings.configure(SECRET_KEY="synthetic-catalog-workflow", USE_TZ=False, USE_I18N=False,
                       ALLOWED_HOSTS=["testserver"],
                       INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes"],
                       DEFAULT_AUTO_FIELD="django.db.models.BigAutoField",
                       DATABASES={alias: dict(options) for alias in ("default", "mysql_db", "workflow_read")})
    django.setup()
    from django.contrib.auth.mixins import LoginRequiredMixin
    from django.core.paginator import Paginator, EmptyPage, PageNotAnInteger
    from django.core.serializers.json import DjangoJSONEncoder
    from django.core.validators import MinLengthValidator
    from django.db import connections, models
    from django.db.models import Q, Subquery
    from django.http import HttpResponse
    from django.test import RequestFactory
    from django.utils.functional import cached_property
    from django.views import View

    namespace = {"__name__": "native_catalog_workflow_source", "models": models,
                 "MinLengthValidator": MinLengthValidator, "json": json, "cached_property": cached_property,
                 "READ_DB_ALIAS": "workflow_read", "connections": connections,
                 "LoginRequiredMixin": LoginRequiredMixin, "View": View,
                 "Q": Q, "Subquery": Subquery, "SimpleNamespace": SimpleNamespace,
                 "Paginator": Paginator, "EmptyPage": EmptyPage, "PageNotAnInteger": PageNotAnInteger,
                 "DjangoJSONEncoder": DjangoJSONEncoder, "HttpResponse": HttpResponse}
    models_ast = [source_class(trees["stores/models.py"], name) for name in ("TssSetting", "Store")]
    models_ast += [source_class(trees["core/models.py"], name) for name in ("Product", "ProductStore")]
    helpers_class = source_class(trees["helpers/helpers.py"], "Helpers")
    helper_methods = [node for node in helpers_class.body
                      if isinstance(node, ast.FunctionDef) and node.name in HELPERS]
    require(len(helper_methods) == len(HELPERS), "SOURCE_HELPER_SET_CHANGED")
    helpers = ast.ClassDef(name="Helpers", bases=[], keywords=[], body=helper_methods, decorator_list=[])
    handlers = [source_class(trees[TARGETS[kind]], name) for kind, name in CLASS_NAMES.items()]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[*models_ast, helpers, *handlers], type_ignores=[])),
                 "<pinned-native-catalog-workflow>", "exec"), namespace)
    profiles = {}
    for alias in settings.DATABASES:
        connection = connections[alias]
        connection.ensure_connection()
        with connection.cursor() as cursor:
            cursor.execute("SELECT CONNECTION_ID(),@@session.sql_mode,@@session.group_concat_max_len,"
                           "@@session.collation_connection,@@session.character_set_connection,"
                           "@@session.transaction_isolation,VERSION()")
            row = cursor.fetchone()
        profiles[alias] = {"connectionId": row[0], "sqlMode": row[1], "groupConcatMaxLen": row[2],
                           "collationConnection": row[3], "characterSetConnection": row[4],
                           "transactionIsolation": row[5], "mysqlVersion": row[6]}
    return {"namespace": namespace, "factory": RequestFactory(), "connections": connections,
            "sourceHashes": hashes, "profiles": profiles,
            "runtime": {"python": platform.python_version(), "django": django.get_version()}}


def normalize_response(value):
    # Preserve row/array ordering, price strings, nulls, concatenations and
    # dictionaries. Only the established exact-identifier wire mapping applies.
    for row in value["data"]:
        for key in ("id", "DT_RowId", "ParentProductId"):
            if key in row:
                row[key] = str(row[key])
        if "stores" in row:
            row["stores"] = [str(identifier) for identifier in row["stores"]]
    return value


def call(state, payload):
    require(set(payload) == {"command", "kind", "input"}, "INVALID_SOURCE_CALL")
    kind, values = payload["kind"], payload["input"]
    require(kind in CLASS_NAMES and isinstance(values, dict), "INVALID_SOURCE_KIND")
    require(set(values) == {"storeIds", "search", "sort", "direction", "start", "length", "draw"},
            "INVALID_SOURCE_INPUT_FIELDS")
    allowed = {"catalog": {"id", "product", "erp_product", "prod_type", "categories", "price",
                           "exclusive_price", "spl_price", "store_names"},
               "matrix": {"id", "product", "erp_product"}}
    require(values["sort"] in allowed[kind] and values["direction"] in ("asc", "desc"), "INVALID_SOURCE_SORT")
    require(isinstance(values["search"], str) and len(values["search"]) <= 150
            and all(type(values[key]) is int for key in ("start", "length", "draw"))
            and 0 <= values["start"] <= 2000 and 1 <= values["length"] <= 100
            and values["draw"] == 0, "INVALID_SOURCE_BOUNDS")
    require(isinstance(values["storeIds"], list) and len(values["storeIds"]) <= 8
            and all(identifier in [str(index) for index in range(1, 9)] for identifier in values["storeIds"]),
            "INVALID_SOURCE_STORE_SCOPE")
    parameters = {"selected_stores[]": values["storeIds"], "search[value]": values["search"],
                  "order[0][column]": "0", "order[0][dir]": values["direction"],
                  "columns[0][data]": values["sort"], "start": values["start"],
                  "length": values["length"], "draw": values["draw"]}
    request = state["factory"].post("/pinned-catalog-workflow/", data=urlencode(parameters, doseq=True),
                                     content_type="application/x-www-form-urlencoded")
    request.user = SimpleNamespace(is_authenticated=True)
    counts = {alias: 0 for alias in state["profiles"]}

    def observe(alias):
        def wrapper(execute, statement, parameters, many, context):
            require(not many and statement.lstrip().upper().startswith("SELECT"),
                    "SOURCE_WORKFLOW_MUST_REMAIN_READ_ONLY")
            counts[alias] += 1
            return execute(statement, parameters, many, context)
        return wrapper

    with ExitStack() as stack:
        for alias in counts:
            stack.enter_context(state["connections"][alias].execute_wrapper(observe(alias)))
        started = perf_counter_ns()
        response = state["namespace"][CLASS_NAMES[kind]].as_view()(request)
        body = response.content
        elapsed = perf_counter_ns() - started
    require(response.status_code == 200, "SOURCE_HANDLER_DID_NOT_RETURN_SUCCESS")
    value = normalize_response(json.loads(body))
    return {"kind": "result", "handlerSerializedMs": elapsed / 1_000_000,
            "queriesByAlias": counts, "logicalReads": sum(counts.values()),
            "responseBytes": len(body), "response": value}


def send(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    state = None
    try:
        for line in sys.stdin:
            require(len(line) <= 2_000_000, "SOURCE_IPC_INPUT_TOO_LARGE")
            payload = json.loads(line)
            if state is None:
                require(payload.get("command") == "initialize", "SOURCE_INITIALIZATION_REQUIRED")
                state = configure(payload)
                send({"kind": "ready", "sourcePin": SOURCE_PIN, "sourceHashes": state["sourceHashes"],
                      "profiles": state["profiles"], "runtime": state["runtime"],
                      "boundary": "preauthenticated-pinned-view-dispatch-through-response-content"})
            elif payload == {"command": "close"}:
                break
            else:
                require(payload.get("command") == "call", "UNKNOWN_SOURCE_COMMAND")
                send(call(state, payload))
    except Exception as error:
        number = error.args[0] if error.args and type(error.args[0]) is int else None
        diagnostic = {"kind": "error", "code": "NATIVE_SOURCE_WORKFLOW_FAILED", "errorKind": type(error).__name__,
                      "driverNumber": number,
                      "locations": [{"file": Path(frame.filename).name, "line": frame.lineno}
                                    for frame in traceback.extract_tb(error.__traceback__)
                                    if Path(frame.filename).name in ("native-workflow-oracle.py", "<pinned-native-catalog-workflow>")]}
        if isinstance(error, NameError) and re.fullmatch(r"[A-Za-z_]\w{0,63}", error.name or ""):
            diagnostic["missingSymbol"] = error.name
        send(diagnostic)
        sys.exit(1)
    finally:
        if state:
            state["connections"].close_all()


if __name__ == "__main__":
    main()
