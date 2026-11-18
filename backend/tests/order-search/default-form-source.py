"""Focused original GET/form POST controls on owned native MySQL and Redis.

Shared shell and identity establishment are explicit carriers. Full original
OrdersView MRO/get/post, Helpers check-in, ORM and feature template are executed.
No payment, return, exchange or other excluded URL can execute here.
"""
import ast
from contextlib import redirect_stdout
import datetime
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import types
from urllib.parse import urlsplit, unquote
PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'

def main():
    body = json.load(sys.stdin)
    root = Path(os.environ['ORDER_SEARCH_SOURCE_ROOT']).resolve()

    def blob(path):
        return subprocess.check_output(['git', '-C', str(root), 'show', PIN + ':' + path], stderr=subprocess.DEVNULL).decode()

    def definition(path, name):
        return next((n for n in ast.parse(blob(path)).body if isinstance(n, (ast.ClassDef, ast.FunctionDef)) and n.name == name))
    url = urlsplit(body['url'])
    broker = urlsplit(body['redis'])
    if url.scheme != 'mysql' or url.hostname != '127.0.0.1' or (not url.port) or (url.port == 54777) or (not re.fullmatch('/pos_rewrite_order_search_[A-Za-z0-9_]+', url.path)):
        raise ValueError('OWNED_NATIVE_REQUIRED')
    if broker.scheme != 'redis' or broker.hostname != '127.0.0.1' or (not broker.port) or (broker.path not in ['', '/0']) or broker.query or broker.fragment:
        raise ValueError('OWNED_REDIS_REQUIRED')
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    from django.apps import AppConfig

    class App(AppConfig):
        name = 'order_form_original'
        path = str(Path(__file__).parent)
    package = types.ModuleType('order_form_original')
    package.__path__ = [str(Path(__file__).parent)]
    apps = types.ModuleType('order_form_original.apps')
    apps.App = App
    sys.modules[package.__name__] = package
    sys.modules[apps.__name__] = apps
    db = {'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:], 'HOST': url.hostname, 'PORT': url.port, 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''), 'OPTIONS': {'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}
    settings.configure(SECRET_KEY='synthetic-form-carrier', USE_TZ=False, USE_I18N=False, TIME_ZONE='Asia/Kolkata', STATIC_URL='/static/', ROOT_URLCONF='order_form_urls', INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'order_form_original.apps.App'], DATABASES={'default': db, 'mysql_db': dict(db)}, TEMPLATES=[{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'OPTIONS': {'context_processors': ['django.template.context_processors.request'], 'loaders': [('django.template.loaders.locmem.Loader', {'order/index.html': blob('order/templates/order/index.html'), 'admin/layouts/base.html': '{% block maincontent %}{% endblock %}{% block custom-script %}{% endblock %}'})]}}])
    django.setup()
    from django.db import models, connection, connections
    from django.views import View
    from django.contrib.auth.mixins import LoginRequiredMixin
    from django.shortcuts import render
    from django.urls import path
    from django.test import RequestFactory
    from django.http import HttpResponseNotAllowed
    import redis
    namespace = {'datetime': datetime, 'json': json, 'View': View, 'LoginRequiredMixin': LoginRequiredMixin, 'render': render, 'READ_DB_ALIAS': 'mysql_db', 'redis_instance': redis.Redis.from_url(body['redis'])}

    def model(name, table, fields):
        result = type(name, (models.Model,), {'__module__': __name__, 'Meta': type('Meta', (), {'app_label': 'order_form_original', 'db_table': table, 'managed': False}), 'id': models.BigIntegerField(primary_key=True), **fields})
        namespace[name] = result
        return result
    text = lambda **kw: models.CharField(max_length=255, **kw)
    model('UserStore', 'user_stores', {'django_user_id': models.BigIntegerField(), 'store_id': models.IntegerField()})
    model('Store', 'stores', {'store_name': text(), 'is_active': models.BooleanField()})
    for (name, table, field) in [('PaymentMethod', 'payment_method', 'name'), ('PaymentStatus', 'payment_status', 'payment_status'), ('OrderStatus', 'order_status', 'order_status')]:
        model(name, table, {field: text()})
    model('Order', 'orders', {'order_statuses': models.IntegerField(db_column='order_status')})
    model('ExpressLineItem', 'express_line_item', {'order_id': models.BigIntegerField(), 'store_id': models.IntegerField(), 'status': text(), 'pending_expires_at': models.DateTimeField(), 'accepted_expires_at': models.DateTimeField()})
    model('PosTerminalPaymentModes', 'pos_terminal_payment_modes', {'is_active': models.BooleanField(), 'platform': text(), 'name': text(), 'mode_id': models.IntegerField()})

    def execute(node):
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<pinned-original-form>', 'exec'), namespace)
    helper = definition('helpers/helpers.py', 'Helpers')
    helper.body = [n for n in helper.body if isinstance(n, ast.FunctionDef) and n.name in ['get_checkin_data', 'get_days_before_after_datetime']]
    execute(helper)
    terminal = definition('helpers/terminal_helpers.py', 'TerminalHelper')
    terminal.body = [n for n in terminal.body if isinstance(n, ast.FunctionDef) and n.name == 'get_payment_mode']
    execute(terminal)
    execute(definition('order/views.py', '_hl_get_tab_counts'))
    execute(definition('order/views.py', 'OrdersView'))

    def excluded(request):
        return HttpResponseNotAllowed([])
    names = ['tab', 'hyperlocal_progress', 'ajax_hyperlocal_progress_content', 'orders_store', 'orders_online', 'ajax-transaction-status-check-paytm', 'ajax-transaction-status-check', 'paytm-ajax-transaction-cancel', 'ajax-transaction-cancel', 'ajax-get-payment-mode-by-order-id']
    urls = types.ModuleType('order_form_urls')
    urls.urlpatterns = [path('excluded/' + name + '/', excluded, name=name) for name in names]
    sys.modules[urls.__name__] = urls
    with connection.cursor() as cursor:
        cursor.execute('SELECT id,role,user_type,is_active FROM pos_user WHERE id=%s', [body['actor']])
        actor = cursor.fetchone()
    if not actor or not actor[3]:
        raise ValueError('NATIVE_ACTOR_REQUIRED')
    user = types.SimpleNamespace(id=actor[0], role=actor[1], user_type=actor[2], is_authenticated=True)
    factory = RequestFactory()

    def dispatch(data=None):
        request = factory.get('/orders/store/') if data is None else factory.post('/orders/store/', data)
        request.user = user
        with redirect_stdout(io.StringIO()):
            response = namespace['OrdersView'].as_view()(request)
        html = response.content.decode()
        match = re.search('id="order-date-range"[^>]*value="([^"]*)"', html)
        if not match:
            raise ValueError('ORIGINAL_FORM_CONTROL_MISSING')
        return (response.status_code, match[1].strip(), html)
    (status, original, _) = dispatch()
    cases = []
    for kind in ['N', 'ST', 'HE', 'N']:
        (status, retained, html) = dispatch({'stores[]': ['1'], 'order_id': '', 'mobile': '', 'email': '', 'order_date_range': original, 'order_type': kind})
        ajax = re.search("d\\.order_date_range\\s*=\\s*'([^']*)'", html)
        selected = re.search('value="' + kind + '" name="order_type"\\s+checked', html)
        cases.append({'type': kind, 'status': status, 'range': retained, 'ajaxRange': ajax[1] if ajax else None, 'selected': bool(selected)})
    connections.close_all()
    print(json.dumps({'defaultRange': original, 'cases': cases, 'mro': [n.__name__ for n in namespace['OrdersView'].__mro__]}))
if __name__ == '__main__':
    try:
        main()
    except Exception:
        sys.stderr.write('ORIGINAL_ORDER_FORM_UNAVAILABLE\n')
        raise SystemExit(1)
