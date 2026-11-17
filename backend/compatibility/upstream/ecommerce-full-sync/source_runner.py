"""Run the pinned full builder, preserving its payloads while proving mandatory I/O.

Call only in the dedicated child process: the old builder logs payload/exception
details. Runtime suppresses all of that process's stdout/stderr before importing it.
"""

import hashlib
import importlib
import json
import logging
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from sqlalchemy import text
from contract import SyncError


class Tracker:
    def __init__(self):
        self.mongo = self.redis = self.cdn = self.urls = 0
        self.errors = set()
        self.digest = hashlib.sha256()
        self.expected_urls = hashlib.sha256()
        self.actual_urls = hashlib.sha256()

    def fail(self, code):
        self.errors.add(code)
        raise SyncError(code)

    def proof(self, redis_enabled):
        if self.errors or self.redis != (self.mongo if redis_enabled else 0) or self.urls != 6 * self.mongo or self.expected_urls.digest() != self.actual_urls.digest():
            raise SyncError("ECOMMERCE_FULL_SYNC_IO_UNCERTAIN")
        return {"mongoWrites": self.mongo, "redisWrites": self.redis, "cdnBatches": self.cdn, "catalogDigest": self.digest.hexdigest()}


def bind_stock_readers(module, stock_helpers, database, tracker):
    """Bind the pinned bundle/variant helper to this child's catalog writer only.

    The source full module already reads Session. Its imported configProduct uses
    root SyncProduct.SessionR, including nested option/age lookups. Do not change
    database.SessionR, CMS readers or any connection in the public legacy process.
    """
    writer = database.Session
    original = stock_helpers.configProduct
    if (module.Session is not writer or stock_helpers.Session is not writer
            or module.configProduct is not original
            or original.__globals__ is not stock_helpers.__dict__):
        tracker.fail("ECOMMERCE_FULL_SYNC_WRITER_BINDING_INVALID")
    stock_helpers.SessionR = writer

    def aliases_current():
        if (module.Session is not writer or stock_helpers.Session is not writer
                or stock_helpers.SessionR is not writer
                or original.__globals__.get('SessionR') is not writer
                or module.configProduct is not guarded):
            tracker.fail("ECOMMERCE_FULL_SYNC_WRITER_BINDING_CHANGED")

    def guarded(*args, **kwargs):
        aliases_current()
        value = original(*args, **kwargs)
        aliases_current()
        return value

    module.configProduct = guarded

    def verify():
        aliases_current()
        # Names alone are not a writer proof. Refuse a read-only server after an
        # endpoint/configuration error or failover, without logging its identity.
        row = writer.execute(text('SELECT @@global.read_only AS read_only')).first()
        if row is None or row[0] != 0:
            tracker.fail("ECOMMERCE_FULL_SYNC_WRITER_READ_ONLY")

    return verify


def instrument(module, helper, cdn_module):
    """Wrap concrete source dependencies, not the product transformation code."""
    tracker, collection, redis = Tracker(), module.products_collection, helper.redis_catalogue_object
    base = helper.PRODUCTION_DOMAIN_URL + helper.settings.API_PREFIX + "/static/product/"
    origin = urlsplit(helper.PRODUCTION_DOMAIN_URL)
    if origin.scheme != "https" or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment:
        raise SyncError("ECOMMERCE_FULL_SYNC_CDN_CONFIGURATION_INVALID")
    genders = [helper.GenderType.UNISEX.value, helper.GenderType.MALE.value, helper.GenderType.FEMALE.value]
    if len(genders) != 3:
        raise SyncError("ECOMMERCE_FULL_SYNC_CDN_CONFIGURATION_INVALID")

    class CheckedMongo:
        def update_one(self, query, update_body, upsert=False):
            try:
                doc = update_body["$set"]
                if set(query) != {"id"} or set(update_body) != {"$set"} or query["id"] != doc["id"] or upsert is not True:
                    return tracker.fail("ECOMMERCE_FULL_SYNC_SOURCE_CONTRACT_CHANGED")
                # Serialization is computed before the write, using the source encoder.
                raw = json.dumps(doc, cls=helper.JsonEncoder, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
                result = collection.update_one(query, update_body, upsert=True)
                if getattr(result, "acknowledged", False) is not True:
                    return tracker.fail("ECOMMERCE_FULL_SYNC_MONGO_UNACKNOWLEDGED")
                tracker.mongo += 1
                tracker.digest.update(hashlib.sha256(raw).digest())
                for gender in genders:
                    for suffix in [f"?gender_type={gender}", f"?gender_type={gender}&platform=web"]:
                        tracker.expected_urls.update((base + doc["product_slug"] + suffix + "\n").encode())
                return result
            except Exception:
                tracker.errors.add("ECOMMERCE_FULL_SYNC_MONGO_UNCERTAIN")
                raise SyncError("ECOMMERCE_FULL_SYNC_MONGO_UNCERTAIN") from None

    class CheckedRedis:
        def set(self, *args, **kwargs):
            try:
                result = redis.set(*args, **kwargs)
                if result is not True:
                    return tracker.fail("ECOMMERCE_FULL_SYNC_REDIS_UNACKNOWLEDGED")
                tracker.redis += 1
                return result
            except Exception:
                tracker.errors.add("ECOMMERCE_FULL_SYNC_REDIS_UNCERTAIN")
                raise SyncError("ECOMMERCE_FULL_SYNC_REDIS_UNCERTAIN") from None

    original_session = cdn_module.requests.Session
    expected_cdn = "https://" + cdn_module.settings.AKAMAI_HOST + "/ccu/v3/delete/url/production"
    cdn_url = urlsplit(expected_cdn)
    if (cdn_url.scheme != "https" or not cdn_url.hostname or cdn_url.username or cdn_url.password
            or cdn_url.port not in {None, 443} or cdn_url.query or cdn_url.fragment
            or not cdn_url.hostname.endswith(".akamaiapis.net")):
        raise SyncError("ECOMMERCE_FULL_SYNC_CDN_CONFIGURATION_INVALID")

    class CheckedSession:
        def __init__(self):
            object.__setattr__(self, "session", original_session())

        def __setattr__(self, key, value):
            setattr(self.session, key, value)

        def post(self, url, **kwargs):
            try:
                payload = kwargs.get("json")
                if (url != expected_cdn or not isinstance(payload, dict) or set(payload) != {"objects"}
                        or not isinstance(payload["objects"], list) or not 1 <= len(payload["objects"]) <= 504):
                    return tracker.fail("ECOMMERCE_FULL_SYNC_SOURCE_CONTRACT_CHANGED")
                for value in payload["objects"]:
                    if not isinstance(value, str) or not value.startswith(base):
                        return tracker.fail("ECOMMERCE_FULL_SYNC_SOURCE_CONTRACT_CHANGED")
                kwargs.update(timeout=(5, 10), allow_redirects=False)
                response = self.session.post(url, **kwargs)
                if response.status_code != 201:
                    return tracker.fail("ECOMMERCE_FULL_SYNC_CDN_UNACKNOWLEDGED")
                for value in payload["objects"]:
                    tracker.actual_urls.update((value + "\n").encode())
                tracker.urls += len(payload["objects"])
                tracker.cdn += 1
                response.close()
                return response
            except Exception:
                tracker.errors.add("ECOMMERCE_FULL_SYNC_CDN_UNCERTAIN")
                raise SyncError("ECOMMERCE_FULL_SYNC_CDN_UNCERTAIN") from None
            finally:
                self.session.close()

    module.products_collection = CheckedMongo()
    helper.redis_catalogue_object = CheckedRedis()
    # Do not alter requests.Session globally or drop the source EdgeGrid auth.
    cdn_module.requests = SimpleNamespace(Session=CheckedSession)
    return tracker


def verified_source(source_root):
    root = Path(source_root).resolve(strict=True)
    manifest = json.loads(Path(__file__).with_name("source-manifest.json").read_text())
    for name, expected in manifest["apiFiles"].items():
        path = (root / name).resolve(strict=True)
        if root not in path.parents or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SyncError("ECOMMERCE_FULL_SYNC_SOURCE_UNVERIFIED")
    return root


def run(source_root):
    root = verified_source(source_root)
    # The dedicated child owns these process-global settings. No source logs escape,
    # including import-time loggers, raw exceptions and lower-level driver output.
    logging.disable(logging.CRITICAL)
    with open(os.devnull, "w") as sink:
        for fd in [1, 2]:
            os.dup2(sink.fileno(), fd)
        sys.path.insert(0, str(root))
        importlib.invalidate_caches()
        module = importlib.import_module("sync.SyncProduct")
        helper = importlib.import_module("libs.helper")
        cdn = importlib.import_module("sync.CdnSync")
        stock_helpers = importlib.import_module('SyncProduct')
        database = importlib.import_module('database.database')
        for imported in [module, helper, cdn, stock_helpers, database]:
            if root not in Path(imported.__file__).resolve(strict=True).parents:
                raise SyncError("ECOMMERCE_FULL_SYNC_SOURCE_UNVERIFIED")
        tracker = instrument(module, helper, cdn)
        verify_writer = bind_stock_readers(module, stock_helpers, database, tracker)
        verify_writer()
        module.SyncProductFull().make_products()
        verify_writer()
        return tracker.proof(module.FETCH_PRODUCTS_FROM_REDIS is True)
