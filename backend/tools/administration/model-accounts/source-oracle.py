"""Pinned actual Django UserAdmin/add and Store ModelForm/save; isolated local fixtures only."""
import ast
import datetime
import hashlib
import inspect
import json
from pathlib import Path
import re
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from urllib.parse import urlparse, unquote


def main():
    payload = json.load(sys.stdin)
    url = urlparse(payload['database'])
    database = url.path.lstrip('/')
    if url.scheme != 'mysql' or url.hostname not in ['localhost', '127.0.0.1'] or not re.fullmatch(r'pos_rewrite_model_accounts_[a-f0-9]{12}', database):
        raise ValueError('ISOLATED_LOCAL_SCHEMA_REQUIRED')
    import django
    import pymysql
    if django.get_version() != '4.2.5':
        raise ValueError('PINNED_DJANGO_REQUIRED')
    pymysql.install_as_MySQLdb()
    backend = Path(__file__).resolve().parents[3]
    source = backend.parent.parent / 'backend-pos-web'
    inventory = json.loads((backend / 'parity/legacy-inventory.json').read_text())
    expected = {row['path']: row['sha256'] for row in inventory['source_hashes']}
    def pinned(filename):
        data = (source / filename).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected[filename]:
            raise ValueError('SOURCE_BASELINE_CHANGED')
        return data.decode()
    with TemporaryDirectory(prefix='pos-model-add-source-') as temporary:
        for name, classes, imports in [('users', ['PosUser'], 'from django.db import models\nfrom django.contrib.auth.models import AbstractUser\nfrom django.core.validators import MinLengthValidator\n'), ('stores', ['Store', 'TssSetting'], 'import json\nfrom django.db import models\nfrom django.core.validators import MinLengthValidator\n')]:
            package = Path(temporary) / name
            package.mkdir()
            (package / '__init__.py').write_text('')
            tree = ast.parse(pinned(name + '/models.py'))
            (package / 'models.py').write_text(imports + '\n'.join(ast.unparse(node) for node in tree.body if isinstance(node, ast.ClassDef) and node.name in classes))
            if name == 'users':
                (package / 'apps.py').write_text(pinned('users/apps.py'))
                (package / 'signals.py').write_text(pinned('users/signals.py'))
        sys.path.insert(0, temporary)
        settings_tree = ast.parse(pinned('POSAdmin/settings.py'))
        validators = ast.literal_eval(next(node.value for node in settings_tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'AUTH_PASSWORD_VALIDATORS' for target in node.targets)))
        from django.conf import settings
        settings.configure(SECRET_KEY='model-add-fixture', USE_TZ=False, TIME_ZONE='Asia/Kolkata', USE_I18N=False, AUTH_USER_MODEL='users.PosUser', INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.admin', 'users', 'stores'], AUTH_PASSWORD_VALIDATORS=validators, DATABASES={'default': {'ENGINE': 'django.db.backends.mysql', 'NAME': database, 'HOST': url.hostname, 'PORT': str(url.port or 3306), 'USER': unquote(url.username or ''), 'PASSWORD': unquote(url.password or ''), 'OPTIONS': {'charset': 'utf8mb4', 'init_command': "SET sql_mode='STRICT_TRANS_TABLES'"}}})
        from django.utils import timezone
        timezone.now = lambda: datetime.datetime(2026, 6, 15, 12, 0, 0)
        django.setup()
        from django.contrib import admin
        from django.contrib.auth.admin import UserAdmin
        from django.db import connection, transaction, IntegrityError, DataError
        from django.test import RequestFactory
        from users.models import PosUser
        from stores.models import Store
        if hashlib.sha256(Path(inspect.getsourcefile(UserAdmin)).read_bytes()).hexdigest() != '9160a8e50274bba60806b2bc46bdab8b2df9e1b42f08c0fdb71cd69715b6bab4':
            raise ValueError('FRAMEWORK_SOURCE_CHANGED')
        exec(compile(pinned('users/admin.py'), '<pinned-user-admin>', 'exec'), {})
        exec(compile(pinned('stores/admin.py'), '<pinned-store-admin>', 'exec'), {})
        request = RequestFactory().get('/fixture')
        request.user = SimpleNamespace(is_active=True, is_staff=True, is_superuser=True, pk=900001, has_perm=lambda _: True, has_module_perms=lambda _: True)
        user_admin = admin.site._registry[PosUser]
        add_form = user_admin.get_form(request)
        results = []
        for case in payload.get('users', []):
            form = add_form({'username': case['username'], 'password1': case['password'], 'password2': case.get('confirmation', case['password'])})
            valid = form.is_valid()
            result = {'valid': valid, 'codes': {key: [error.code for error in errors] for key, errors in form.errors.as_data().items()}}
            if valid:
                try:
                    with transaction.atomic():
                        account = form.save()
                        account.refresh_from_db()
                        row = {field.name: getattr(account, field.name) for field in PosUser._meta.concrete_fields if field.name not in ['password']}
                        row['id'] = str(row['id'])
                        row['date_joined'] = row['date_joined'].isoformat()
                        row['profile_image'] = str(row['profile_image'])
                        row['cover_image'] = str(row['cover_image'])
                        result.update({'account': row, 'passwordValid': account.check_password(case['password'])})
                except IntegrityError:
                    result['saveError'] = 'IntegrityError'
            results.append(result)
        stores = []
        # Source __init__ populates class-level choices from verified settings.
        Store()
        store_form = admin.site._registry[Store].get_form(request)
        for index, supplied in enumerate(payload.get('storeUrls', [])):
            data = {'store_name': 'Synthetic store ' + str(index), 'short_name': 'F-' + str(index), 'phone': '900000000' + str(index), 'latitude': '19.0760000000000000', 'longitude': '72.8777000000000000', 'address': 'Synthetic address', 'alt_address': 'Synthetic alternate address', 'gstin': '22AAAAA0000A1Z5', 'type': 'STORE', 'category': 'IN_HOUSE', 'location_code': 'MDL-' + str(index), 'city_id': 0, 'country_id': 0, 'url_key': supplied, 'is_active': 'on', 'per_day_threshold': 0, 'per_hour_threshold': 0, 'ecom_delivery': 0, 'ecom_threshold': 0, 'franchise_id': 0, 'state_id': 0}
            if payload.get('minimalStore'):
                for field in ['store_name', 'short_name', 'phone', 'latitude', 'longitude', 'address', 'alt_address', 'gstin']:
                    data[field] = ''
            form = store_form(data)
            valid = form.is_valid()
            result = {'valid': valid, 'urlRequired': form.fields['url_key'].required, 'codes': {key: [error.code for error in errors] for key, errors in form.errors.as_data().items()}}
            if valid:
                try:
                    with transaction.atomic():
                        saved = form.save()
                        saved.refresh_from_db()
                        result.update({'id': str(saved.id), 'url': saved.url_key, 'storeName': saved.store_name, 'phone': saved.phone})
                except (IntegrityError, DataError) as failure:
                    result['saveError'] = type(failure).__name__
            stores.append(result)
        permission_pairs = []
        for add in [False, True]:
            for change in [False, True]:
                request.user.has_perm = lambda key, a=add, c=change: a if key.endswith('.add_posuser') else c if key.endswith('.change_posuser') else False
                permission_pairs.append({'add': add, 'change': change, 'sourceAllowed': user_admin.has_add_permission(request) and user_admin.has_change_permission(request)})
        connection.close()
        json.dump({'sourceCommit': inventory['source_commit'], 'hashes': {name: expected[name] for name in ['users/models.py', 'users/admin.py', 'users/apps.py', 'users/signals.py', 'stores/models.py', 'stores/admin.py', 'POSAdmin/settings.py']}, 'addFields': list(add_form.base_fields), 'users': results, 'stores': stores, 'permissions': permission_pairs}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        json.dump({'error': 'MODEL_ADD_SOURCE_ORACLE_FAILED', 'kind': type(failure).__name__, 'reason': str(failure) if str(failure) in ['ISOLATED_LOCAL_SCHEMA_REQUIRED','PINNED_DJANGO_REQUIRED','SOURCE_BASELINE_CHANGED','FRAMEWORK_SOURCE_CHANGED'] else 'fixture-only failure'}, sys.stdout)
        sys.exit(1)
