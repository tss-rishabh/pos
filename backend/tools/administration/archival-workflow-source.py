"""Pinned reversible lifecycle dispatch on real source models and owned MySQL.

No ORM, principal or view doubles. Unrelated source applications are omitted;
the selected complete model classes, decorators, views and URL wrapper execute.
Only fixed synthetic fixtures may be supplied by archival-workflow-fixture.ts.
"""
import ast
import hashlib
import json
import logging
import re
import subprocess
import sys
import threading
import traceback
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
from urllib.parse import unquote, urlsplit

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'


def main():
    payload = json.load(sys.stdin)
    root = Path(payload['source']).resolve()
    url = urlsplit(payload['database'])
    assert url.scheme == 'mysql' and url.hostname == '127.0.0.1' and url.port
    assert not url.query and not url.fragment
    assert re.fullmatch(r'pos_rewrite_barcodes_[a-f0-9]{12}', url.path[1:])
    assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    hashes = {}

    def source(filename):
        raw = subprocess.check_output(['git', '-C', str(root), 'show', PIN + ':' + filename])
        hashes[filename] = hashlib.sha256(raw).hexdigest()
        return raw.decode()

    def classes(filename, names):
        return [node for node in ast.parse(source(filename)).body
                if isinstance(node, ast.ClassDef) and node.name in names]

    import django
    import pymysql
    assert django.get_version() == '4.2.5'
    pymysql.install_as_MySQLdb()
    with TemporaryDirectory(prefix='pos-archival-source-') as temporary:
        for name, names, imports in [
            ('users', ['PosUser'], 'from django.db import models\nfrom django.contrib.auth.models import AbstractUser\nfrom django.core.validators import MinLengthValidator\n'),
            ('stores', ['Store', 'TssSetting'], 'import json\nfrom django.db import models\nfrom django.core.validators import MinLengthValidator\n'),
        ]:
            package = Path(temporary) / name
            package.mkdir()
            (package / '__init__.py').write_text('')
            (package / 'models.py').write_text(imports + '\n'.join(ast.unparse(node) for node in classes(name + '/models.py', names)))
        sys.path.insert(0, temporary)
        from django.conf import settings
        settings.configure(
            SECRET_KEY='synthetic-archival-source-session-only', USE_TZ=False, USE_I18N=False,
            AUTH_USER_MODEL='users.PosUser', ALLOWED_HOSTS=['testserver'], ROOT_URLCONF=__name__,
            LOGIN_URL='/login/', SESSION_ENGINE='django.contrib.sessions.backends.signed_cookies',
            INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions', 'django.contrib.messages', 'users', 'stores'],
            MIDDLEWARE=['django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware', 'django.contrib.messages.middleware.MessageMiddleware'],
            DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:], 'HOST': url.hostname, 'PORT': url.port,
                                  'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''),
                                  'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}},
        )
        django.setup()
        logging.disable(logging.CRITICAL)
        from django.contrib import messages
        from django.contrib.auth.mixins import LoginRequiredMixin
        from django.db import connection
        from django.http import HttpResponse
        from django.middleware.csrf import _get_new_csrf_string
        from django.shortcuts import redirect
        from django.test import Client
        from django.urls import include, path
        from django.utils.decorators import method_decorator
        from django.views import View
        from functools import wraps
        from users.models import PosUser
        from stores.models import Store
        namespace = {'__name__': __name__, 'json': json, 'messages': messages, 'redirect': redirect,
                     'wraps': wraps, 'method_decorator': method_decorator, 'LoginRequiredMixin': LoginRequiredMixin,
                     'View': View, 'User': PosUser, 'Store': Store, 'HttpResponse': HttpResponse}
        decorators = ast.parse(source('helpers/decorators.py'))
        selected = [node for node in decorators.body if isinstance(node, ast.FunctionDef)
                    and node.name in ['permission', 'advance_permisson']]
        exec(compile(ast.Module(body=selected, type_ignores=[]), 'helpers/decorators.py', 'exec'), namespace)
        for filename, names in [('stores/views.py', ['DeleteStoreView', 'ActivateStoreView']),
                                ('users/views.py', ['DeleteUserView', 'ActivateUserView'])]:
            exec(compile(ast.Module(body=classes(filename, names), type_ignores=[]), filename, 'exec'), namespace)
        wrapper = {'__name__': __name__}
        exec(compile(source('POSAdmin/connection_handler.py'), 'POSAdmin/connection_handler.py', 'exec'), wrapper)
        namespace.update({'path': path, 'sync_to_async': wrapper['sync_to_async'],
                          'stores_views': SimpleNamespace(**namespace), 'user_views': SimpleNamespace(**namespace)})
        children = {}
        route_ids = []
        for resource, filename, lines in [('stores', 'stores/urls.py', [15, 16]), ('users', 'users/urls.py', [19, 20])]:
            calls = [node for node in ast.walk(ast.parse(source(filename))) if isinstance(node, ast.Call)
                     and isinstance(node.func, ast.Name) and node.func.id == 'path' and node.lineno in lines]
            assert len(calls) == 2
            children[resource] = [eval(compile(ast.Expression(node), filename, 'eval'), namespace) for node in calls]
            route_ids += [filename + ':' + str(node.lineno) for node in calls]
        global urlpatterns
        for resource in ['stores', 'users']:
            module = ModuleType(resource + '.urls')
            module.urlpatterns = children[resource]
            sys.modules[module.__name__] = module
        mounts = [node for node in ast.walk(ast.parse(source('POSAdmin/urls.py')))
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'path'
                  and len(node.args) == 2 and isinstance(node.args[1], ast.Call)
                  and isinstance(node.args[1].func, ast.Name) and node.args[1].func.id == 'include'
                  and node.args[1].args and isinstance(node.args[1].args[0], ast.Constant)
                  and node.args[1].args[0].value in ['stores.urls', 'users.urls']]
        assert len(mounts) == 2
        urlpatterns = [eval(compile(ast.Expression(node), 'POSAdmin/urls.py', 'eval'), {'path': path, 'include': include}) for node in mounts]
        urlpatterns += [path('login/', lambda request: HttpResponse('Synthetic login'), name='login'),
                       path('users/', lambda request: HttpResponse('Synthetic users'), name='users_list_view'),
                       path('dashboard/', lambda request: HttpResponse('Synthetic dashboard'), name='shortcut_dashboard')]
        results = []
        dispatch_exceptions = []
        def trace_dispatch(frame, event, argument):
            if event == 'exception' and frame.f_code.co_filename in ['stores/views.py', 'users/views.py']:
                dispatch_exceptions.append({'kind': argument[0].__name__, 'line': frame.f_lineno})
            return trace_dispatch
        threading.settrace(trace_dispatch)
        sys.settrace(trace_dispatch)
        for resource, target, actor, action in [
            ('stores', 2, 1, 'delete'), ('stores', 2, 1, 'activate'),
            ('stores', 2, 2, 'delete'), ('stores', 2, 4, 'delete'),
            ('users', 30, 1, 'delete'), ('users', 30, 1, 'activate'),
            ('users', 30, 2, 'delete'), ('users', 30, 3, 'delete'),
            ('users', 2, 3, 'delete'), ('users', 30, 4, 'delete'),
            ('users', 1, 1, 'delete'), ('users', 30, None, 'delete'),
        ]:
            model = Store if resource == 'stores' else PosUser
            initial = action != 'activate'
            model.objects.filter(pk=target).update(is_active=initial)
            client = Client(enforce_csrf_checks=True, raise_request_exception=False)
            if actor is not None:
                client.force_login(PosUser.objects.get(pk=actor))
            csrf = _get_new_csrf_string()
            client.cookies['csrftoken'] = csrf
            dispatch_exceptions.clear()
            response = client.post('/' + resource + '/' + str(target) + '/' + action + '/', {}, HTTP_X_CSRFTOKEN=csrf)
            row = model.objects.filter(pk=target).values('id', 'is_active').get()
            body = json.loads(response.content) if response.headers.get('Content-Type', '').startswith('application/json') else {}
            failure_category = None
            if body.get('status') == 'fail':
                message = body.get('message', '')
                undefined = re.search(r"name '([A-Za-z_][A-Za-z0-9_]*)' is not defined", message)
                unknown_column = re.search(r"Unknown column '([A-Za-z_.]+)'", message)
                sql_code = re.match(r'\((\d+),', message)
                failure_category = ('undefined-global:' + undefined[1] if undefined else
                                    'unknown-column:' + unknown_column[1] if unknown_column else
                                    'sql-error:' + sql_code[1] if sql_code else 'unclassified-source-error')
                if dispatch_exceptions:
                    failure_category += ':' + dispatch_exceptions[-1]['kind'] + ':' + str(dispatch_exceptions[-1]['line'])
            results.append({'resource': resource, 'actorRole': actor, 'targetRole': 2 if target == 2 and resource == 'users' else 4,
                            'self': actor == target, 'action': action, 'httpStatus': response.status_code,
                            'sourceStatus': body.get('status'), 'permissionDenied': 'Permission denied' in body.get('message', ''),
                            'failureCategory': failure_category,
                            'initialActive': initial, 'active': row['is_active'], 'retainedId': row['id'] == target})
            model.objects.filter(pk=target).update(is_active=True)
        threading.settrace(None)
        sys.settrace(None)
        connection.close()
        json.dump({'sourceCommit': PIN, 'routeIds': route_ids, 'hashes': hashes, 'cases': results}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        frames = [{'file': Path(frame.filename).name if re.fullmatch(r'[A-Za-z0-9_.-]+', Path(frame.filename).name) else 'internal', 'line': frame.lineno}
                  for frame in traceback.extract_tb(failure.__traceback__)]
        json.dump({'error': 'ARCHIVAL_WORKFLOW_SOURCE_FAILED', 'kind': type(failure).__name__, 'frames': frames}, sys.stdout)
        sys.exit(1)
