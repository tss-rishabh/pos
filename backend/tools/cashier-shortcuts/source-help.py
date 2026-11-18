"""Execute the exact pinned help view/mounts/templates with Django's real auth.

Identity/session storage and unrelated URL destinations are fixture boundaries.
Signed cookie sessions, auth middleware, LoginRequiredMixin, dispatch, the source's
connection wrapper and source templates are real. No database/network is used.
"""
import ast
import hashlib
from importlib.metadata import version
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

PIN = "78d5b63d6a149a6bf2c748fa1d191799c59ecb8a"
repository = Path(sys.argv[1]).resolve()
inventory = json.loads((Path(__file__).parents[2] / "parity/legacy-inventory.json").read_text())
assert inventory["source_commit"] == PIN
assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip() == PIN
expected = {row["path"]: row["sha256"] for row in inventory["source_hashes"]}
hashes = {}


def source(path):
    raw = subprocess.check_output(["git", "show", PIN + ":" + path], cwd=repository)
    digest = hashlib.sha256(raw).hexdigest()
    if path in expected:
        assert digest == expected[path]
    hashes[path] = digest
    return raw.decode()


templates = {
    "order/shortcuts.html": source("order/templates/order/shortcuts.html"),
    "admin/layouts/base_no_sidebar_navbar.html": source("users/templates/admin/layouts/base_no_sidebar_navbar.html"),
    "admin/includes/header.html": source("users/templates/admin/includes/header.html"),
}
requirements = source("requirements.txt").splitlines()
for requirement in ["Django==4.2.5", "asgiref==3.7.2", "sqlparse==0.4.4", "whitenoise==6.12.0"]:
    assert requirement in requirements
source_settings = ast.parse(source("POSAdmin/settings.py"))
middleware = next(ast.literal_eval(node.value) for node in source_settings.body
                  if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == "MIDDLEWARE" for target in node.targets))

import django
import asgiref
import sqlparse
from django.conf import settings

assert (django.get_version(), asgiref.__version__, sqlparse.__version__) == ("4.2.5", "3.7.2", "0.4.4")
assert version("whitenoise") == "6.12.0"
settings.configure(
    SECRET_KEY="synthetic-help-only-signed-cookie-secret",
    DEBUG=False,
    ALLOWED_HOSTS=["testserver"],
    ROOT_URLCONF=__name__,
    LOGIN_URL="login",
    STATIC_URL="/static/",
    INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes", "django.contrib.sessions", "django.contrib.messages", "django.contrib.staticfiles"],
    DATABASES={"default": {"ENGINE": "django.db.backends.dummy"}},
    MIDDLEWARE=middleware,
    SESSION_ENGINE="django.contrib.sessions.backends.signed_cookies",
    AUTHENTICATION_BACKENDS=[__name__ + ".FixtureBackend"],
    TEMPLATES=[{"BACKEND": "django.template.backends.django.DjangoTemplates", "OPTIONS": {
        "loaders": [("django.template.loaders.locmem.Loader", templates)],
        "libraries": {"static": "django.templatetags.static"},
    }}],
)
django.setup()
from django.contrib.auth.mixins import LoginRequiredMixin
from django.contrib.auth.models import User
from django.contrib.auth import SESSION_KEY, BACKEND_SESSION_KEY, HASH_SESSION_KEY
from django.contrib.sessions.backends.signed_cookies import SessionStore
from django.http import HttpResponse
from django.middleware.csrf import _get_new_csrf_string
from django.shortcuts import render
from django.test import Client
from django.urls import include, path
from django.views import View

users = {}


class FixtureBackend:
    def get_user(self, user_id):
        return users.get(user_id)


namespace = {"__name__": __name__, "LoginRequiredMixin": LoginRequiredMixin, "View": View, "render": render}
view = next(node for node in ast.parse(source("order/views.py")).body
            if isinstance(node, ast.ClassDef) and node.name == "keyShortcutsView")
assert [ast.unparse(base) for base in view.bases] == ["LoginRequiredMixin", "View"]
exec(compile(ast.Module(body=[view], type_ignores=[]), "order/views.py", "exec"), namespace)
wrapper = {"__name__": __name__}
exec(compile(source("POSAdmin/connection_handler.py"), "POSAdmin/connection_handler.py", "exec"), wrapper)
namespace.update({"path": path, "sync_to_async": wrapper["sync_to_async"],
                  "order_views": SimpleNamespace(keyShortcutsView=namespace["keyShortcutsView"])})
route = next(node for node in ast.walk(ast.parse(source("order/urls.py")))
             if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "path"
             and node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value == "key-shortcuts/")
assert route.lineno == 57
child = eval(compile(ast.Expression(route), "order/urls.py", "eval"), namespace)
mounts = []
for node in ast.walk(ast.parse(source("POSAdmin/urls.py"))):
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "path"
            and len(node.args) == 2 and isinstance(node.args[1], ast.Call)
            and isinstance(node.args[1].func, ast.Name) and node.args[1].func.id == "include"
            and isinstance(node.args[1].args[0], ast.Constant) and node.args[1].args[0].value == "order.urls"):
        mounts.append(ast.literal_eval(node.args[0]))
assert mounts == ["api/v1/orders/", "orders/"]
urlpatterns = [path("", lambda request: HttpResponse("fixture login destination"), name="login"),
               path("fixture-notification/", lambda request: HttpResponse(), name="ajax-notification-update")]
urlpatterns += [path(prefix, include([child])) for prefix in mounts]


class Table(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = []
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        if tag == "td":
            self.cell = []

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag == "td" and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        if tag == "tr" and self.row:
            self.rows.append(self.row)


cases = []
rows = None
for prefix in mounts:
    address = "/" + prefix + "key-shortcuts/"
    anonymous = Client(enforce_csrf_checks=True).get(address)
    assert anonymous.status_code == 302 and anonymous.headers["Location"].startswith("/?next=")
    for identity in range(1, 6):
        user = User(pk=identity, username="synthetic-help-" + str(identity), password="!")
        users[identity] = user
        client = Client(enforce_csrf_checks=True)
        # Establish only the fixture identity: do not execute an unrelated login
        # signal or last_login write. Request authentication still traverses the
        # real signed-cookie store and AuthenticationMiddleware below.
        session = SessionStore()
        session[SESSION_KEY] = str(user.pk)
        session[BACKEND_SESSION_KEY] = __name__ + ".FixtureBackend"
        session[HASH_SESSION_KEY] = user.get_session_auth_hash()
        session.save()
        client.cookies[settings.SESSION_COOKIE_NAME] = session.session_key
        response = client.get(address)
        assert response.status_code == 200
        table = Table()
        table.feed(response.content.decode())
        assert [row[1] for row in table.rows] == ["R", "P", "PP", "F", "N", "E", "B", "S", "T"]
        if rows is None:
            rows = table.rows
        assert rows == table.rows
        assert client.head(address).status_code == 200
        assert client.post(address).status_code == 403
        csrf = _get_new_csrf_string()
        client.cookies[settings.CSRF_COOKIE_NAME] = csrf
        assert client.post(address, HTTP_X_CSRFTOKEN=csrf).status_code == 405
        name = settings.SESSION_COOKIE_NAME
        cookie = client.cookies[name].value
        client.cookies[name] = cookie[:-1] + ("A" if cookie[-1] != "A" else "B")
        assert client.get(address).status_code == 302
        cases.append({"mount": prefix, "identityFixture": identity, "authenticatedGet": 200,
                      "authenticatedHead": 200, "authenticatedPost": 405, "missingCsrfPost": 403, "tamperedCookie": 302})
print(json.dumps({"sourceCommit": PIN, "sourceSha256": hashes, "framework": {
    "django": django.get_version(), "asgiref": asgiref.__version__, "sqlparse": sqlparse.__version__, "whitenoise": version("whitenoise")},
    "rows": rows, "cases": cases, "anonymousStatus": 302, "databaseUsed": False,
    "identityBoundary": "in-memory fixture backend; real signed-cookie auth/session middleware",
    "middleware": middleware,
    "sourceApplicationBooted": False}))
