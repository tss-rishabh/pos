"""Exact pinned expiry view/tab aggregates on genuine Django QuerySets/MySQL.

The source Redis/check-in helper is replaced by a read of the same owned native
check-in authority used by the replacement. Clock/host-calendar seams are explicit
IST fixtures. LoginRequiredMixin, native ModelBackend, class dispatch, URL and all
expiry/count QuerySets are real; no source route/template certification is implied.
"""
import ast
import datetime
import hashlib
import json
import logging
import re
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'


def main():
    payload = json.load(sys.stdin)
    root = Path(payload['source']).resolve()
    url = urlsplit(payload['database'])
    assert url.scheme == 'mysql' and url.hostname == '127.0.0.1' and url.port
    assert re.fullmatch(r'pos_rewrite_barcodes_[a-f0-9]{12}', url.path[1:]) and not url.query and not url.fragment
    assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    hashes = {}

    def source(filename):
        raw = subprocess.check_output(['git', '-C', str(root), 'show', PIN + ':' + filename])
        hashes[filename] = hashlib.sha256(raw).hexdigest()
        return raw.decode()

    def definition(filename, name):
        return next(node for node in ast.parse(source(filename)).body
                    if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name == name)

    now = datetime.datetime.fromisoformat(payload['now'].replace('Z', '+00:00'))
    business_now = now.astimezone(ZoneInfo('Asia/Kolkata')).replace(tzinfo=None)
    import django
    import pymysql
    assert django.get_version() == '4.2.5'
    pymysql.install_as_MySQLdb()
    with TemporaryDirectory(prefix='pos-reminders-source-') as temporary:
        for name in ['users', 'order']:
            package = Path(temporary) / name
            package.mkdir()
            (package / '__init__.py').write_text('')
        user = definition('users/models.py', 'PosUser')
        (Path(temporary) / 'users/models.py').write_text('from django.db import models\nfrom django.contrib.auth.models import AbstractUser\nfrom django.core.validators import MinLengthValidator\n' + ast.unparse(user))
        projected = []
        for name in ['Order', 'HasProduct']:
            owner = definition('order/models.py', name)
            owner.body = [node for node in owner.body if
                          (isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'id' for target in node.targets))
                          or (isinstance(node, ast.ClassDef) and node.name == 'Meta')]
            projected.append(owner)
        projected.append(definition('order/models.py', 'ExpressLineItem'))
        (Path(temporary) / 'order/models.py').write_text('from django.db import models\n' + '\n'.join(ast.unparse(node) for node in projected))
        sys.path.insert(0, temporary)
        from django.conf import settings
        settings.configure(SECRET_KEY='synthetic-source-reminders-only', USE_TZ=False, USE_I18N=False,
            AUTH_USER_MODEL='users.PosUser', ALLOWED_HOSTS=['testserver'], ROOT_URLCONF=__name__, LOGIN_URL='/login/',
            SESSION_ENGINE='django.contrib.sessions.backends.signed_cookies',
            INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions', 'users', 'order'],
            MIDDLEWARE=['django.contrib.sessions.middleware.SessionMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware'],
            DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:], 'HOST': url.hostname,
                'PORT': url.port, 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''),
                'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}})
        django.setup()
        logging.disable(logging.CRITICAL)
        from django.contrib.auth.mixins import LoginRequiredMixin
        from django.db import connection
        from django.db.models import Min
        from django.http import JsonResponse
        from django.test import Client
        from django.urls import path
        from django.views import View
        from users.models import PosUser
        from order.models import ExpressLineItem

        def checkin(operator):
            with connection.cursor() as cursor:
                cursor.execute('SELECT c.store_id FROM pos_rewrite_operator_checkins c JOIN pos_user u ON u.id=c.operator_id JOIN stores s ON s.id=c.store_id WHERE c.operator_id=%s AND c.expires_at>%s AND u.is_active=1 AND s.is_active=1',
                    [operator, now.replace(tzinfo=None)])
                row = cursor.fetchone()
            return [row[0] if row else 0, '']

        class BusinessDate(datetime.date):
            @classmethod
            def today(cls):
                return business_now.date()

        namespace = {'__name__': __name__, 'LoginRequiredMixin': LoginRequiredMixin, 'View': View,
            'JsonResponse': JsonResponse, 'Min': Min, 'ExpressLineItem': ExpressLineItem, 'READ_DB_ALIAS': 'default',
            'datetime': SimpleNamespace(date=BusinessDate, datetime=datetime.datetime, timedelta=datetime.timedelta),
            'Helpers': SimpleNamespace(get_checkin_data=checkin, now_ist=lambda: business_now)}
        nodes = [definition('order/views.py', '_hl_get_tab_counts'), definition('order/views.py', 'AjaxHyperlocalExpiryAlertsView')]
        exec(compile(ast.Module(body=nodes, type_ignores=[]), 'order/views.py', 'exec'), namespace)
        route = next(node for node in ast.walk(ast.parse(source('order/urls.py'))) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Name) and node.func.id == 'path' and node.lineno == 107)
        assert 'AjaxHyperlocalExpiryAlertsView.as_view()' in ast.unparse(route)
        child = eval(compile(ast.Expression(route), 'order/urls.py', 'eval'),
                     {'path': path, 'order_views': SimpleNamespace(**namespace)})
        global urlpatterns
        from django.urls import include
        urlpatterns = [path('orders/', include([child]))]
        client = Client()
        client.force_login(PosUser.objects.get(pk=1))
        response = client.get('/orders/ajax-hyperlocal-expiry-alerts/')
        assert response.status_code == 200
        body = json.loads(response.content)
        connection.close()
        json.dump({'sourceCommit': PIN, 'hashes': hashes, 'routeId': 'order/urls.py:107', 'body': body}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        json.dump({'error': 'SOURCE_EXPIRY_ORACLE_FAILED', 'kind': type(failure).__name__}, sys.stdout)
        sys.exit(1)
