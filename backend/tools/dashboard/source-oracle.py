"""Execute the pinned DashboardView against a synthetic, isolated localhost schema."""
import ast
from calendar import month_abbr
import datetime
from functools import wraps
import hashlib
import json
from pathlib import Path
import re
import sys
from types import SimpleNamespace
from urllib.parse import urlparse, unquote


def main():
    payload = json.load(sys.stdin)
    url = urlparse(payload['database'])
    schema = url.path.lstrip('/')
    if url.scheme != 'mysql' or url.hostname not in ['127.0.0.1', 'localhost'] or not re.fullmatch(r'pos_rewrite_dashboard_[a-f0-9]{12}', schema):
        raise ValueError('ISOLATED_LOCAL_SCHEMA_REQUIRED')
    import django
    import pymysql
    if django.get_version() != '4.2.5':
        raise ValueError('PINNED_SOURCE_DJANGO_REQUIRED')
    pymysql.install_as_MySQLdb()
    from django.conf import settings
    settings.configure(SECRET_KEY='isolated-dashboard-oracle', USE_TZ=False, USE_I18N=False, INSTALLED_APPS=[], DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': schema, 'HOST': url.hostname, 'PORT': str(url.port or 3306), 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''), 'OPTIONS': {'charset': 'utf8mb4'}}})
    django.setup()
    from django.db import models, connection

    class Store(models.Model):
        id = models.BigIntegerField(primary_key=True)
        store_name = models.CharField(max_length=255, null=True)
        is_active = models.BooleanField()
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'stores'; managed = False
    class Operator(models.Model):
        id = models.BigIntegerField(primary_key=True)
        is_active = models.BooleanField()
        role = models.IntegerField()
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'pos_user'; managed = False
    class UserStore(models.Model):
        id = models.BigIntegerField(primary_key=True)
        django_user_id = models.BigIntegerField()
        store_id = models.BigIntegerField()
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'user_stores'; managed = False
    class Product(models.Model):
        id = models.BigIntegerField(primary_key=True)
        parent_prod_id = models.BigIntegerField()
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'products'; managed = False
    class ProductStore(models.Model):
        id = models.BigIntegerField(primary_key=True)
        product = models.ForeignKey(Product, on_delete=models.DO_NOTHING)
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'product_store'; managed = False
    class OrderStatus(models.Model):
        id = models.BigIntegerField(primary_key=True)
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'order_status'; managed = False
    class Order(models.Model):
        id = models.BigIntegerField(primary_key=True)
        order_statuses = models.ForeignKey(OrderStatus, on_delete=models.DO_NOTHING, db_column='order_status', null=True)
        created_at = models.DateTimeField()
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'orders'; managed = False
    class OrderStore(models.Model):
        id = models.BigIntegerField(primary_key=True)
        order = models.ForeignKey(Order, on_delete=models.DO_NOTHING)
        store = models.ForeignKey(Store, on_delete=models.DO_NOTHING)
        class Meta:
            app_label = 'dashboard_oracle'; db_table = 'order_stores'; managed = False

    backend = Path(__file__).resolve().parents[2]
    source = backend.parent.parent / 'backend-pos-web'
    filename = 'dashboard/views.py'
    source_bytes = (source / filename).read_bytes()
    hashes = {value['path']: value['sha256'] for value in json.loads((backend / 'parity/legacy-inventory.json').read_text())['source_hashes']}
    if hashlib.sha256(source_bytes).hexdigest() != hashes[filename]:
        raise ValueError('SOURCE_BASELINE_CHANGED')
    original = next(value for value in ast.parse(source_bytes).body if isinstance(value, ast.ClassDef) and value.name == 'DashboardView')
    class RemovePrint(ast.NodeTransformer):
        def visit_Expr(self, node):
            if isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name) and node.value.func.id == 'print':
                return ast.Pass()
            return self.generic_visit(node)
    methods = [RemovePrint().visit(value) for value in original.body if isinstance(value, ast.FunctionDef)]
    compiled = ast.fix_missing_locations(ast.Module(body=[ast.ClassDef(name='SourceDashboard', bases=[], keywords=[], body=methods, decorator_list=[])], type_ignores=[]))
    queries = []
    class ScopedCursor:
        def __enter__(self):
            self.cursor = connection.cursor(); return self
        def __exit__(self, *args):
            return self.cursor.__exit__(*args)
        def execute(self, query):
            # Only the fixed source schema qualifier changes to the isolated fixture.
            if query.count('tss.order_stores') != 1:
                raise ValueError('UNEXPECTED_SOURCE_SQL')
            return self.cursor.execute(query.replace('tss.order_stores', '`' + schema + '`.order_stores'))
        @property
        def description(self):
            return self.cursor.description
        def fetchall(self):
            return self.cursor.fetchall()
    namespace = {'Store': Store, 'User': Operator, 'UserStore': UserStore, 'ProductStore': ProductStore, 'OrderStore': OrderStore, 'month_abbr': month_abbr, 'SimpleNamespace': SimpleNamespace, 'connections': {'mysql_db': SimpleNamespace(cursor=ScopedCursor)}, 'render': lambda request, template_name, context: context['data']}
    exec(compile(compiled, '<pinned-dashboard-source>', 'exec'), namespace)
    connection.ensure_connection()
    with connection.cursor() as cursor:
        cursor.execute("SET SESSION sql_mode='STRICT_TRANS_TABLES'")
        cursor.execute('SET TIMESTAMP = %s', [int(datetime.datetime.fromisoformat(payload['now'].replace('Z', '+00:00')).timestamp())])
        cursor.execute('SET SESSION TRANSACTION READ ONLY')
    def record_query(execute, sql, params, many, context):
        queries.append(sql)
        return execute(sql, params, many, context)
    results = []
    with connection.execute_wrapper(record_query):
        for case in payload['cases']:
            request = SimpleNamespace(user=SimpleNamespace(id=int(case['operatorId']), role=case['role']))
            view = namespace['SourceDashboard'](); view.request = request
            result = view.get(request)
            if 'order_count' not in result:
                raise ValueError('SOURCE_DASHBOARD_FAILED')
            for key in ['store_count', 'user_count', 'store_product_count', 'order_count']:
                result[key] = str(result[key])
            for row in result['graph_data']['dataset_list']:
                row['data'] = [str(value) for value in row['data']]
            result['django_admin_id'] = str(result['django_admin_id'])
            results.append(result)
    connection.close()
    class ResultCursor:
        def __init__(self, rows):
            self.rows = rows
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, query):
            if 'GROUP BY YEAR(orders.created_at) , MONTH(orders.created_at)' not in query:
                raise ValueError('UNEXPECTED_SOURCE_GRAPH')
        @property
        def description(self):
            return [(name,) for name in ['id', 'orders_count', 'month', 'year']]
        def fetchall(self):
            return [(index + 1, int(row['count']), row['month'], row['year']) for index, row in enumerate(self.rows)]
    projections = []
    for rows in payload.get('groupCases', []):
        namespace['connections'] = {'mysql_db': SimpleNamespace(cursor=lambda: ResultCursor(rows))}
        projections.append([str(value) for value in namespace['SourceDashboard']().get_orders_count(1)])
    decorator_name = 'helpers/decorators.py'
    decorator_bytes = (source / decorator_name).read_bytes()
    if hashlib.sha256(decorator_bytes).hexdigest() != hashes[decorator_name]:
        raise ValueError('SOURCE_DECORATOR_CHANGED')
    decorator = next(value for value in ast.parse(decorator_bytes).body if isinstance(value, ast.FunctionDef) and value.name == 'user_type_exempt')
    permission_namespace = {'json': json, 'wraps': wraps, 'messages': SimpleNamespace(error=lambda *args: None), 'redirect': lambda destination: 'blocked:' + destination}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[decorator], type_ignores=[])), '<pinned-dashboard-permission>', 'exec'), permission_namespace)
    guarded = permission_namespace['user_type_exempt']('[2]')(lambda request: 'allowed')
    permissions = {str(user_type): guarded(SimpleNamespace(user=SimpleNamespace(is_anonymous=False, user_type=user_type))) for user_type in [1, 2]}
    json.dump({'djangoVersion': django.get_version(), 'sourceHash': hashes[filename], 'decoratorHash': hashes[decorator_name], 'permissions': permissions, 'cases': results, 'queries': queries, 'monthProjections': projections}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        json.dump({'error': 'SOURCE_DASHBOARD_ORACLE_FAILED', 'kind': type(error).__name__}, sys.stdout)
        sys.exit(1)
