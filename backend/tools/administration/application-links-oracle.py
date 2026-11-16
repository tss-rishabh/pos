"""Hash-verified source QR expiry and customer-link/cache branches; network/database are fixtures."""
import ast
import datetime as native_datetime
import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from zoneinfo import ZoneInfo


def main():
    payload = json.load(sys.stdin)
    backend = Path(__file__).resolve().parents[2]
    source = backend.parent.parent / 'backend-pos-web'
    expected = {item['path']: item['sha256'] for item in json.loads((backend / 'parity/legacy-inventory.json').read_text())['source_hashes']}
    data = (source / 'core/views.py').read_bytes()
    if hashlib.sha256(data).hexdigest() != expected['core/views.py']:
        raise ValueError('SOURCE_BASELINE_CHANGED')
    tree = ast.parse(data.decode())
    results = []
    for case in payload['cases']:
        timestamp = case.get('timestamp', 1794820800000)
        zone = ZoneInfo(case.get('zone', 'UTC'))
        class Clock:
            @staticmethod
            def now():
                return native_datetime.datetime.fromtimestamp(timestamp / 1000, zone)
        if case['operation'] == 'staff-context':
            node = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == 'MposDownloadQr')
            method = next(item for item in node.body if isinstance(item, ast.FunctionDef) and item.name == 'get')
            namespace = {'datetime': SimpleNamespace(datetime=Clock), 'timedelta': native_datetime.timedelta, 'MPOS_DOWNLOAD_QR_EXP_SEC': case['period'], 'pyotp': SimpleNamespace(TOTP=lambda secret, interval: SimpleNamespace(interval=interval, now=lambda: '012345')), 'User': SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: SimpleNamespace(first=lambda: SimpleNamespace(email='fixture@example.test')))), 'render': lambda request, template, context: context}
            exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<source-staff-qr>', 'exec'), namespace)
            request = SimpleNamespace(user=SimpleNamespace(id=7), build_absolute_uri=lambda path: 'https://pos.example.test' + path)
            result = namespace['get'](SimpleNamespace(get_secret=lambda user_id: 'fixture-secret', encodeJwt512=lambda value: 'fixture-token'), request)
            expiry = native_datetime.datetime.strptime(result['auth_otp_time_left'], '%b %d, %Y %H:%M:%S').replace(tzinfo=zone).timestamp() * 1000
            results.append({'expiresAt': int(expiry), 'colorTimes': result['color_time_dic'], 'colors': result['color_val_dic']})
        elif case['operation'] == 'customer-link':
            node = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == 'UserToApp')
            method = next(item for item in node.body if isinstance(item, ast.FunctionDef) and item.name == 'get')
            writes, requests, cache_sets = [], [], []
            cached = case.get('cached')
            redis = SimpleNamespace(exists=lambda key: cached is not None, get=lambda key: cached.encode(), set=lambda key, value, ex: cache_sets.append({'key': key, 'value': value, 'seconds': ex}))
            def post(url, data, headers):
                requests.append({'url': url, 'body': json.loads(data), 'headers': headers})
                return SimpleNamespace(json=lambda: {'object': {'shortLink': case.get('shortLink')}} if case.get('objectPresent', True) else {})
            namespace = {'datetime': SimpleNamespace(datetime=Clock), 'connections': {'mysql_db': SimpleNamespace(cursor=lambda: SimpleNamespace(execute=lambda query: writes.append(query)))}, 'redis_instance': redis, 'MAIN_SITE_API_V2': 'https://api.example.test/v2/', 'POS_APP_REDIRECT': 'https://www.thesouledstore.com', 'requests': SimpleNamespace(post=post), 'json': json, 'redirect': lambda value: value}
            exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), '<source-customer-link>', 'exec'), namespace)
            target = namespace['get'](SimpleNamespace(), SimpleNamespace(GET={'store_id': str(case['storeId'])}))
            matched = re.search(r"VALUES \(([^,]+), '([^']+)'\)", writes[0])
            results.append({'destination': target, 'requests': requests, 'cacheSets': cache_sets, 'loggedStore': matched.group(1), 'scannedAt': matched.group(2)})
        else:
            raise ValueError('SOURCE_ORACLE_OPERATION_UNSUPPORTED')
    json.dump({'sourceHash': expected['core/views.py'], 'cases': results}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        json.dump({'error': 'SOURCE_APPLICATION_LINK_ORACLE_FAILED'}, sys.stdout)
        sys.exit(1)
