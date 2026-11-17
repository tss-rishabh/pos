"""Actual pinned task selection/order only; opaque routine/network calls are captured, never executed."""
import ast
import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import urlparse, unquote


def main():
    payload=json.load(sys.stdin)
    url=urlparse(payload['database']);database=url.path.lstrip('/')
    if url.scheme!='mysql' or url.hostname not in ['localhost','127.0.0.1'] or not re.fullmatch(r'pos_rewrite_ecommerce_sync_[a-f0-9]{12}',database):raise ValueError('ISOLATED_LOCAL_SCHEMA_REQUIRED')
    import django
    import pymysql
    if django.get_version()!='4.2.5':raise ValueError('PINNED_DJANGO_REQUIRED')
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    settings.configure(SECRET_KEY='ecommerce-fixture',USE_TZ=False,USE_I18N=False,INSTALLED_APPS=[],DATABASES={'default':{'ENGINE':'django.db.backends.mysql','NAME':database,'HOST':url.hostname,'PORT':str(url.port or 3306),'USER':unquote(url.username or ''),'PASSWORD':unquote(url.password or ''),'OPTIONS':{'charset':'utf8mb4','init_command':"SET sql_mode='STRICT_TRANS_TABLES'"}}})
    django.setup()
    from django.db import models,connection
    class Store(models.Model):
        id=models.BigIntegerField(primary_key=True)
        is_active=models.BooleanField()
        ecom_threshold=models.IntegerField(null=True)
        class Meta:app_label='ecommerce_source';db_table='stores';managed=False
    class ProductStore(models.Model):
        id=models.BigIntegerField(primary_key=True)
        product_id=models.BigIntegerField()
        store_id=models.BigIntegerField()
        stock=models.IntegerField()
        class Meta:app_label='ecommerce_source';db_table='product_store';managed=False
    backend=Path(__file__).resolve().parents[3];source=backend.parent.parent/'backend-pos-web'
    hashes={row['path']:row['sha256']for row in json.loads((backend/'parity/legacy-inventory.json').read_text())['source_hashes']}
    data=(source/'core/tasks.py').read_bytes()
    if hashlib.sha256(data).hexdigest()!=hashes['core/tasks.py']:raise ValueError('SOURCE_BASELINE_CHANGED')
    tree=ast.parse(data);nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef)and node.name in ['sync_ecom_inventory','full_ecom_product_sync']]
    for node in nodes:node.decorator_list=[]
    calls=[];http=[];errors=[]
    class Cursor:
        def execute(self,statement):
            match=re.fullmatch(r'call pos_stock_syncer_bk\((\d+), (\d+), \'(-?\d+)\', 0, 0, "Updated by System"\);',statement)
            if not match:raise ValueError('UNEXPECTED_SOURCE_SQL')
            store,product,stock=match.groups();calls.append({'storeId':store,'productId':product,'stock':int(stock),'operatorId':'0','comment':'Updated by System'})
            if len(calls)==payload.get('failAfter'):raise RuntimeError('fixture-only failure')
    namespace={'Store':Store,'ProductStore':ProductStore,'connections':{'mysql_db':SimpleNamespace(cursor=lambda:Cursor())},'MAIN_API_V2_URL':'https://fixture.invalid/','requests':SimpleNamespace(get=lambda url:(http.append({'url':url,'status':payload.get('httpStatus',200)})or SimpleNamespace(status_code=payload.get('httpStatus',200)))),'logger':SimpleNamespace(exception=lambda *args:errors.append('SOURCE_SWALLOWED_ERROR'))}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'<pinned-ecommerce-source>','exec'),namespace)
    namespace['sync_ecom_inventory'](int(payload.get('storeId','1')))
    connection.close();json.dump({'calls':calls,'http':http,'errors':errors,'sourceHash':hashes['core/tasks.py']},sys.stdout)


if __name__=='__main__':
    try:main()
    except Exception as failure:json.dump({'error':'ECOMMERCE_SOURCE_ORACLE_FAILED','kind':type(failure).__name__},sys.stdout);sys.exit(1)
