"""Pinned source page dispatch/templates plus the existing native AJAX oracle.

Source authentication is pre-resolved from a native pos_user row. RequestFactory,
Redis check-in transport and layout/URL resolution are explicit fixture seams;
the original view bodies, QuerySets, decorators, templates and helpers execute.
"""
import ast
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('catalog_existing_native_oracle', HERE.parent / 'native-workflow-oracle.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def extract(tree, name, kind):
    return next(node for node in tree.body if isinstance(node, kind) and node.name == name)


def extend(state, root):
    from django.conf import settings
    from django.contrib import messages
    from django.contrib.auth.models import AnonymousUser
    from django.db import models
    from django.http import HttpResponse
    from django.template import Context, Engine
    from django.urls import path
    from django.utils.decorators import method_decorator
    from django.views.generic import ListView
    from functools import wraps

    inventory = json.loads((HERE.parents[2] / 'parity/legacy-inventory.json').read_text())
    recorded = {row['path']: row['sha256'] for row in inventory['source_hashes']}
    files = ['core/views.py', 'core/urls.py', 'users/models.py', 'helpers/decorators.py',
             'core/templates/products/index.html', 'core/templates/products/stock/index.html']
    trees = {}
    for name in files:
        content = (root / name).read_bytes()
        actual = hashlib.sha256(content).hexdigest()
        base.require(recorded[name] == actual, 'SOURCE_PAGE_BYTES_CHANGED')
        state['sourceHashes'][name] = actual
        if name.endswith('.py'):
            trees[name] = ast.parse(content)
    namespace = state['namespace']
    namespace.update({'models': models, 'ListView': ListView, 'method_decorator': method_decorator,
                      'messages': messages, 'wraps': wraps, 'redirect': __import__('django.shortcuts', fromlist=['redirect']).redirect})
    # Named URL and base layout adapters do not execute any unrelated view or
    # external asset. The exact original child templates are rendered intact.
    urls = ModuleType('catalog_source_ui_urls')
    urls.urlpatterns = [path('stock-management/', lambda request: HttpResponse(), name='stock_management'),
                        path('stock-management/bulk-upload/', lambda request: HttpResponse(), name='stock_management_bulk_upload'),
                        path('login/', lambda request: HttpResponse(), name='login'),
                        path('shortcut-dashboard/', lambda request: HttpResponse(), name='shortcut_dashboard')]
    sys.modules[urls.__name__] = urls
    settings.ROOT_URLCONF = urls.__name__
    settings.LOGIN_URL = '/login/'
    settings.STATIC_URL = '/static/'
    layout = '<!doctype html><html><head>{% block title %}{% endblock %}{% block custom-css %}{% endblock %}</head><body>{% block maincontent %}{% endblock %}{% block custom-script %}{% endblock %}</body></html>'
    engine = Engine(dirs=[str(root / 'core/templates')],
                    loaders=[('django.template.loaders.locmem.Loader', {'admin/layouts/base.html': layout}),
                             'django.template.loaders.filesystem.Loader'],
                    libraries={'static': 'django.templatetags.static'})
    state['pageContext'] = None

    def render(request, template, context):
        stores = list(context['stores'])
        state['pageContext'] = {'stores': [{'id': str(row.id), 'name': row.store_name} for row in stores],
                                'selectedStoreIds': [str(value) for value in context.get('selected_stores', [])]}
        return HttpResponse(engine.get_template(template).render(Context({**context, 'stores': stores, 'request': request})))

    namespace['render'] = render
    user_store = extract(trees['users/models.py'], 'UserStore', ast.ClassDef)
    decorator = extract(trees['helpers/decorators.py'], 'user_type_exempt', ast.FunctionDef)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[user_store, decorator], type_ignores=[])),
                 '<pinned-source-page-model-decorator>', 'exec'), namespace)
    helpers_tree = ast.parse((root / 'helpers/helpers.py').read_text())
    helpers = extract(helpers_tree, 'Helpers', ast.ClassDef)
    checkin = next(node for node in helpers.body if isinstance(node, ast.FunctionDef) and node.name == 'get_checkin_store')
    checkin_namespace = dict(namespace)

    class RedisCheckinTransport:
        values = {}

        def exists(self, key):
            return key in self.values

        def get(self, key):
            return self.values[key]

    redis = RedisCheckinTransport()
    checkin_namespace['redis_instance'] = redis
    exec(compile(ast.fix_missing_locations(ast.Module(body=[checkin], type_ignores=[])),
                 '<pinned-source-checkin-helper>', 'exec'), checkin_namespace)
    setattr(namespace['Helpers'], 'get_checkin_store', staticmethod(checkin_namespace['get_checkin_store']))
    pages = [extract(trees['core/views.py'], name, ast.ClassDef) for name in ('ProductsView', 'ProductsStockView')]
    exec(compile(ast.fix_missing_locations(ast.Module(body=pages, type_ignores=[])),
                 '<pinned-source-page-dispatch>', 'exec'), namespace)
    namespace['ProductsStockView'].response_class = staticmethod(
        lambda request, template, context, **options: render(request, template[0], context))
    state.update({'redis': redis, 'anonymousClass': AnonymousUser})
    return state


def page_call(state, payload):
    from django.contrib.messages.storage.fallback import FallbackStorage
    base.require(set(payload) == {'command', 'page', 'method', 'actorId', 'storeIds', 'checkinStoreId'},
                 'INVALID_SOURCE_PAGE_INPUT')
    base.require(payload['page'] in ('catalog', 'matrix') and payload['method'] in ('GET', 'POST'),
                 'INVALID_SOURCE_PAGE_TARGET')
    base.require(payload['page'] != 'matrix' or payload['method'] == 'GET', 'MATRIX_PAGE_IS_GET_ONLY')
    factory = state['factory']
    request = factory.post('/products/', {'stores[]': payload['storeIds']}) if payload['method'] == 'POST' else factory.get('/stock-management/' if payload['page'] == 'matrix' else '/products/')
    request.session = {}
    request._messages = FallbackStorage(request)
    actor = payload['actorId']
    if actor is None:
        request.user = state['anonymousClass']()
    else:
        base.require(isinstance(actor, str) and actor.isdecimal(), 'INVALID_SOURCE_PAGE_ACTOR')
        with state['connections']['default'].cursor() as cursor:
            cursor.execute('SELECT id,role,user_type,is_active FROM pos_user WHERE id=%s', [actor])
            row = cursor.fetchone()
        base.require(row and row[3] == 1, 'NATIVE_SOURCE_PAGE_ACTOR_REQUIRED')
        request.user = SimpleNamespace(id=row[0], role=row[1], user_type=row[2], is_authenticated=True, is_anonymous=False)
    state['redis'].values = {}
    if payload['checkinStoreId'] is not None:
        identifier = payload['checkinStoreId']
        base.require(isinstance(identifier, str) and identifier.isdecimal() and actor is not None,
                     'INVALID_SOURCE_CHECKIN_TRANSPORT')
        state['redis'].values['check_in_' + actor] = json.dumps([int(identifier), 'Fixture check-in'])
    state['pageContext'] = None
    name = 'ProductsView' if payload['page'] == 'catalog' else 'ProductsStockView'
    response = state['namespace'][name].as_view()(request)
    return {'kind': 'page', 'status': response.status_code, 'context': state['pageContext'],
            'html': response.content.decode() if response.status_code == 200 else None}


def main():
    state = None
    try:
        for line in sys.stdin:
            base.require(len(line) <= 2_000_000, 'SOURCE_PAGE_INPUT_TOO_LARGE')
            value = json.loads(line)
            if state is None:
                state = extend(base.configure(value), Path(value['sourceRoot']).resolve())
                base.send({'kind': 'ready', 'sourcePin': base.SOURCE_PIN, 'sourceHashes': state['sourceHashes']})
            elif value == {'command': 'close'}:
                break
            elif value.get('command') == 'page':
                base.send(page_call(state, value))
            else:
                base.send(base.call(state, value))
    except Exception as error:
        code = error.args[0] if error.args and isinstance(error.args[0], str) and re.fullmatch(r'[A-Z_]{1,100}', error.args[0]) else None
        base.send({'kind': 'error', 'code': code or 'SOURCE_NATIVE_UI_FAILED', 'errorKind': type(error).__name__})
        raise SystemExit(1) from None
    finally:
        if state:
            state['connections'].close_all()


if __name__ == '__main__':
    main()
