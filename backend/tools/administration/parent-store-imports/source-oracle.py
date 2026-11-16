"""Execute the pinned CSV task on synthetic localhost rows; never executes a stored routine.

The source CALL is captured and its requested zero reflected in product_store only.
This proves task selection/order/association behavior, not deployed-procedure parity.
"""
import ast
import copy
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import urlparse, unquote


def main():
    payload = json.load(sys.stdin)
    url = urlparse(payload['database'])
    database = url.path.lstrip('/')
    if url.scheme != 'mysql' or url.hostname not in ['127.0.0.1', 'localhost'] or not re.fullmatch(r'pos_rewrite_parent_import_[a-f0-9]{12}', database):
        raise ValueError('ISOLATED_LOCAL_SCHEMA_REQUIRED')
    import django
    import pymysql
    if django.get_version() != '4.2.5':
        raise ValueError('PINNED_DJANGO_REQUIRED')
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    settings.configure(SECRET_KEY='parent-store-fixture', USE_TZ=False, USE_I18N=False, INSTALLED_APPS=[], DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': database, 'HOST': url.hostname, 'PORT': str(url.port or 3306), 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''), 'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}})
    django.setup()
    from django.db import models, connection
    from django.db.models import Q

    class Product(models.Model):
        id = models.BigIntegerField(primary_key=True)
        parent_prod_id = models.BigIntegerField()
        prod_type = models.BigIntegerField()
        is_del = models.BooleanField()
        class Meta:
            app_label = 'parent_store_oracle'
            db_table = 'products'
            managed = False

    class Store(models.Model):
        id = models.BigIntegerField(primary_key=True)
        is_active = models.BooleanField()
        class Meta:
            app_label = 'parent_store_oracle'
            db_table = 'stores'
            managed = False

    class UserStore(models.Model):
        id = models.BigIntegerField(primary_key=True)
        django_user_id = models.BigIntegerField()
        store_id = models.BigIntegerField()
        class Meta:
            app_label = 'parent_store_oracle'
            db_table = 'user_stores'
            managed = False

    class ProductStore(models.Model):
        id = models.BigIntegerField(default=0, primary_key=True)
        product = models.ForeignKey(Product, on_delete=models.DO_NOTHING)
        store = models.ForeignKey(Store, on_delete=models.DO_NOTHING)
        stock = models.IntegerField(default=0)
        is_avail = models.BooleanField(default=True)
        is_del = models.BooleanField(default=False)
        class Meta:
            app_label = 'parent_store_oracle'
            db_table = 'product_store'
            managed = False

    calls = []
    deliveries = []
    upload = SimpleNamespace(filename=SimpleNamespace(url='fixture://csv'), is_imported=0, message='', failed_data='[]', save=lambda: None)
    uploads = SimpleNamespace(objects=SimpleNamespace(filter=lambda **kwargs: SimpleNamespace(first=lambda: upload)))

    class CaptureCursor:
        def execute(self, statement):
            match = re.fullmatch(r"call tss.pos_stock_syncer\((\d+), (\d+), (\d+), (\d+), (\d+), '([^']*)'\);", statement)
            if not match:
                raise ValueError('UNEXPECTED_SOURCE_SQL')
            store, product, stock, user, actor, comment = match.groups()
            calls.append({'storeId': store, 'productId': product, 'stock': int(stock), 'userId': user, 'operatorId': actor, 'comment': comment})
            if payload.get('failProjection'):
                raise RuntimeError('fixture opaque routine unavailable')
            ProductStore.objects.filter(store_id=int(store), product_id=int(product)).update(stock=int(stock))

    backend = Path(__file__).resolve().parents[3]
    source = backend.parent.parent / 'backend-pos-web'
    hashes = {row['path']: row['sha256'] for row in json.loads((backend / 'parity/legacy-inventory.json').read_text())['source_hashes']}
    def pinned(filename):
        data = (source / filename).read_bytes()
        if hashlib.sha256(data).hexdigest() != hashes[filename]:
            raise ValueError('SOURCE_BASELINE_CHANGED')
        return ast.parse(data)
    tasks = pinned('helpers/task_helpers.py')
    helpers = pinned('helpers/helpers.py')
    live = next(row for row in next(row for row in helpers.body if isinstance(row, ast.ClassDef) and row.name == 'Helpers').body if isinstance(row, ast.FunctionDef) and row.name == 'live_variant_ids')
    helper = ast.ClassDef(name='Helpers', bases=[], keywords=[], body=[live], decorator_list=[])
    generic = next(row for row in tasks.body if isinstance(row, ast.ClassDef) and row.name == 'GenericHelper')
    importer = next(row for row in tasks.body if isinstance(row, ast.ClassDef) and row.name == 'ProductStoreParseCSV')
    namespace = {'Product': Product, 'Store': Store, 'UserStore': UserStore, 'ProductStore': ProductStore, 'CsvUpload': uploads, 'copy': copy, 'csv': csv, 'json': json, 'Q': Q, 'urllib': SimpleNamespace(request=SimpleNamespace(urlopen=lambda _: io.BytesIO(payload['csv'].encode('utf8')))), 'logger': SimpleNamespace(error=lambda *args: None, exception=lambda *args: None), 'connections': {'mysql_db': SimpleNamespace(cursor=lambda: CaptureCursor())}, 'requests': SimpleNamespace(post=lambda url, **kwargs: (deliveries.append(kwargs['json']) or SimpleNamespace(status_code=200))), 'MIGRATION_TO_API_V2': True, 'MAIN_API_V2_URL': 'https://fixture.invalid/', 'API_V2_URL': 'https://fixture.invalid/', 'PRODUCT_SYNC_URI': 'products'}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[helper, generic, importer], type_ignores=[])), '<pinned-parent-store-source>', 'exec'), namespace)
    error = None
    try:
        namespace['ProductStoreParseCSV'](1, int(payload.get('operatorId', '900001')), int(payload.get('role', 1))).product_store_bulk_csv_import()
    except Exception as failure:
        error = type(failure).__name__
    state = list(ProductStore.objects.order_by('store_id', 'product_id').values('store_id', 'product_id', 'stock', 'is_avail', 'is_del'))
    for row in state:
        row['store_id'] = str(row['store_id'])
        row['product_id'] = str(row['product_id'])
    failed = json.loads(upload.failed_data)
    for row in failed:
        row.pop('other_error', None)
    connection.close()
    json.dump({'hashes': {name: hashes[name] for name in ['helpers/task_helpers.py', 'helpers/helpers.py']}, 'state': state, 'calls': calls, 'deliveries': deliveries, 'failed': failed, 'imported': upload.is_imported, 'message': upload.message, 'error': error}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        json.dump({'error': 'PARENT_STORE_SOURCE_ORACLE_FAILED', 'kind': type(failure).__name__}, sys.stdout)
        sys.exit(1)
