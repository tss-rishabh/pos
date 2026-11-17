"""Importable multiprocessing test target. No production configuration uses this."""
import json
import time
from source_io_fixture import source_io
from source_runner import verified_source


def completed_source(raw, connection):
    try:
        config = json.loads(raw)
        verified_source(config['sourceRoot'])
        if config.get('mode') == 'slow':
            time.sleep(20)
        run, _events, _tracker = source_io(cdn_status=500 if config.get('mode') == 'cdn-failure' else 201)
        proof = run([{'id': index, 'product_slug': 'fixture-' + str(index), 'stock': 17} for index in range(1, 4)])
        connection.send({'proof': proof})
    except BaseException:
        connection.send({'error': 'ECOMMERCE_FULL_SYNC_IO_UNCERTAIN'})
    finally:
        connection.close()
