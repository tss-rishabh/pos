"""Private disposable fixture handoff, never production credential discovery."""
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlparse
from sqlalchemy.engine import make_url


def read_membership_account(admin_url):
    admin = urlparse(admin_url)
    path = Path(os.environ['POS_IMPORT_NATIVE_ACCOUNT_FILE'])
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 64000:
        raise RuntimeError('Private fixture authority required')
    account = json.loads(path.read_text())
    if (not isinstance(account, dict) or set(account) != {'applicationUrl', 'environment'}
            or not isinstance(account['environment'], dict)
            or any(not isinstance(key, str) or not isinstance(value, str)
                   for key, value in account['environment'].items())):
        raise RuntimeError('Invalid fixture authority')
    application = make_url(account['applicationUrl'])
    if (admin.scheme not in ('mysql', 'mysql+pymysql')
            or admin.hostname not in ('127.0.0.1', 'localhost')
            or not re.fullmatch(r'/(?:pos_checkout_contract_test|pos_rewrite_import_runtime_[a-f0-9]{12})', admin.path)
            or application.drivername != 'mysql' or application.host != admin.hostname
            or application.port != admin.port or '/' + application.database != admin.path
            or not re.fullmatch(r'nh_app_[a-z0-9]+', application.username or '')
            or not application.password or application.query):
        raise RuntimeError('Independent disposable fixture account required')
    return application.set(drivername='mysql+pymysql').render_as_string(hide_password=False), account['environment']
