"""Local-only Node/Python protocol fixture; all source/provider operations are stubbed."""
import io
import json
import os
import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import urlparse
from sqlalchemy import create_engine
from sqlalchemy.engine import URL

BRIDGE = Path(__file__).resolve().parents[3] / 'compatibility/upstream/ecommerce-full-sync'
sys.path.insert(0, str(BRIDGE))
from contract import create_app
from store import CommandStore
from runtime import execute
from worker_fixture import completed_source


def main():
    data = json.load(sys.stdin)
    parsed = urlparse(data['database'])
    if parsed.scheme != 'mysql' or parsed.hostname not in {'localhost','127.0.0.1'} or not parsed.path.startswith('/pos_rewrite_ecommerce_sync_'):
        raise RuntimeError('A randomized localhost fixture is required')
    engine = create_engine(URL.create('mysql+pymysql', username=parsed.username, password=parsed.password or '', host=parsed.hostname, port=parsed.port or 3306, database=parsed.path[1:]), echo=False, hide_parameters=True)
    try:
        store = CommandStore(engine, lambda:data['clock'])
        if data['mode'] == 'worker':
            accepted = store.claim(str(uuid.uuid4()))
            if accepted is None:
                raise RuntimeError('No fixture command claimed')
            source=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT', str(Path(__file__).resolve().parents[5] / 'backend-tss-api_v2')))
            execute(store, accepted, json.dumps({'sourceRoot':str(source)}), threading.Event(), child_target=completed_source)
            print(json.dumps(store.read(accepted['operationId'])))
            return
        req = data['request']; raw = req['body'].encode(); headers = req['headers']
        env = {'PATH_INFO':req['path'],'REQUEST_METHOD':req['method'],'CONTENT_TYPE':'application/json', 'CONTENT_LENGTH':str(len(raw)), 'wsgi.input':io.BytesIO(raw),
            'HTTP_X_ECOM_TIMESTAMP':headers['x-ecom-timestamp'], 'HTTP_X_ECOM_SIGNATURE':headers['x-ecom-signature'], 'HTTP_IDEMPOTENCY_KEY':headers['idempotency-key']}
        result = []
        body = b''.join(create_app(store,data['secret'],lambda:data['clock'])(env,lambda status,values:result.append((int(status.split()[0]),dict(values)))))
        print(json.dumps({'status':result[0][0],'headers':result[0][1],'body':body.decode()}))
    finally:
        engine.dispose()


if __name__ == '__main__':
    main()
