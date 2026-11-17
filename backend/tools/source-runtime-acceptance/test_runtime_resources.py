"""Exercise actual private-factory resource mounting with no SQL/providers."""
import io
import json
import logging
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
COMMON = ROOT / 'compatibility/upstream/legacy-order-imports'
PUBLIC = ROOT / 'compatibility/upstream/public-screening-writer'
sys.path[:0] = [str(COMMON), str(PUBLIC)]
import runtime
import negative_resource
from protocol import ImportReview, SOURCE_CONTRACT

KEY = 'isolated-runtime-negative-resource-key-' * 2
PROOF = 'isolated-runtime-native-source-proof-' * 2
IMPORT_KEY = 'isolated-runtime-private-import-key-' * 2
OP = '11111111-1111-4111-8111-111111111111'


class Connection:
    def __enter__(self): return self
    def __exit__(self, *_args): return None
    def execute(self, *_args):
        return SimpleNamespace(mappings=lambda: SimpleNamespace(all=lambda: [
            {'COLUMN_NAME': name, 'IS_NULLABLE': 'YES', 'DATA_TYPE': 'datetime'}
            for name in ('ship_date', 'ret_ex_request_date')]))


class Factory(unittest.TestCase):
    def environment(self):
        return {
            'POS_LEGACY_IMPORT_SOURCE_CONTRACT': SOURCE_CONTRACT,
            'POS_LEGACY_IMPORT_MODEL_CONTRACT': 'pos-import-source-model-v1',
            'POS_LEGACY_IMPORT_KEY': IMPORT_KEY,
            'POS_LEGACY_IMPORT_PROOF_KEY': PROOF,
            'POS_LEGACY_IMPORT_MYSQL_WRITER_URL':
                'mysql+pymysql://fixture:synthetic-fixture-password@127.0.0.1/fixture',
            'POS_LEGACY_IMPORT_MYSQL_CA_FILE': str(Path(__file__).resolve()),
            'POS_LEGACY_IMPORT_SOURCE_ROOT': str(ROOT),
            'POS_LEGACY_IMPORT_RUNTIME_ROOT': str(COMMON),
            'POS_PUBLIC_SCREENING_NEGATIVE_KEY': KEY,
        }

    def build(self, environment):
        logs = io.StringIO()
        calls = []
        receipt = {'data': {'intent': {'actorId': '7'}}, 'proofHash': 'a' * 64}
        target = SimpleNamespace(
            read=lambda op: calls.append(('read', op)) or receipt,
            post=lambda op: calls.append(('post', op)) or receipt,
        )
        engine = SimpleNamespace(connect=Connection)
        pipeline = SimpleNamespace(membership=False, tasks=SimpleNamespace())
        old_out, old_error, old_logging = sys.stdout, sys.stderr, logging.root.manager.disable
        try:
            with patch.dict(os.environ, environment, clear=True), \
                 patch('sqlalchemy.create_engine', return_value=engine), \
                 patch('sqlalchemy.event.listen'), \
                 patch('sqlalchemy.orm.sessionmaker', return_value=lambda: None), \
                 patch('source_runtime.SourceRuntime', return_value=pipeline), \
                 patch('model_compat.verify_physical_columns'), \
                 patch('negative_resource.resource', return_value=target) as resource_factory:
                sys.stdout = logs
                application = runtime.create_application()
                resource_factory.assert_called_once()
                self.assertEqual(resource_factory.call_args.args[1], PROOF)
                return application, calls, logs
        finally:
            for stream in (sys.stdout, sys.stderr):
                if stream not in (old_out, old_error, logs): stream.close()
            sys.stdout, sys.stderr = old_out, old_error
            logging.disable(old_logging)

    def request(self, application, method='GET'):
        raw = json.dumps({'operationId': OP}).encode() if method == 'POST' else b''
        status = []
        response = b''.join(application({
            'PATH_INFO': negative_resource.PREFIX + ('' if method == 'POST' else '/' + OP),
            'REQUEST_METHOD': method, 'QUERY_STRING': '',
            negative_resource.HEADER: KEY, 'CONTENT_TYPE': 'application/json',
            'CONTENT_LENGTH': str(len(raw)), 'wsgi.input': io.BytesIO(raw),
            'HTTP_X_REQUEST_ID': 'private-factory-fixture',
        }, lambda code, _headers: status.append(code)))
        return status[0], json.loads(response)

    def test_retained_key_mount_reads_original_proof_and_refuses_new_posts(self):
        application, calls, logs = self.build(self.environment())
        self.assertEqual(self.request(application)[0], '200 OK')
        self.assertEqual(self.request(application, 'POST')[1], {'code': 'SCREENING_NEGATIVE_UNAVAILABLE'})
        self.assertEqual(calls, [('read', OP)])
        for secret in (KEY, PROOF, IMPORT_KEY, OP, 'synthetic-fixture-password', 'proofHash'):
            self.assertNotIn(secret, logs.getvalue())
        self.assertEqual(json.loads(logs.getvalue().splitlines()[0])['eventId'],
                         'public-screening.no-order-receipts.read')

    def test_explicit_selector_mounts_post_at_the_existing_private_factory(self):
        environment = self.environment()
        environment['POS_PUBLIC_SCREENING_NEGATIVE_CONTRACT'] = negative_resource.SELECTOR
        application, calls, _logs = self.build(environment)
        self.assertEqual(self.request(application, 'POST')[0], '200 OK')
        self.assertEqual(calls, [('post', OP)])

    def test_wrong_service_key_refuses_before_writer_or_source_bootstrap(self):
        environment = self.environment()
        environment['POS_PUBLIC_SCREENING_NEGATIVE_KEY'] = PROOF
        with patch.dict(os.environ, environment, clear=True), \
             patch('sqlalchemy.create_engine') as engine, \
             patch('source_runtime.SourceRuntime') as source:
            with self.assertRaises(ImportReview): runtime.create_application()
            engine.assert_not_called()
            source.assert_not_called()


if __name__ == '__main__': unittest.main()
