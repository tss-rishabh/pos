"""Actual source I/O blocks and SQLAlchemy receipts; all providers are synthetic.

Requires the existing pricing Python environment. MySQL is a randomized localhost
fixture supplied on stdin, never the source/live endpoint.
"""

import hashlib
import io
import json
import os
import subprocess
import sys
import threading
import unittest
import uuid
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from sqlalchemy import create_engine, delete
from sqlalchemy.engine import URL
warnings.filterwarnings('ignore', category=SyntaxWarning)

BRIDGE = Path(__file__).resolve().parents[3] / "compatibility/upstream/ecommerce-full-sync"
sys.path.insert(0, str(BRIDGE))
from contract import CONTRACT, PATH, SyncError, create_app, encode, request_signature, response_signature
from source_runner import verified_source, bind_stock_readers
from store import CommandStore, commands, registry, reconciliations

SOURCE = Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT', str(Path(__file__).resolve().parents[5] / 'backend-tss-api_v2')))
from source_io_fixture import source_io, stock_reader_fixture
from runtime import execute
from worker_fixture import completed_source

def fixture_engine(database):
    parsed = urlparse(database)
    if parsed.scheme != "mysql" or parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.path.startswith("/pos_rewrite_ecommerce_sync_"):
        raise RuntimeError("A randomized localhost fixture is required")
    return create_engine(URL.create("mysql+pymysql", username=parsed.username, password=parsed.password or "", host=parsed.hostname, port=parsed.port or 3306, database=parsed.path[1:]),
        echo=False, hide_parameters=True, pool_size=10, max_overflow=0, connect_args={"connect_timeout": 5, "read_timeout": 5, "write_timeout": 5})

SECRET = "synthetic-ecommerce-source-key-" * 2
PROOF = {"mongoWrites": 1, "redisWrites": 1, "cdnBatches": 1, "catalogDigest": "a" * 64}


def command():
    return {"contract": CONTRACT, "operationId": str(uuid.uuid4()), "storeId": "9007199254740993", "actorId": "9007199254740995", "requestId": "fixture-request"}


class StoreTests(unittest.TestCase):
    def setUp(self):
        with engine.begin() as conn:
            for table in [commands, registry, reconciliations]:
                conn.execute(delete(table))
            conn.execute(registry.insert().values(id="catalog", active_id=None))
        self.clock = 1781505000
        self.store = CommandStore(engine, lambda: self.clock)

    def test_parallel_accept_is_once_and_hash_bound(self):
        body = command()
        with ThreadPoolExecutor(max_workers=10) as pool:
            values = list(pool.map(lambda _index: self.store.accept(body), range(20)))
        self.assertTrue(all(value == values[0] for value in values))
        with self.assertRaises(SyncError):
            self.store.accept({**body, "storeId": "2"})
        self.assertEqual(values[0]["requestHash"], hashlib.sha256(encode(body)).hexdigest())

    def test_global_claim_never_overlaps_other_stores_or_reclaims_expired_workers(self):
        first, second = command(), command()
        self.store.accept(first)
        self.store.accept(second)
        worker = str(uuid.uuid4())
        accepted = self.store.claim(worker)
        self.assertIsNotNone(accepted)
        self.clock += 100
        self.assertEqual(self.store.read(accepted["operationId"])["status"], "uncertain")
        self.assertIsNone(self.store.claim(str(uuid.uuid4())))
        self.assertTrue(self.store.heartbeat(accepted))
        self.store.finish(accepted, PROOF)
        self.assertIsNotNone(self.store.claim(str(uuid.uuid4())))

    def test_partial_unknown_keeps_global_fence_and_explicit_same_operation_reconciliation(self):
        body = command()
        self.store.accept(body)
        accepted = self.store.claim(str(uuid.uuid4()))
        self.store.finish(accepted)
        self.assertEqual(self.store.read(body["operationId"])["status"], "uncertain")
        with self.assertRaises(SyncError):
            self.store.reconcile_stopped(body["operationId"], accepted["workerId"], "b" * 64)
        self.clock += 100
        with self.assertRaises(SyncError):
            self.store.reconcile_stopped(body["operationId"], str(uuid.uuid4()), "b" * 64)
        self.store.reconcile_stopped(body["operationId"], accepted["workerId"], "b" * 64)
        again = self.store.claim(str(uuid.uuid4()))
        self.assertEqual(again["operationId"], body["operationId"])
        with self.assertRaises(SyncError):
            self.store.finish(accepted, PROOF)
        self.store.finish(again, PROOF)
        self.assertEqual(self.store.accept(body)["proof"], PROOF)

    def test_receipt_proof_validation_prevents_invalid_completion(self):
        body = command()
        self.store.accept(body)
        accepted = self.store.claim(str(uuid.uuid4()))
        with self.assertRaises(SyncError):
            self.store.finish(accepted, {**PROOF, "mongoWrites": True})
        self.assertEqual(self.store.read(body["operationId"])["status"], "running")

    def request(self, method, path, body=b"", timestamp=None, signature=None):
        operation_id = json.loads(body)["operationId"] if body else path.rsplit("/", 1)[-1]
        timestamp = str(self.clock if timestamp is None else timestamp)
        env = {"PATH_INFO": path, "REQUEST_METHOD": method, "CONTENT_LENGTH": str(len(body)), "CONTENT_TYPE": "application/json", "wsgi.input": io.BytesIO(body),
            "HTTP_X_ECOM_TIMESTAMP": timestamp, "HTTP_X_ECOM_SIGNATURE": signature or request_signature(SECRET, timestamp, method, path, body), "HTTP_IDEMPOTENCY_KEY": operation_id}
        headers = []
        output = b"".join(create_app(self.store, SECRET, lambda: self.clock)(env, lambda status, values: headers.append((status, dict(values)))))
        return headers[0], output

    def test_protocol_ack_is_queued_and_get_recovers_without_dispatch(self):
        body = command()
        (status, headers), raw = self.request("POST", PATH, encode(body))
        self.assertTrue(status.startswith("202"))
        self.assertEqual(json.loads(raw)["status"], "queued")
        self.assertEqual(headers["X-Ecom-Signature"], response_signature(SECRET, body["operationId"], raw))
        (_, _), raw_again = self.request("GET", PATH + "/" + body["operationId"])
        self.assertEqual(raw, raw_again)
        accepted = self.store.claim(str(uuid.uuid4()))
        self.store.finish(accepted, PROOF)
        (_, _), complete = self.request("GET", PATH + "/" + body["operationId"])
        self.assertEqual(json.loads(complete)["proof"], PROOF)
        self.assertIsNone(self.store.claim(str(uuid.uuid4())))

    def test_protocol_rejects_stale_or_forged_signatures_and_signs_missing_original(self):
        body = command()
        for extra in [{"timestamp": self.clock - 61}, {"signature": "0" * 64}]:
            (status, _), _raw = self.request("POST", PATH, encode(body), **extra)
            self.assertTrue(status.startswith("401"))
        (status, headers), raw = self.request("GET", PATH + "/" + body["operationId"])
        self.assertTrue(status.startswith("404"))
        self.assertEqual(json.loads(raw)["error"], "ECOMMERCE_FULL_SYNC_NOT_FOUND")
        self.assertEqual(headers["X-Ecom-Signature"], response_signature(SECRET, body["operationId"], raw))

    def test_actual_supervised_worker_source_io_and_signed_receipt_complete_roundtrip(self):
        body = command()
        self.request('POST', PATH, encode(body))
        accepted = self.store.claim(str(uuid.uuid4()))
        execute(self.store, accepted, json.dumps({'sourceRoot': str(SOURCE)}), threading.Event(), child_target=completed_source)
        (status, headers), raw = self.request('GET', PATH + '/' + body['operationId'])
        self.assertTrue(status.startswith('200'))
        value = json.loads(raw)
        self.assertEqual(value['status'], 'succeeded')
        self.assertEqual({name: value['proof'][name] for name in ['mongoWrites','redisWrites','cdnBatches']}, {'mongoWrites':3,'redisWrites':3,'cdnBatches':1})
        self.assertEqual(headers['X-Ecom-Signature'], response_signature(SECRET, body['operationId'], raw))
        self.assertEqual(self.store.accept(body), value)
        self.assertIsNone(self.store.claim(str(uuid.uuid4())))

    def test_actual_worker_failure_and_timeout_never_publish_completion_or_release_global_fence(self):
        for mode in ['cdn-failure','slow']:
            self.setUp()
            body = command(); self.store.accept(body)
            accepted = self.store.claim(str(uuid.uuid4()))
            execute(self.store, accepted, json.dumps({'sourceRoot': str(SOURCE), 'mode': mode}), threading.Event(), timeout_seconds=0.1 if mode=='slow' else 10, child_target=completed_source)
            value = self.store.read(body['operationId'])
            self.assertEqual(value['status'], 'uncertain')
            self.assertIsNone(value['proof'])
            self.assertIsNone(self.store.claim(str(uuid.uuid4())))




class SourceTests(unittest.TestCase):
    def test_source_identity_is_pinned(self):
        self.assertEqual(verified_source(SOURCE), SOURCE.resolve())

    def test_actual_source_variant_helper_observes_writer_quantity_without_changing_other_reader_namespaces(self):
        module, stock, database, tracker, writer, replica = stock_reader_fixture()
        stale = module.configProduct(10)
        self.assertEqual(stale[0]['stock'], 2)
        replica.queries.clear()
        cms = database.SessionReadCMS
        verify = bind_stock_readers(module, stock, database, tracker)
        verify()
        current = module.configProduct(10)
        verify()
        self.assertEqual(current, [{**stale[0], 'stock':17}])
        self.assertEqual(replica.queries, [])
        self.assertTrue(any('product_stocks' in query for query, _params in writer.queries))
        self.assertIs(database.SessionR, replica)
        self.assertIs(database.SessionReadCMS, cms)

    def test_stock_reader_reversion_is_refused_even_if_the_source_swallows_error_and_restores_alias(self):
        module, stock, database, tracker, writer, replica = stock_reader_fixture()
        verify = bind_stock_readers(module, stock, database, tracker)
        stock.SessionR = replica
        with self.assertRaises(SyncError):
            module.configProduct(10)
        stock.SessionR = writer
        verify()
        with self.assertRaises(SyncError):
            tracker.proof(False)
        self.assertEqual(replica.queries, [])

    def test_a_named_writer_on_a_read_only_server_cannot_publish_current_stock_completion(self):
        module, stock, database, tracker, _writer, _replica = stock_reader_fixture(read_only=1)
        verify = bind_stock_readers(module, stock, database, tracker)
        with self.assertRaises(SyncError):
            verify()
        with self.assertRaises(SyncError):
            tracker.proof(False)

    def test_actual_source_mongo_redis_and_504_url_batches_preserve_bodies(self):
        run, events, _tracker = source_io()
        rows = [{"id": index, "product_slug": 'sku-' + str(index), "stock": 7} for index in range(1, 86)]
        proof = run(rows)
        self.assertEqual(proof['mongoWrites'], 85)
        self.assertEqual(proof['redisWrites'], 85)
        self.assertEqual([len(kwargs['json']['objects']) for _url, kwargs in events['cdn']], [504, 6])
        self.assertEqual(events['mongo'][0], ({'id': 1}, {'$set': rows[0]}, True))
        self.assertEqual(json.loads(events['redis'][0][1]), rows[0])
        self.assertEqual(events['cdn'][0][1]['timeout'], (5, 10))
        self.assertIs(events['cdn'][0][1]['allow_redirects'], False)

    def test_actual_source_optional_redis_disabled_is_not_fabricated(self):
        run, events, _tracker = source_io(redis_enabled=False)
        proof = run([{'id': 1, 'product_slug': 'one'}])
        self.assertEqual(proof['redisWrites'], 0)
        self.assertEqual(events['redis'], [])

    def test_source_swallowed_mongo_and_redis_failures_cannot_publish_success(self):
        for flags in [{'mongo_failure': True}, {'redis_failure': True}, {'cdn_status': 500}]:
            run, _events, tracker = source_io(**flags)
            with self.assertRaises(SyncError):
                run([{'id': 1, 'product_slug': 'one'}])
            self.assertTrue(tracker.errors)

    def test_no_payload_or_raw_exception_leaves_the_dedicated_source_process(self):
        program = '''
import sys, pathlib, types
sys.path.insert(0, sys.argv[1])
import source_runner
source_runner.verified_source=lambda root:pathlib.Path(root).resolve()
scope=types.SimpleNamespace(__file__='/tmp/ecom-source/sync/SyncProduct.py', FETCH_PRODUCTS_FROM_REDIS=False)
class Source:
 def make_products(self):
  print('private-product-payload')
  print('private-mongo-uri',file=sys.stderr)
scope.SyncProductFull=Source
source_runner.importlib.import_module=lambda name:scope
source_runner.instrument=lambda *args:types.SimpleNamespace(proof=lambda enabled:{})
source_runner.bind_stock_readers=lambda *args:lambda:None
source_runner.run('/tmp/ecom-source')
'''
        # resolve(strict=True) of synthetic module provenance needs only fixture files.
        import tempfile
        with tempfile.TemporaryDirectory(prefix='ecom-quiet-source-') as temp:
            root = Path(temp); (root/'sync').mkdir(); (root/'sync/SyncProduct.py').write_text('')
            program = program.replace('/tmp/ecom-source', str(root))
            result = subprocess.run([sys.executable, '-c', program, str(BRIDGE)], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout + result.stderr, b'')


if __name__ == '__main__':
    engine = fixture_engine(json.load(sys.stdin)['database'])
    with engine.begin() as connection:
        for statement in (BRIDGE/'migration.review.sql').read_text().split(';'):
            statement = '\n'.join(line for line in statement.splitlines() if not line.strip().startswith('--')).strip()
            if statement:
                connection.exec_driver_sql(statement)
    suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(StoreTests), unittest.defaultTestLoader.loadTestsFromTestCase(SourceTests)])
    log = io.StringIO()
    result = unittest.TextTestRunner(stream=log, verbosity=2).run(suite)
    engine.dispose()
    if not result.wasSuccessful():
        sys.stderr.write(log.getvalue())
    print(json.dumps({"ok": result.wasSuccessful(), "cases": result.testsRun}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
