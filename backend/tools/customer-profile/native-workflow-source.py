"""Execute pinned profile classes with real Django dispatch/native MySQL.

Identity and an already fetched customer are fixture entry seams. No source ORM,
SQL cursor, view base class or business response is substituted. Never import the
legacy application, contact a provider, or print source payload diagnostics.
"""
import ast
from contextlib import ExitStack, redirect_stdout
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
ROOT = Path(os.environ['CUSTOMER_PROFILE_SOURCE_ROOT']).resolve()
INPUTS = ['users/urls.py', 'users/views.py', 'order/models.py',
          'order/templates/order/create_order.html',
          'static/adminlte/plugins/jquery/jquery.min.js']


def source(path):
    return subprocess.check_output(['git', '-C', str(ROOT), 'show', PIN + ':' + path],
                                   stderr=subprocess.DEVNULL).decode()


def definition(path, name):
    return next(n for n in ast.parse(source(path)).body
                if isinstance(n, ast.ClassDef) and n.name == name)


class FixturePrincipalMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.db import connection
        authenticated = False
        if request.COOKIES.get('profile_source_actor') == 'fixture-established-operator':
            with connection.cursor() as cursor:
                cursor.execute('SELECT is_active FROM pos_user WHERE id=%s', [7])
                row = cursor.fetchone()
                authenticated = bool(row and row[0])
        request.user = SimpleNamespace(id=7, is_authenticated=authenticated)
        return self.get_response(request)


def browser_fragments():
    """Exact active script/DOM fragments; do not render/admit the whole checkout."""
    template = source('order/templates/order/create_order.html')
    beginning = template.index('<form class="form-horizontal" id="user-fetch-form">')
    form_end = template.index('</form>', beginning) + len('</form>')
    hidden = template.index('<input id="user_id" name="user_id"')
    hidden_end = template.index('>', hidden) + 1
    button = template.index('<button type="button" id="update-user"')
    button_end = template.index('</button>', button) + len('</button>')
    properties = template.index('    function addBirthdayEditClickEvent(){')
    properties_end = template.index('    var barcode', properties)
    type_start = template.index('$(function () {\n    const customerType')
    type_end = template.index('\n    })', type_start) + len('\n    })')
    business = template.index('$(document).ready(function () {\n    // GSTIN input enhancement')
    business_end = template.index('\n});', business) + len('\n});')
    fetched = template.index("            $('#phone').prop('disabled', false);")
    fetched_end = template.index("            $('#update-user').show();", fetched) + len("            $('#update-user').show();")
    return {'dom': template[beginning:form_end] + template[hidden:hidden_end] + template[button:button_end],
            'script': template[type_start:type_end] + '\n' + template[properties:properties_end]
            + '\n' + template[business:business_end],
            'fetchedControls': template[fetched:fetched_end]}


def main():
    body = json.load(sys.stdin)
    routes = [('update-user', 'AjaxUserUpdateView', 'ajax_update_user'),
              ('ajax-update-user-data/', 'AjaxUpdateEndUserDataView', 'ajax_update_user_data')]
    for route, view, _ in routes:
        matches = [n for n in ast.walk(ast.parse(source('users/urls.py')))
                   if isinstance(n, ast.Call) and n.args and isinstance(n.args[0], ast.Constant)
                   and n.args[0].value == route]
        assert len(matches) == 1 and view + '.as_view()' in ast.unparse(matches[0])
    url = urlsplit(body['url'])
    if (url.scheme != 'mysql' or url.hostname != '127.0.0.1' or not url.port
            or url.query or url.fragment
            or not re.fullmatch(r'pos_rewrite_profile_workflow_[a-f0-9]{12}', url.path[1:])):
        raise ValueError('Only the isolated profile workflow schema is allowed')
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    database = {'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:],
                'HOST': url.hostname, 'PORT': url.port, 'USER': unquote(url.username or ''),
                'PASSWORD': unquote(url.password or ''),
                'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}
    settings.configure(SECRET_KEY='synthetic-profile-oracle-only',
                       INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes'],
                       USE_TZ=False, USE_I18N=False, TIME_ZONE='Asia/Kolkata',
                       ALLOWED_HOSTS=['testserver'], LOGGING_CONFIG=None,
                       ROOT_URLCONF='profile_workflow_urls',
                       MIDDLEWARE=[__name__ + '.FixturePrincipalMiddleware'],
                       DATABASES={'default': database, 'mysql_db': database.copy()},
                       TEMPLATES=[{'BACKEND': 'django.template.backends.django.DjangoTemplates'}])
    django.setup()
    logging.disable(logging.CRITICAL)
    from django.db import models, connections
    from django.contrib.auth.mixins import LoginRequiredMixin
    from django.views import View
    from django.http import JsonResponse, HttpResponse
    from django.urls import path
    from django.test import Client
    from django.template import Context, Engine
    namespace = {'models': models, '__name__': __name__, 'View': View,
                 'LoginRequiredMixin': LoginRequiredMixin, 'connections': connections,
                 'json': json, 'JsonResponse': JsonResponse, 'HttpResponse': HttpResponse}
    for node in ([definition('order/models.py', 'MUser')]
                 + [definition('users/views.py', name) for _, name, _ in routes]):
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                     '<pinned-native-profile>', 'exec'), namespace)
    module = types.ModuleType('profile_workflow_urls')
    module.urlpatterns = [path('users/' + route, namespace[name].as_view(), name=url_name)
                          for route, name, url_name in routes]
    sys.modules[module.__name__] = module
    client = Client(raise_request_exception=False)
    if body.get('authenticated', True):
        client.cookies['profile_source_actor'] = 'fixture-established-operator'
    counts = {'queries': 0, 'nativeUpdates': 0}

    def count(execute, sql, params, many, context):
        counts['queries'] += 1
        if sql.lstrip().upper().startswith('UPDATE '):
            counts['nativeUpdates'] += 1
        return execute(sql, params, many, context)

    result = {'mro': {name: [base.__name__ for base in namespace[name].__mro__]
                      for _, name, _ in routes}}
    with ExitStack() as stack, redirect_stdout(io.StringIO()):
        for alias in ['default', 'mysql_db']:
            stack.enter_context(connections[alias].execute_wrapper(count))
        if body['action'] == 'dispatch':
            target = body['target']
            if target not in ['/users/update-user', '/users/ajax-update-user-data/']:
                raise ValueError('Unknown bounded source route')
            response = client.generic('POST', target, data=body.get('serialized', ''),
                                      content_type='application/x-www-form-urlencoded')
            try:
                data = json.loads(response.content)
            except (ValueError, UnicodeDecodeError):
                data = None
            exception = getattr(response, 'exc_info', None)
            result.update(status=response.status_code, body=data,
                          location=response.get('Location'),
                          exceptionType=exception[0].__name__ if exception else None)
        elif body['action'] == 'browser':
            fragments = browser_fragments()
            user = namespace['MUser'].objects.get(pk=777)
            context = Context({'user_obj': user, 'csrf_token': 'F' * 64})
            engine = Engine()
            rendered = {name: engine.from_string(value).render(context)
                        for name, value in fragments.items()}
            # Dialog trigger/display hosts belong to the fixture carrier; dynamic
            # dialog inputs/options/actions below remain the exact source script.
            hosts = ''.join('<button id="' + field + '-edit">' + field + '</button>'
                            '<span id="user-details-' + field + '">unchanged</span>'
                            for field in ['birthday', 'anniversary', 'gender'])
            result['html'] = '<!doctype html><html><body>' + rendered['dom'] + hosts \
                + '<script src="/__profile_source_jquery.js"></script>' \
                + '<script src="/__profile_source_dialog_carrier.js"></script><script>' \
                + rendered['script'] + '\n$(function(){' + rendered['fetchedControls'] \
                + 'addBirthdayEditClickEvent();addAnniversaryEditClickEvent();addGenderEditClickEvent();});' \
                + '</script></body></html>'
        else:
            raise ValueError('Unknown source action')
    connections.close_all()
    result.update(counts)
    result['sourceHashes'] = {name: hashlib.sha256(source(name).encode()).hexdigest()
                              for name in INPUTS}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'NATIVE_PROFILE_SOURCE_UNAVAILABLE'}))
        raise SystemExit(1)
