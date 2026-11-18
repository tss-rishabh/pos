"""Pinned complete forms/views on native synthetic rows and real Django sessions.

The four child templates and their shared form partial are genuine source. Only
unrelated global-layout chrome is replaced by a block container; no form field,
validation, ORM operation, permission decorator or selected view body is mocked.
"""
import ast
from contextlib import redirect_stdout, redirect_stderr
import datetime
import hashlib
from html.parser import HTMLParser
import io
import json
import logging
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory
import traceback
from types import ModuleType, SimpleNamespace
from urllib.parse import unquote, urlsplit

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
urlpatterns = []


class Controls(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inputs = []
        self.selects = {}
        self.selected = None

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == 'input' and values.get('name'):
            self.inputs.append({'name': values['name'], 'type': values.get('type', 'text'),
                                'disabled': 'disabled' in values, 'readonly': 'readonly' in values,
                                'value': values.get('value', '')})
        if tag == 'select':
            self.selected = values.get('name')
            if self.selected:
                self.selects[self.selected] = []
        if tag == 'option' and self.selected:
            self.selects[self.selected].append(values.get('value', ''))

    def handle_endtag(self, tag):
        if tag == 'select':
            self.selected = None


def main():
    payload = json.load(sys.stdin)
    root = Path(payload['source']).resolve()
    assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    database = urlsplit(payload['database'])
    assert database.scheme == 'mysql' and database.hostname == '127.0.0.1' and database.port
    assert not database.query and not database.fragment
    assert re.fullmatch(r'pos_rewrite_barcodes_[a-f0-9]{12}', database.path[1:])
    hashes = {}

    def source(name):
        raw = subprocess.check_output(['git', '-C', str(root), 'show', PIN + ':' + name], stderr=subprocess.DEVNULL)
        hashes[name] = hashlib.sha256(raw).hexdigest()
        return raw.decode()

    def nodes(name, selected, kinds=(ast.ClassDef,)):
        found = [n for n in ast.parse(source(name)).body if isinstance(n, kinds) and n.name in selected]
        assert len(found) == len(selected)
        return found

    import django
    import pymysql
    assert django.get_version() == '4.2.5'
    pymysql.install_as_MySQLdb()
    settings_tree = ast.parse(source('POSAdmin/settings.py'))
    validator_node = next(n for n in settings_tree.body if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == 'AUTH_PASSWORD_VALIDATORS' for t in n.targets))
    validators = ast.literal_eval(validator_node.value)
    with TemporaryDirectory(prefix='pos-source-forms-') as temporary:
        for app, names, imports in [
            ('users', ['PosUser', 'UserStore'], 'from django.db import models\nfrom django.contrib.auth.models import AbstractUser\nfrom django.core.validators import MinLengthValidator\n'),
            ('stores', ['Store', 'TssSetting', 'StoreCounter', 'Country', 'POSFranchise'], 'import json\nfrom django.db import models\nfrom django.core.validators import MinLengthValidator\n'),
            ('order', ['MUser'], 'from django.db import models\n'),
        ]:
            path = Path(temporary) / app
            path.mkdir()
            (path / '__init__.py').write_text('')
            (path / 'models.py').write_text(imports + '\n'.join(ast.unparse(n) for n in nodes(app + '/models.py', names)))
        sys.path.insert(0, temporary)
        templates = {'admin/layouts/base.html': '<!doctype html><html><body>{% block maincontent %}{% endblock %}{% block custom-script %}{% endblock %}</body></html>'}
        for name in ['auth/create.html', 'auth/edit.html']:
            templates[name] = source('users/templates/' + name)
        for name in ['stores/create.html', 'stores/edit.html', 'stores/_form.html']:
            templates[name] = source('stores/templates/' + name)
        from django.conf import settings
        settings.configure(
            SECRET_KEY='synthetic-forms-source-session-only', USE_TZ=False, USE_I18N=False,
            TIME_ZONE='Asia/Kolkata', DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
            AUTH_USER_MODEL='users.PosUser', AUTH_PASSWORD_VALIDATORS=validators,
            ALLOWED_HOSTS=['testserver'], ROOT_URLCONF=__name__, LOGIN_URL='/login/',
            SESSION_ENGINE='django.contrib.sessions.backends.signed_cookies', LOGGING_CONFIG=None,
            INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions', 'django.contrib.messages', 'users', 'stores', 'order'],
            MIDDLEWARE=['django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware', 'django.contrib.messages.middleware.MessageMiddleware'],
            TEMPLATES=[{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'OPTIONS': {
                'context_processors': ['django.template.context_processors.request', 'django.contrib.auth.context_processors.auth', 'django.contrib.messages.context_processors.messages'],
                'loaders': [('django.template.loaders.locmem.Loader', templates)]}}],
            DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': database.path[1:],
                                  'HOST': database.hostname, 'PORT': database.port,
                                  'USER': unquote(database.username or ''), 'PASSWORD': unquote(database.password or ''),
                                  'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}},
        )
        django.setup()
        logging.disable(logging.CRITICAL)
        from django import forms
        from django.contrib import messages
        from django.contrib.auth.forms import UserCreationForm
        from django.contrib.auth.mixins import LoginRequiredMixin
        from django.contrib.auth.password_validation import validate_password
        from django.core.validators import MaxValueValidator, MinValueValidator, RegexValidator
        from django.db import connection, connections, transaction
        from django.forms.utils import ErrorList
        from django.http import HttpResponse
        from django.shortcuts import render, redirect
        from django.test import Client
        from django.test.utils import setup_test_environment
        from django.middleware.csrf import _get_new_csrf_string
        setup_test_environment()
        from django.urls import include, path, reverse
        from django.utils.decorators import method_decorator
        from django.views import View
        from functools import wraps
        from users.models import PosUser, UserStore
        from stores.models import Store, TssSetting, StoreCounter, Country, POSFranchise
        from order.models import MUser
        namespace = {'__name__': __name__, 'forms': forms, 'UserCreationForm': UserCreationForm,
                     'validate_password': validate_password, 'MaxValueValidator': MaxValueValidator,
                     'MinValueValidator': MinValueValidator, 'RegexValidator': RegexValidator, 'ErrorList': ErrorList,
                     'User': PosUser, 'UserStore': UserStore, 'Store': Store, 'TssSetting': TssSetting,
                     'StoreCounter': StoreCounter, 'Country': Country, 'POSFranchise': POSFranchise, 'MUser': MUser,
                     'json': json, 'datetime': datetime, 'messages': messages, 'redirect': redirect, 'render': render,
                     'wraps': wraps, 'method_decorator': method_decorator, 'LoginRequiredMixin': LoginRequiredMixin,
                     'View': View, 'HttpResponse': HttpResponse, 'connection': connection,
                     'connections': connections, 'transaction': transaction, 'logger': logging.getLogger('source-forms'),
                     'STOREDEFAULTUSER': payload['defaultContacts'], 'SLACK_CONNECT_BROADCAST_CHANNEL': 'synthetic-source-form'}
        for filename, selected in [('users/forms.py', ['phone_validation', 'alphanumeric', 'email_val', 'ROLE_CHOICES', 'MOBILE', 'EMAIL', 'OTP_METHOD_CHOICES', 'IN_HOUSE', 'FRANCHISE', 'USER_TYPE_CHOICES']),
                                   ('stores/forms.py', ['phone_validation', 'type_choices', 'storage_type_choices', 'store_category_choices'])]:
            tree = ast.parse(source(filename))
            chosen = [n for n in tree.body if isinstance(n, ast.Assign)
                      and any(isinstance(t, ast.Name) and t.id in selected for t in n.targets)]
            exec(compile(ast.Module(body=chosen, type_ignores=[]), filename, 'exec'), namespace)
            names = ['UserCreateForm', 'OtherUserUpdateForm'] if filename.startswith('users') else ['StoreCreateForm']
            exec(compile(ast.Module(body=nodes(filename, names), type_ignores=[]), filename, 'exec'), namespace)
        helpers = nodes('helpers/helpers.py', ['Helpers'])[0]
        helpers.body = [n for n in helpers.body if isinstance(n, ast.FunctionDef) and n.name in ['create_muser', 'create_counter']]
        assert len(helpers.body) == 2
        exec(compile(ast.Module(body=[helpers], type_ignores=[]), 'helpers/helpers.py', 'exec'), namespace)
        exec(compile(ast.Module(body=nodes('helpers/decorators.py', ['advance_permisson'], (ast.FunctionDef,)), type_ignores=[]), 'helpers/decorators.py', 'exec'), namespace)
        exec(compile(ast.Module(body=nodes('users/views.py', ['_log_user_store_change'], (ast.FunctionDef,)), type_ignores=[]), 'users/views.py', 'exec'), namespace)
        for filename, names in [('users/views.py', ['CreateUserView', 'EditUserProfileView']), ('stores/views.py', ['CreateStoreView', 'EditStoreView']), ('core/views.py', ['GetCountryNameView', 'GetLocationByPincodeView'])]:
            exec(compile(ast.Module(body=nodes(filename, names), type_ignores=[]), filename, 'exec'), namespace)
        wrapper = {'__name__': __name__}
        exec(compile(source('POSAdmin/connection_handler.py'), 'POSAdmin/connection_handler.py', 'exec'), wrapper)
        namespace.update({'path': path, 'sync_to_async': wrapper['sync_to_async'],
                          'user_views': SimpleNamespace(**namespace), 'stores_views': SimpleNamespace(**namespace),
                          'core_views': SimpleNamespace(**namespace)})
        selected_routes = []
        route_ids = []
        for filename, lines in [('users/urls.py', [17, 18]), ('stores/urls.py', [11, 14]), ('core/urls.py', [31, 167])]:
            calls = [n for n in ast.walk(ast.parse(source(filename))) if isinstance(n, ast.Call)
                     and isinstance(n.func, ast.Name) and n.func.id == 'path' and n.lineno in lines]
            assert len(calls) == 2
            routes = [eval(compile(ast.Expression(n), filename, 'eval'), namespace) for n in calls]
            route_ids += [filename + ':' + str(n.lineno) for n in calls]
            if filename.startswith('core'):
                selected_routes += routes
            else:
                module = ModuleType(filename.replace('/', '.')[:-3])
                module.urlpatterns = routes
                sys.modules[module.__name__] = module
        mounts = [n for n in ast.walk(ast.parse(source('POSAdmin/urls.py')))
                  if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'path'
                  and len(n.args) == 2 and isinstance(n.args[1], ast.Call)
                  and isinstance(n.args[1].func, ast.Name) and n.args[1].func.id == 'include'
                  and n.args[1].args and isinstance(n.args[1].args[0], ast.Constant)
                  and n.args[1].args[0].value in ['stores.urls', 'users.urls']]
        assert len(mounts) == 2
        global urlpatterns
        urlpatterns = selected_routes + [eval(compile(ast.Expression(n), 'POSAdmin/urls.py', 'eval'), {'path': path, 'include': include}) for n in mounts]
        # Unexercised reverse-only layout/provider destinations; none replaces a selected view.
        for route, name in [('login/', 'login'), ('users/', 'users_list_view'), ('stores/', 'stores'),
                            ('dashboard/', 'shortcut_dashboard'), ('stores/slack/connect/', 'store_slack_connect')]:
            urlpatterns.append(path(route, lambda request: HttpResponse('Unexercised destination'), name=name))
        client = Client(enforce_csrf_checks=True, raise_request_exception=True)
        case = payload['case']
        assert case['actorId'] in ['1', '2', '3', '4', '5', '11', '13']
        client.force_login(PosUser.objects.get(pk=int(case['actorId'])))
        resource = case['resource']
        assert resource in ['operators', 'stores'] and case['action'] in ['create', 'update']
        route_name = ('create_user' if case['action'] == 'create' else 'user_edit') if resource == 'operators' else ('create_store' if case['action'] == 'create' else 'edit_store')
        url = reverse(route_name, kwargs={'pk': int(case['targetId'])} if case['action'] == 'update' else {})
        before = client.get(url)
        try:
            initial_form = before.context['userform' if resource == 'operators' else 'storeform'] if before.context else None
        except KeyError:
            initial_form = None
        form_defaults = {name: initial_form[name].value() for name in ['role', 'otp_method', 'user_type', 'category', 'type', 'city_id', 'country_id', 'state_id'] if initial_form is not None and name in initial_form.fields}
        controls = Controls()
        controls.feed(before.content.decode())
        csrf = next((v['value'] for v in controls.inputs if v['name'] == 'csrfmiddlewaretoken'), None)
        body = dict(case['post'])
        if not csrf:
            csrf = _get_new_csrf_string()
            client.cookies['csrftoken'] = csrf
        body['csrfmiddlewaretoken'] = csrf
        postal = None
        if case.get('postal'):
            response = client.get('/get-location-by-pincode/', {'pincode': '400001'})
            postal = json.loads(response.content)
            value = postal['data']
            body.update({'city_name': value.get('city', ''), 'state_name': value.get('state', ''),
                         'country_id': value.get('country_id', ''), 'state_id': value.get('state_id', ''),
                         'latitude': value.get('latitude', ''), 'longitude': value.get('longitude', '')})
        # Use the actual source hidden value, including its edit-reset quirk.
        city = next((v['value'] for v in controls.inputs if v['name'] == 'city_id'), None)
        if resource == 'stores' and city is not None:
            body['city_id'] = city
        result = client.post(url, body)
        form_key = 'userform' if resource == 'operators' else 'storeform'
        try:
            bound_form = result.context[form_key] if result.context else None
        except KeyError:
            bound_form = None
        password = body.get('userform-password1') if case['action'] == 'create' else body.get('password1')
        password_valid = None
        if resource == 'operators' and password:
            account = PosUser.objects.filter(email=body.get('userform-email')).first() if case['action'] == 'create' else PosUser.objects.filter(pk=int(case['targetId'])).first()
            password_valid = account.check_password(password) if account else False
        safe_controls = {'inputNames': [v['name'] for v in controls.inputs],
                         'hiddenCity': city, 'selects': controls.selects,
                         'hasPasswordFields': any(v['type'] == 'password' for v in controls.inputs)}
        # Never export source's password hashes or the noisy printed cleaned_data.
        json.dump({'sourceCommit': PIN, 'routeIds': route_ids, 'hashes': hashes,
                   'getStatus': before.status_code, 'postStatus': result.status_code,
                   'controls': safe_controls, 'formDefaults': form_defaults, 'postal': postal,
                   'validationFields': sorted(bound_form.errors) if bound_form is not None else [],
                   'sourcePasswordValid': password_valid}, sys.__stdout__)
        connection.close()


if __name__ == '__main__':
    try:
        # The original views print submitted credentials. Suppress those streams
        # entirely; only the explicitly safe result above reaches the parent IPC.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            main()
    except Exception as error:
        frames = [{'file': Path(f.filename).name if re.fullmatch(r'[A-Za-z0-9_.-]+', Path(f.filename).name) else 'internal', 'line': f.lineno} for f in traceback.extract_tb(error.__traceback__)]
        code = error.args[0] if error.args and type(error.args[0]) is int else None
        sys.__stdout__.write(json.dumps({'error': 'SOURCE_FORMS_FAILED', 'kind': type(error).__name__, 'mysqlCode': code, 'frames': frames}) + '\n')
        sys.exit(1)
