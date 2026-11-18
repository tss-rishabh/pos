"""Pinned notification consumer, producer, ORM and header controls on local fixtures.

The legacy project is never imported. Original class/function/ASGI assembly AST
executes with genuine Django, Channels, Redis and MySQL. Only established HTTP
identity and the surrounding page are fixture carriers; no ORM/layer/bus doubles.
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
ROOT = Path(os.environ['NOTIFICATION_SOURCE_ROOT']).resolve()
INPUTS = ['notification/consumers.py', 'notification/models.py', 'notification/views.py',
          'notification/routing.py', 'notification/urls.py', 'POSAdmin/connection_handler.py', 'helpers/notification_helpers.py',
          'helpers/helpers.py', 'stores/models.py', 'core/context_processors.py', 'POSAdmin/asgi.py',
          'users/templates/admin/layouts/base.html',
          'users/templates/admin/layouts/base_no_sidebar_navbar.html',
          'users/templates/admin/includes/navbar.html',
          'static/adminlte/plugins/jquery/jquery.min.js',
          'static/adminlte/plugins/sweetalert2/sweetalert2.min.js',
          'static/adminlte/dist/mp3/notification.mp3']


def blob(path):
    return subprocess.check_output(['git', '-C', str(ROOT), 'show', PIN + ':' + path],
                                   stderr=subprocess.DEVNULL)


def source(path):
    return blob(path).decode()


def definition(path, name):
    return next(node for node in ast.parse(source(path)).body
                if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name == name)


def compile_node(node, namespace):
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                 '<pinned-native-notification>', 'exec'), namespace)


class FixturePrincipalMiddleware:
    """HTTP established-operator seam, backed by the same native actor rows."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.db import connection
        actor = request.COOKIES.get('notification_source_actor', '')
        active = False
        if actor in ['7', '8', '9']:
            with connection.cursor() as cursor:
                cursor.execute('SELECT is_active FROM pos_user WHERE id=%s', [int(actor)])
                row = cursor.fetchone()
                active = bool(row and row[0])
        request.user = SimpleNamespace(id=int(actor) if active else None,
                                       is_authenticated=active)
        return self.get_response(request)


def header_fragments(variant):
    filename = 'users/templates/admin/layouts/' + (
        'base_no_sidebar_navbar.html' if variant == 'compact' else 'base.html')
    text = source(filename)
    start = text.index('    const roomName = JSON.parse(')
    end = (text.index('    var isModalOpen', start) if variant == 'main'
           else text.index('</script>', start))
    audio = re.search(r'<audio id="audiotag1?"[^>]*></audio>', text).group(0)
    navbar = ''
    if variant == 'main':
        nav = source('users/templates/admin/includes/navbar.html')
        first = nav.index('        {% if 0 in check_in_store|slice:":1" %}')
        last = nav.index('        {% if user.user_type != 2 %}', first)
        navbar = nav[first:last]
    return navbar, audio, text[start:end]


def environment(body):
    url, redis_url = urlsplit(body['url']), urlsplit(body['redis'])
    if (url.scheme != 'mysql' or url.hostname != '127.0.0.1' or not url.port
            or url.query or url.fragment
            or not re.fullmatch(r'pos_rewrite_notification_workflow_[a-f0-9]{12}', url.path[1:])):
        raise ValueError('Only the owned notification MySQL fixture is allowed')
    if (redis_url.scheme != 'redis' or redis_url.hostname != '127.0.0.1' or not redis_url.port
            or redis_url.path not in ['', '/0'] or redis_url.query or redis_url.fragment):
        raise ValueError('Only the owned notification Redis fixture is allowed')
    if not re.fullmatch(r'notification_source_[a-f0-9]{12}', body['prefix']):
        raise ValueError('Owned channel layer prefix required')
    import pymysql
    pymysql.install_as_MySQLdb()
    import django
    from django.conf import settings
    settings.configure(
        SECRET_KEY='synthetic-notification-oracle-only', USE_TZ=False, USE_I18N=False,
        TIME_ZONE='Asia/Kolkata', STATIC_URL='/static/',
        INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes'],
        ALLOWED_HOSTS=['127.0.0.1', 'localhost', 'testserver'], LOGGING_CONFIG=None,
        ROOT_URLCONF='notification_workflow_urls',
        MIDDLEWARE=[__name__ + '.FixturePrincipalMiddleware'],
        DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': url.path[1:],
            'HOST': url.hostname, 'PORT': url.port, 'USER': unquote(url.username or ''),
            'PASSWORD': unquote(url.password or ''),
            'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}},
        CHANNEL_LAYERS={'default': {'BACKEND': 'channels_redis.core.RedisChannelLayer',
            'CONFIG': {'hosts': [body['redis']], 'prefix': body['prefix']}}},
        TEMPLATES=[{'BACKEND': 'django.template.backends.django.DjangoTemplates'}],
    )
    django.setup()
    logging.disable(logging.CRITICAL)
    from django.db import models
    from django.http import HttpResponse
    from django.views.generic import View
    from django.contrib.auth.mixins import LoginRequiredMixin
    from django.utils.decorators import method_decorator
    from django.views.decorators.csrf import csrf_exempt
    from django.urls import path, re_path, include
    from channels.generic.websocket import AsyncWebsocketConsumer
    from channels.layers import get_channel_layer
    import redis
    import asyncio
    namespace = {'__name__': __name__, 'models': models, 'json': json, 'datetime': datetime,
                 '_IST': datetime.timezone(datetime.timedelta(hours=5, minutes=30)),
                 'redis_instance': redis.Redis.from_url(body['redis']), 'asyncio': asyncio,
                 'logger': logging.getLogger('notification-source'),
                 'HttpResponse': HttpResponse, 'View': View, 'LoginRequiredMixin': LoginRequiredMixin,
                 'method_decorator': method_decorator, 'csrf_exempt': csrf_exempt,
                 'AsyncWebsocketConsumer': AsyncWebsocketConsumer,
                 'get_channel_layer': get_channel_layer, 're_path': re_path}
    helper = definition('helpers/helpers.py', 'Helpers')
    helper.body = [node for node in helper.body if isinstance(node, ast.FunctionDef)
                   and node.name in ['now_ist', 'get_checked_in_user', 'get_checkin_data']]
    compile_node(helper, namespace)
    for name in ['Notification', 'UsersNotification']:
        compile_node(definition('notification/models.py', name), namespace)
    store = definition('stores/models.py', 'Store')
    store.body = [node for node in store.body if
                  isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                  and target.id in ['id', 'store_name'] for target in node.targets)
                  or isinstance(node, ast.ClassDef) and node.name == 'Meta']
    compile_node(store, namespace)
    compile_node(definition('notification/views.py', 'AjaxNotificationUpdateView'), namespace)
    compile_node(definition('notification/consumers.py', 'NotificationConsumer'), namespace)
    for name in ['order_notification', 'create_order_notification_sync']:
        compile_node(definition('helpers/notification_helpers.py', name), namespace)
    context = definition('core/context_processors.py', 'SystemGlobalData')
    compile_node(next(node for node in context.body if isinstance(node, ast.FunctionDef)
                      and node.name == 'get_users_notification'), namespace)
    # Execute the original route expression and preserve class/as_asgi binding.
    namespace['consumers'] = SimpleNamespace(NotificationConsumer=namespace['NotificationConsumer'])
    routing = ast.parse(source('notification/routing.py'))
    compile_node(next(node for node in routing.body if isinstance(node, ast.Assign)), namespace)
    route_calls = [node for node in ast.walk(ast.parse(source('notification/urls.py')))
                   if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant)
                   and node.args[0].value == 'ajax-notification-update/']
    assert len(route_calls) == 1 and 'AjaxNotificationUpdateView.as_view()' in ast.unparse(route_calls[0])
    from django.template import Context, Engine

    class HeaderView(LoginRequiredMixin, View):
        def get(self, request):
            variant = request.GET.get('variant', 'main')
            if variant not in ['main', 'compact']:
                return HttpResponse(status=400)
            checked_in = namespace['Helpers'].get_checkin_data(request.user.id)
            rows, count = namespace['get_users_notification'](request, checked_in[0])
            navbar, audio, script = header_fragments(variant)
            ctx = Context({'request': request, 'room_name': 'order', 'notification': rows,
                           'unread_notification': count, 'check_in_store': checked_in,
                           'csrf_token': 'N' * 64})
            engine = Engine(libraries={'static': 'django.templatetags.static'})
            render = lambda value: engine.from_string(value).render(ctx)
            # genuine media playing events; it never replaces play/WebSocket/XHR.
            carrier = '<script>window.console.log=function(){};window.__sourceMediaPlayed=0;</script>'
            static = '<script src="/static/adminlte/plugins/jquery/jquery.min.js"></script>' \
                     '<script src="/static/adminlte/plugins/sweetalert2/sweetalert2.min.js"></script>'
            queue = '<div class="queue-band"></div>' if variant == 'main' else ''
            html = '<!doctype html><html><body>' + render(navbar) + queue \
                + render('{% load static %}' + audio) + '<button id="source-media-gesture">Activate source media</button>' \
                + carrier + static + '<script>document.querySelector("audio").addEventListener("playing",function(){window.__sourceMediaPlayed++;});</script>' \
                + render('{{ room_name|json_script:"room-name" }}') \
                + '<script>' + render(script) + '</script></body></html>'
            return HttpResponse(html, content_type='text/html')

    from asgiref.sync import SyncToAsync
    from django.db import close_old_connections
    namespace.update(SyncToAsync=SyncToAsync, close_old_connections=close_old_connections, path=path,
                     notification_views=SimpleNamespace(AjaxNotificationUpdateView=namespace['AjaxNotificationUpdateView']))
    compile_node(definition('POSAdmin/connection_handler.py', 'DatabaseSyncToAsync'), namespace)
    namespace['sync_to_async'] = namespace['DatabaseSyncToAsync']
    compile_node(next(node for node in ast.parse(source('notification/urls.py')).body
                      if isinstance(node, ast.Assign)), namespace)
    module = types.ModuleType('notification_workflow_urls')
    module.urlpatterns = [path('__notification_source_header__', HeaderView.as_view()),
                          path('notification/', include(namespace['urlpatterns']))]
    sys.modules[module.__name__] = module
    return namespace


def main():
    body = json.load(sys.stdin)
    namespace = environment(body)
    if body['action'] == 'serve':
        from channels.routing import ProtocolTypeRouter, URLRouter
        from channels.auth import AuthMiddlewareStack
        from django.core.asgi import get_asgi_application
        assembly = dict(namespace, ProtocolTypeRouter=ProtocolTypeRouter, URLRouter=URLRouter,
                        AuthMiddlewareStack=AuthMiddlewareStack, get_asgi_application=get_asgi_application)
        tree = ast.parse(source('POSAdmin/asgi.py'))
        compile_node(next(node for node in tree.body if isinstance(node, ast.Assign)
                          and any(isinstance(target, ast.Name) and target.id == 'application'
                                  for target in node.targets)), assembly)
        app = assembly['application']
        assets = {'/static/' + path.removeprefix('static/'): path for path in INPUTS if path.startswith('static/')}

        async def static_app(scope, receive, send):
            target = scope.get('path')
            if scope['type'] == 'http' and target in assets:
                filename = assets[target]
                await send({'type': 'http.response.start', 'status': 200,
                            'headers': [(b'content-type', b'audio/mpeg' if filename.endswith('.mp3') else b'text/javascript')]})
                await send({'type': 'http.response.body', 'body': blob(filename)})
            else:
                await app(scope, receive, send)
        from daphne.server import Server
        port = body['port']
        if not isinstance(port, int) or not 1024 <= port <= 65535:
            raise ValueError('Owned loopback source port required')
        Server(static_app, endpoints=[f'tcp:port={port}:interface=127.0.0.1'],
               signal_handlers=False, verbosity=0,
               ready_callable=lambda: print(json.dumps({'ready': True, 'port': port}), flush=True)).run()
        return
    from django.db import connection, connections
    result = {}
    with redirect_stdout(io.StringIO()):
        if body['action'] == 'publish':
            order_id, store_id = int(body['orderId']), int(body['storeId'])
            if not 0 < order_id <= 9223372036854775807 or store_id not in [1, 2]:
                raise ValueError('Unknown synthetic notification scope')
            namespace['create_order_notification_sync'](body['title'], order_id, store_id,
                is_slack=False, is_new_order=bool(body['isNewOrder']))
            row = namespace['Notification'].objects.filter(order_id=order_id, store_id=store_id).order_by('-id').first()
            result = {'notificationId': str(row.id), 'users': list(namespace['UsersNotification'].objects
                      .filter(notification=row.id).values_list('pos_admin_id', flat=True))}
        elif body['action'] == 'replay':
            row = namespace['Notification'].objects.get(pk=body['notificationId'])
            users = list(namespace['UsersNotification'].objects.filter(notification=row.id)
                         .values_list('pos_admin_id', flat=True))
            result = {'published': namespace['order_notification'](row, users, bool(body['isNewOrder']))}
        elif body['action'] == 'malformed':
            import asyncio
            from channels.layers import get_channel_layer
            asyncio.run(get_channel_layer().group_send('notification_order',
                {'type': 'send_notification', 'title': 'not-json'}))
            result = {'published': True}
        elif body['action'] == 'dispatch':
            from django.test import Client
            client = Client(raise_request_exception=False, enforce_csrf_checks=True)
            actor = body.get('actor')
            if actor in ['7', '8', '9']:
                client.cookies['notification_source_actor'] = actor
            response = client.generic('POST', '/notification/ajax-notification-update/',
                data=body.get('serialized', ''), content_type='application/x-www-form-urlencoded')
            try:
                value = json.loads(response.content)
            except (ValueError, UnicodeDecodeError):
                value = None
            result = {'status': response.status_code, 'body': value, 'location': response.get('Location')}
        else:
            raise ValueError('Unknown bounded source action')
    connections.close_all()
    result['sourceHashes'] = {path: hashlib.sha256(blob(path)).hexdigest() for path in INPUTS}
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error': 'NATIVE_NOTIFICATION_SOURCE_UNAVAILABLE'}), flush=True)
        raise SystemExit(1)
