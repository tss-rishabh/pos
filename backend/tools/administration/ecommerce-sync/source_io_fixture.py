"""Synthetic providers around actual pinned source I/O blocks; never import live app startup."""
import ast
import datetime
import enum
import json
import warnings
from http import HTTPStatus
from pathlib import Path
from types import ModuleType, SimpleNamespace
from source_runner import instrument, Tracker
from contract import SyncError
warnings.filterwarnings('ignore', category=SyntaxWarning)
SOURCE = Path('/Users/rishabhbhatia/code/backend-tss-api_v2')


def stock_reader_fixture(read_only=0):
    class Session:
        def __init__(self, stock):
            self.stock, self.queries = stock, []
        def execute(self, query, params=None):
            self.queries.append((str(query), params))
            if 'read_only' in str(query):
                return SimpleNamespace(first=lambda: (read_only,))
            return SimpleNamespace(fetchall=lambda: [{'id':11,'product_name':'Synthetic variant','stock':self.stock,'is_avail':1}])
    writer, replica = Session(17), Session(2)
    stock = ModuleType('fixture_stock_helpers')
    stock.__dict__.update(Session=writer, SessionR=replica, make_age_groups=lambda:{},
        getOptions=lambda _id:[], get_variants_ordering_key=lambda row:row['id'], settings=SimpleNamespace(IS_AUTO_GENERATE_AGE=False))
    original = definition('SyncProduct.py','configProduct',stock.__dict__)
    module = ModuleType('fixture_full_builder')
    module.Session, module.configProduct = writer, original
    database = SimpleNamespace(Session=writer, SessionR=replica, SessionReadCMS=object())
    tracker = Tracker()
    return module, stock, database, tracker, writer, replica


def definition(path, name, scope):
    tree = ast.parse((SOURCE / path).read_text())
    node = next(node for node in tree.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), scope)
    return scope[name]


def source_io(redis_enabled=True, mongo_failure=False, redis_failure=False, cdn_status=201):
    events = {"mongo": [], "redis": [], "cdn": []}
    logger = SimpleNamespace(info=lambda *_args: None, error=lambda *_args: None, debug=lambda *_args: None)
    class Collection:
        def update_one(self, query, value, upsert=False):
            events["mongo"].append((query, value, upsert))
            if mongo_failure:
                raise RuntimeError("private-mongo-uri")
            return SimpleNamespace(acknowledged=True)
    class Redis:
        def set(self, key, raw):
            events["redis"].append((key, raw))
            return False if redis_failure else True
    class Session:
        def post(self, url, **kwargs):
            events["cdn"].append((url, kwargs))
            return SimpleNamespace(status_code=cdn_status, close=lambda: None)
        def close(self): pass
    cdn_scope = {"BaseCdn": object, "requests": SimpleNamespace(Session=Session), "EdgeGridAuth": lambda **kwargs: ("source-edgegrid", kwargs), "settings": SimpleNamespace(AKAMAI_HOST="fixture.akamaiapis.net", AKAMAI_CLIENT_TOKEN="synthetic", AKAMAI_CLIENT_SECRET="synthetic", AKAMAI_ACCESS_TOKEN="synthetic"), "HTTPStatus": HTTPStatus, "logger": logger}
    definition("sync/CdnSync.py", "AkamaiCdn", cdn_scope)
    cdn_scope["CdnProvider"] = SimpleNamespace(AKAMAI="AKAMAI")
    definition("sync/CdnSync.py", "CdnFactory", cdn_scope)
    helper_scope = {"json": json, "datetime": datetime, "ObjectId": type("ObjectId", (), {}), "redis_catalogue_object": Redis(), "logger": logger, "REDIS_PRODUCT_PREFIX_STRING": "product:", "PRODUCTION_DOMAIN_URL": "https://fixture.invalid", "settings": SimpleNamespace(API_PREFIX="/api/v2"), "CdnFactory": cdn_scope["CdnFactory"], "CdnProvider": cdn_scope["CdnProvider"]}
    helper_scope["GenderType"] = definition("utils/enums.py", "GenderType", {"enum": enum})
    for name in ["JsonEncoder", "construct_product_redis_key", "insert_product_data_into_redis", "delete_product_cache_from_cdn"]:
        definition("libs/helper.py", name, helper_scope)
    module = SimpleNamespace(products_collection=Collection(), FETCH_PRODUCTS_FROM_REDIS=redis_enabled)
    helper, cdn = SimpleNamespace(**helper_scope), SimpleNamespace(**cdn_scope)
    tracker = instrument(module, helper, cdn)
    # Source functions retain their original global dictionaries. Update those
    # bindings to the wrapped dependencies rather than cloning their logic.
    helper_scope["redis_catalogue_object"] = helper.redis_catalogue_object
    cdn_scope["requests"] = cdn.requests
    method = next(node for node in next(node for node in ast.parse((SOURCE / 'sync/SyncProduct.py').read_text()).body if isinstance(node, ast.ClassDef) and node.name == 'SyncProductFull').body if isinstance(node, ast.FunctionDef) and node.name == 'make_products')
    block = next(node for node in method.body if isinstance(node, ast.For))
    effect = next(node for node in block.body if isinstance(node, ast.Try) and any(isinstance(child, ast.Attribute) and child.attr == 'update_one' for child in ast.walk(node)))
    code = compile(ast.Module(body=[effect], type_ignores=[]), 'sync/SyncProduct.py', 'exec')
    scope = {"products_collection": module.products_collection, "FETCH_PRODUCTS_FROM_REDIS": redis_enabled, "insert_product_data_into_redis": helper_scope['insert_product_data_into_redis'], "logger": logger}
    def run(rows):
        for row in rows:
            scope['rowData'] = row
            exec(code, scope)
        helper_scope['delete_product_cache_from_cdn']([row['product_slug'] for row in rows])
        return tracker.proof(redis_enabled)
    return run, events, tracker
