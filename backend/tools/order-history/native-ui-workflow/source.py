"""Original dispatch/POST/ORM/check-in oracle on an explicitly owned native fixture.

Authoring candidate. No original environment, providers, ORM or HTTP responses
are replaced. HTTP established identity and unused project bootstrap remain a
named carrier boundary. Full detail/helper/template assembly is still pending.
"""
import ast
from contextlib import redirect_stdout
import datetime
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import subprocess
import sys
import types
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
ROOT = Path(os.environ['ORDER_UI_SOURCE_ROOT']).resolve()
INPUTS = ['order/datatables/orders_datatable.py', 'order/views.py', 'order/urls.py',
          'order/models.py', 'helpers/helpers.py', 'helpers/terminal_helpers.py',
          'POSAdmin/connection_handler.py', 'order/templates/order/index.html']


def blob(path):
    return subprocess.check_output(['git', '-C', str(ROOT), 'show', PIN + ':' + path],
                                   stderr=subprocess.DEVNULL)


def definition(path, name):
    return next(node for node in ast.parse(blob(path)).body
                if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name)


def execute(node, namespace):
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                 '<pinned-original-orders>', 'exec'), namespace)


class NativeIdentityMiddleware:
    def __init__(self, response):
        self.response = response

    def __call__(self, request):
        from django.db import connection
        actor = request.COOKIES.get('order_source_actor', '')
        row = None
        if re.fullmatch(r'[1-9]\d{0,9}', actor):
            with connection.cursor() as cursor:
                cursor.execute('SELECT id,role,user_type,is_active FROM pos_user WHERE id=%s', [actor])
                row = cursor.fetchone()
        request.user = SimpleNamespace(id=row[0] if row and row[3] else None,
                                       role=row[1] if row and row[3] else None,
                                       user_type=row[2] if row and row[3] else None,
                                       is_authenticated=bool(row and row[3]))
        return self.response(request)


def configure(body):
    database, redis_url = urlsplit(body['database']), urlsplit(body['redis'])
    if (database.scheme != 'mysql' or database.hostname != '127.0.0.1'
            or not database.port or database.port == 54777 or database.query or database.fragment
            or not re.fullmatch(r'/pos_rewrite_order_ui_[a-f0-9]{12}', database.path)):
        raise ValueError('OWNED_NATIVE_SOURCE_REQUIRED')
    if (redis_url.scheme != 'redis' or redis_url.hostname != '127.0.0.1'
            or not redis_url.port or redis_url.query or redis_url.fragment or redis_url.path not in ['', '/0']):
        raise ValueError('OWNED_SOURCE_REDIS_REQUIRED')
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    from django.apps import AppConfig
    package = types.ModuleType('order_ui_source')
    package.__path__ = [str(Path(__file__).parent)]
    apps = types.ModuleType('order_ui_source.apps')

    class NativeSourceConfig(AppConfig):
        name = 'order_ui_source'
        path = str(Path(__file__).parent)

    apps.NativeSourceConfig = NativeSourceConfig
    sys.modules['order_ui_source'] = package
    sys.modules['order_ui_source.apps'] = apps
    connection = {'ENGINE': 'django.db.backends.mysql', 'NAME': database.path[1:],
                  'HOST': database.hostname, 'PORT': database.port,
                  'USER': unquote(database.username or ''), 'PASSWORD': unquote(database.password or ''),
                  'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}
    settings.configure(SECRET_KEY='owned-original-order-ui-carrier', USE_TZ=False,
        USE_I18N=False, TIME_ZONE='Asia/Kolkata', LOGGING_CONFIG=None,
        ALLOWED_HOSTS=['testserver', '127.0.0.1'], ROOT_URLCONF='order_ui_urls',
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'order_ui_source.apps.NativeSourceConfig'],
        MIDDLEWARE=[__name__ + '.NativeIdentityMiddleware'],
        STATIC_URL='/source-static/',
        TEMPLATES=[{'BACKEND':'django.template.backends.django.DjangoTemplates','OPTIONS':{
            'context_processors':['django.template.context_processors.request'],
            'loaders':[('django.template.loaders.locmem.Loader', {
                'order/index.html':blob('order/templates/order/index.html').decode(),
                # Deliberately excluded shared shell; original feature blocks are intact.
                'admin/layouts/base.html':'<!doctype html><html><head>{% block title %}{% endblock %}</head><body>{% block maincontent %}{% endblock %}{% block custom-script %}{% endblock %}</body></html>'
            })]}}],
        DATABASES={alias: dict(connection) for alias in ['default', 'mysql_db']})
    django.setup()
    logging.disable(logging.CRITICAL)
    from django.db import models, connections
    from django.db.models import Q
    from django.views import View
    from django.contrib.auth.mixins import LoginRequiredMixin
    from django.core.paginator import Paginator, EmptyPage, PageNotAnInteger
    from django.core.serializers.json import DjangoJSONEncoder
    from django.http import HttpResponse
    from django.shortcuts import render
    import redis
    namespace = {'models': models, 'datetime': datetime, 'json': json, 'Q': Q,
        'View': View, 'LoginRequiredMixin': LoginRequiredMixin,
        'Paginator': Paginator, 'EmptyPage': EmptyPage, 'PageNotAnInteger': PageNotAnInteger,
        'DjangoJSONEncoder': DjangoJSONEncoder, 'HttpResponse': HttpResponse, 'render':render,
        'READ_DB_ALIAS': 'mysql_db', 'connections': connections,
        'redis_instance': redis.Redis.from_url(body['redis'])}
    execute(definition('order/models.py', 'LegacyForeignKey'), namespace)
    foreign = namespace['LegacyForeignKey']

    def model(name, table, fields):
        meta = type('Meta', (), {'app_label': 'order_ui_source', 'db_table': table, 'managed': False})
        result = type(name, (models.Model,), {'__module__': __name__, 'Meta': meta,
            'id': models.BigIntegerField(primary_key=True), **fields})
        namespace[name] = result
        return result

    text = lambda **kwargs: models.CharField(max_length=255, **kwargs)
    user = model('MUser', 'users', {key: text() for key in ['firstname', 'lastname', 'telephone', 'email']})
    store = model('Store', 'stores', {'store_name': text(null=True), 'location_code': text(null=True),
        'is_active': models.BooleanField(), 'franchise_id': models.IntegerField(), 'category': text(), 'type': text()})
    counter = model('StoreCounter', 'store_counters', {'counter_name': text(null=True)})
    method = model('PaymentMethod', 'payment_method', {'name': text(null=True)})
    paid = model('PaymentStatus', 'payment_status', {'payment_status': text()})
    status = model('OrderStatus', 'order_status', {'order_status': text()})
    order = model('Order', 'orders', {
        'user': models.ForeignKey(user, on_delete=models.DO_NOTHING, db_column='user_id'),
        'payment_methods': foreign(method, on_delete=models.DO_NOTHING, db_column='payment_method', null=True),
        'payment_statuses': foreign(paid, on_delete=models.DO_NOTHING, db_column='payment_status', null=True),
        'order_statuses': foreign(status, on_delete=models.DO_NOTHING, db_column='order_status', null=True),
        'order_ref_no': text(), 'phone_no': text(), 'order_amt': models.FloatField(), 'pay_amt': models.FloatField(),
        'created_at': models.DateTimeField(), 'location_id': models.IntegerField(null=True), 'location_type': text(),
        'is_transfer': models.IntegerField(null=True), 'next_location_ids': text(null=True), 'is_global_order': models.IntegerField()})
    model('OrderStore', 'order_stores', {
        'order': models.ForeignKey(order, on_delete=models.DO_NOTHING, db_column='order_id', related_name='order_store'),
        'store': models.ForeignKey(store, on_delete=models.DO_NOTHING, db_column='store_id'),
        'counter': models.ForeignKey(counter, on_delete=models.DO_NOTHING, db_column='counter_id'),
        'offline_payment': models.FloatField(), 'online_other_payment': models.FloatField(),
        **{key: models.BooleanField() for key in ['is_manually_paid', 'is_offline_order', 'is_shopify_order']}})
    model('HasProduct', 'has_products', {'order': models.ForeignKey(order, on_delete=models.DO_NOTHING,
        db_column='order_id', related_name='hp_order'), 'status': text()})
    model('HyperlocalOrderLog', 'hyperlocal_order_log', {'order_id': models.BigIntegerField(), 'action': text(),
        **{key: models.IntegerField() for key in ['is_pack', 'is_rto', 'is_refunded']}})
    model('ExpressLineItem', 'express_line_item', {'order_id': models.BigIntegerField(), 'store_id': models.IntegerField(null=True),
        'status': text(), 'pending_expires_at': models.DateTimeField(), 'accepted_expires_at': models.DateTimeField()})
    model('HyperlocalLocation', 'hyperlocal_locations', {'location_code': text(null=True)})
    for name, table in [('PosTerminalTransaction', 'pos_terminal_transactions'), ('PosPaytmTransaction', 'pos_paytm_transactions')]:
        model(name, table, {'order_id': models.BigIntegerField(), 'platform': text(), 'is_active': models.BooleanField(),
            'payment_mode': models.IntegerField(), 'plutus_id' if name == 'PosTerminalTransaction' else 'paytm_mid': text()})
    model('UserStore','user_stores',{'django_user_id':models.BigIntegerField(),'store_id':models.IntegerField()})
    model('PosTerminalPaymentModes','pos_terminal_payment_modes',{'is_active':models.BooleanField(),'platform':text(),'name':text(),'mode_id':models.IntegerField()})
    terminal=definition('helpers/terminal_helpers.py','TerminalHelper')
    terminal.body=[node for node in terminal.body if isinstance(node,ast.FunctionDef) and node.name=='get_payment_mode']
    execute(terminal,namespace)
    execute(definition('order/views.py','_hl_get_tab_counts'),namespace)
    for name in ['OrdersView','OnlineOrdersView']:
        execute(definition('order/views.py',name),namespace)
    helper = definition('helpers/helpers.py', 'Helpers')
    helper.body = [node for node in helper.body if isinstance(node, ast.FunctionDef) and node.name in
        ['get_store_location_name', 'get_transaction_id', 'get_checkin_data', 'get_days_before_after_datetime']]
    execute(helper, namespace)
    # Retain complete original class bases and POST serialization, unlike the
    # older direct-datatables oracle. No helper or authorization method is replaced.
    execute(definition('order/datatables/orders_datatable.py', 'AjaxOrderListView'), namespace)
    from django.urls import path
    from asgiref.sync import SyncToAsync
    from django.db import close_old_connections
    namespace.update(path=path, SyncToAsync=SyncToAsync, close_old_connections=close_old_connections,
        orders_datatable=SimpleNamespace(AjaxOrderListView=namespace['AjaxOrderListView']),
        order_views=SimpleNamespace(OrdersView=namespace['OrdersView'],OnlineOrdersView=namespace['OnlineOrdersView']))
    execute(definition('POSAdmin/connection_handler.py', 'DatabaseSyncToAsync'), namespace)
    namespace['sync_to_async'] = namespace['DatabaseSyncToAsync']
    module = types.ModuleType('order_ui_urls')
    declarations = [node for node in ast.walk(ast.parse(blob('order/urls.py')))
        if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant)
        and node.args[0].value in ['ajax-order-list/','store/','online/']]
    if len(declarations)!=3:raise ValueError('ORIGINAL_ORDER_ROUTE_SET_CHANGED')
    original_routes=[eval(compile(ast.fix_missing_locations(ast.Expression(body=node)),
        '<original-order-url-binding>','eval'),namespace) for node in declarations]
    # Inert URL reversing for excluded financial/shared-shell controls. Any call
    # fails rather than substituting a business response.
    from django.http import HttpResponseNotAllowed
    def excluded(request,*args,**kwargs):return HttpResponseNotAllowed([])
    names=['tab','hyperlocal_progress','ajax_hyperlocal_progress_content',
        'ajax-transaction-status-check-paytm','ajax-transaction-status-check',
        'paytm-ajax-transaction-cancel','ajax-transaction-cancel',
        'ajax-get-payment-mode-by-order-id']
    module.urlpatterns = [path('orders/', __import__('django.urls', fromlist=['include']).include(original_routes))]
    module.urlpatterns += [path('excluded/'+name+'/',excluded,name=name) for name in names]
    sys.modules[module.__name__] = module
    return namespace


def main():
    body = json.load(sys.stdin)
    namespace = configure(body)
    if body['action'] not in ['dispatch','view']:
        raise ValueError('UNASSEMBLED_ORIGINAL_DETAIL_PATH')
    from django.test import Client
    from django.db import connections
    client = Client(enforce_csrf_checks=True, raise_request_exception=False)
    actor = body.get('actor')
    if actor is not None:
        client.cookies['order_source_actor'] = str(actor)
    with redirect_stdout(io.StringIO()):
        if body['action']=='dispatch':
            response = client.generic('POST', '/orders/ajax-order-list/', data=body['serialized'],
                                      content_type='application/x-www-form-urlencoded')
        else:
            route=body.get('route','store')
            if route not in ['store','online']:raise ValueError('UNREVIEWED_SOURCE_ROUTE')
            if body.get('method','GET')=='GET':
                response=client.get('/orders/'+route+'/')
            else:
                response=client.generic('POST','/orders/'+route+'/',data=body['serialized'],
                    content_type='application/x-www-form-urlencoded')
    try:
        value = json.loads(response.content)
    except (ValueError, UnicodeDecodeError):
        value = None
    connections.close_all()
    print(json.dumps({'status': response.status_code, 'body': value,
        'location': response.get('Location'),
        'html':response.content.decode() if body['action']=='view' else None,
        'mro': [item.__name__ for item in namespace['AjaxOrderListView'].__mro__],
        'sourceHashes': {path: hashlib.sha256(blob(path)).hexdigest() for path in INPUTS}}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('OWNED_ORIGINAL_ORDER_UI_UNAVAILABLE\n')
        raise SystemExit(1)
