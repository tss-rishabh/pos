"""Pinned original datatable, real Django/MySQL ORM, synthetic local read-only fixture only."""
import ast
import datetime
import json
import os
import pathlib
import re
import subprocess
import sys
import types
from urllib.parse import urlsplit, unquote

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
ROOT = pathlib.Path(os.environ.get('ORDER_SEARCH_SOURCE_ROOT', '../../backend-pos-web')).resolve()

def source(path):
    return subprocess.check_output(['git', '-C', str(ROOT), 'show', PIN + ':' + path], stderr=subprocess.DEVNULL).decode()

def node(path, name, parent=None):
    tree = ast.parse(source(path))
    nodes = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == parent).body if parent else tree.body
    return next(n for n in nodes if getattr(n, 'name', None) == name)

def main():
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    from django.apps import AppConfig
    body = json.load(sys.stdin)
    url = urlsplit(body['url'])
    if url.scheme != 'mysql' or url.hostname not in ('127.0.0.1', 'localhost') or not re.fullmatch(r'pos_rewrite_order_search_[a-zA-Z0-9_]+', url.path[1:]):
        raise ValueError('Invalid synthetic fixture.')
    package = types.ModuleType('order_search_oracle')
    package.__path__ = [str(pathlib.Path(__file__).parent)]
    apps_module = types.ModuleType('order_search_oracle.apps')
    class OracleConfig(AppConfig):
        name = 'order_search_oracle'
        path = str(pathlib.Path(__file__).parent)
    apps_module.OracleConfig = OracleConfig
    sys.modules['order_search_oracle'] = package
    sys.modules['order_search_oracle.apps'] = apps_module
    settings.configure(INSTALLED_APPS=['order_search_oracle.apps.OracleConfig'], DATABASES={'default': {
        'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:], 'HOST': url.hostname,
        'PORT': url.port or 3306, 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''),
        'OPTIONS': {'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"},
    }}, USE_TZ=False, USE_I18N=False, SECRET_KEY='synthetic-fixture-only')
    django.setup()
    from django.db import models, connection
    from django.db.models import Q
    from django.core.paginator import Paginator, EmptyPage, PageNotAnInteger
    namespace = {'models': models}
    exec(compile(ast.Module(body=[node('order/models.py', 'LegacyForeignKey')], type_ignores=[]), '<pinned-source-fk>', 'exec'), namespace)
    LegacyForeignKey = namespace['LegacyForeignKey']
    def model(name, table, fields):
        meta = type('Meta', (), {'app_label': 'order_search_oracle', 'db_table': table, 'managed': False})
        return type(name, (models.Model,), {'__module__': __name__, 'Meta': meta, 'id': models.BigIntegerField(primary_key=True), **fields})
    text = lambda **kwargs: models.CharField(max_length=255, **kwargs)
    User = model('MUser', 'users', {key: text() for key in ['firstname','lastname','telephone','email']})
    Store = model('Store', 'stores', {'store_name': text(null=True), 'location_code': text(null=True)})
    Counter = model('StoreCounter', 'store_counters', {'counter_name': text(null=True)})
    Method = model('PaymentMethod', 'payment_method', {'name': text(null=True)})
    Paid = model('PaymentStatus', 'payment_status', {'payment_status': text()})
    Status = model('OrderStatus', 'order_status', {'order_status': text()})
    Order = model('Order', 'orders', {
        'user': models.ForeignKey(User, on_delete=models.DO_NOTHING, db_column='user_id'),
        'payment_methods': LegacyForeignKey(Method, on_delete=models.DO_NOTHING, db_column='payment_method', null=True),
        'payment_statuses': LegacyForeignKey(Paid, on_delete=models.DO_NOTHING, db_column='payment_status', null=True),
        'order_statuses': LegacyForeignKey(Status, on_delete=models.DO_NOTHING, db_column='order_status', null=True),
        'order_ref_no': text(), 'phone_no': text(), 'order_amt': models.FloatField(), 'pay_amt': models.FloatField(),
        'created_at': models.DateTimeField(), 'location_id': models.IntegerField(null=True), 'location_type': text(),
        'is_transfer': models.IntegerField(null=True), 'next_location_ids': text(null=True), 'is_global_order': models.IntegerField(),
    })
    model('OrderStore', 'order_stores', {
        'order': models.ForeignKey(Order, on_delete=models.DO_NOTHING, db_column='order_id', related_name='order_store'),
        'store': models.ForeignKey(Store, on_delete=models.DO_NOTHING, db_column='store_id'),
        'counter': models.ForeignKey(Counter, on_delete=models.DO_NOTHING, db_column='counter_id'),
        'offline_payment': models.FloatField(), 'online_other_payment': models.FloatField(),
        **{key: models.BooleanField() for key in ['is_manually_paid','is_offline_order','is_shopify_order']},
    })
    model('HasProduct', 'has_products', {'order': models.ForeignKey(Order, on_delete=models.DO_NOTHING, db_column='order_id', related_name='hp_order'), 'status': text()})
    Log = model('HyperlocalOrderLog', 'hyperlocal_order_log', {
        'order_id': models.BigIntegerField(), 'action': text(), **{key: models.IntegerField() for key in ['is_pack','is_rto','is_refunded']},
    })
    Express = model('ExpressLineItem', 'express_line_item', {'order_id': models.BigIntegerField(), 'store_id': models.IntegerField(null=True)})
    Location = model('HyperlocalLocation', 'hyperlocal_locations', {'location_code': text(null=True)})
    provider_fields = {'order_id': models.BigIntegerField(), 'platform': text(), 'is_active': models.BooleanField(), 'payment_mode': models.IntegerField()}
    Terminal = model('PosTerminalTransaction', 'pos_terminal_transactions', {**provider_fields, 'plutus_id': text()})
    Paytm = model('PosPaytmTransaction', 'pos_paytm_transactions', {**provider_fields, 'paytm_mid': text()})
    env = dict(datetime=datetime, Q=Q, Order=Order, HyperlocalOrderLog=Log, ExpressLineItem=Express, Store=Store,
        HyperlocalLocation=Location, PosTerminalTransaction=Terminal, PosPaytmTransaction=Paytm,
        Paginator=Paginator, EmptyPage=EmptyPage, PageNotAnInteger=PageNotAnInteger)
    helpers = node('helpers/helpers.py', 'Helpers')
    methods = [n for n in helpers.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in ['get_store_location_name','get_transaction_id']]
    helper_class = ast.ClassDef(name='Helpers', bases=[], keywords=[], body=methods, decorator_list=[])
    exec(compile(ast.fix_missing_locations(ast.Module(body=[helper_class], type_ignores=[])), '<pinned-source-helpers>', 'exec'), env)
    env['Helpers'].get_checkin_data = staticmethod(lambda _actor: (body.get('checkedInStoreId', 1),))
    view = node('order/datatables/orders_datatable.py', 'AjaxOrderListView')
    view.bases = []
    view.body = [n for n in view.body if getattr(n, 'name', '') != 'post']
    exec(compile(ast.fix_missing_locations(ast.Module(body=[view], type_ignores=[])), '<pinned-source-datatable>', 'exec'), env)
    class Post(dict):
        def getlist(self, key):
            return self.get(key, [])
    with connection.cursor() as cursor:
        cursor.execute('SET SESSION TRANSACTION READ ONLY')
    results = []
    for case in body['cases']:
        data = Post(case)
        request = types.SimpleNamespace(POST=data, user=types.SimpleNamespace(id=1, user_type=body.get('userType', 1)))
        instance = env['AjaxOrderListView']()
        instance.request = request
        query_count = [0]
        def count(execute, sql, params, many, context):
            query_count[0] += 1
            return execute(sql, params, many, context)
        with connection.execute_wrapper(count):
            result = instance.datatables(request)
        for row in result['data']:
            for key in ['id','user_id','payment_methods__id','counter_id','plutus_id','paytm_mid','DT_RowId']:
                row[key] = str(row[key])
        result['recordsTotal'] = str(result['recordsTotal'])
        result['recordsFiltered'] = str(result['recordsFiltered'])
        results.append({'response': result, 'queries': query_count[0]})
    connection.close()
    print(json.dumps(results, ensure_ascii=True))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Even local fixture errors may contain SQL/contact input. Keep output static.
        sys.stderr.write('SOURCE_ORDER_LIST_ORACLE_FAILED\n')
        sys.exit(1)
