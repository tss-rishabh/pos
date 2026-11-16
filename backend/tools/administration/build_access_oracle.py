"""Generate framework permission evidence using pinned Django and an in-memory database only."""
import hashlib
import inspect
import itertools
import json
from pathlib import Path

import django
from django.conf import settings

if django.get_version() != "4.2.5":
    raise RuntimeError("Use the source-pinned Django 4.2.5 for this oracle.")
settings.configure(
    SECRET_KEY="isolated-access-oracle",
    INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes"],
    DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}},
    AUTHENTICATION_BACKENDS=["django.contrib.auth.backends.ModelBackend"],
    USE_TZ=True,
)
django.setup()
from django.core.management import call_command
from django.contrib.auth.models import Group, Permission, User
from django.contrib.contenttypes.models import ContentType
from django.contrib.admin import AdminSite
from django.contrib.auth.backends import ModelBackend
from django.contrib.auth.forms import UsernameField
from django.core.exceptions import ValidationError
from types import SimpleNamespace

call_command("migrate", verbosity=0, interactive=False)
content_type = ContentType.objects.create(app_label="stores", model="store")
change = Permission.objects.create(content_type=content_type, codename="change_store", name="Change fixture store")
view = Permission.objects.create(content_type=content_type, codename="view_store", name="View fixture store")
group_view = Permission.objects.get(content_type__app_label="auth", codename="view_group")
group = Group.objects.create(name="Isolated fixture group")
group.permissions.add(view, group_view)
site = AdminSite()
cases = []
for index, (active, staff, superuser, direct, membership) in enumerate(itertools.product([False, True], repeat=5)):
    user = User.objects.create(username=f"fixture{index}", is_active=active, is_staff=staff, is_superuser=superuser)
    if direct:
        user.user_permissions.add(change)
    if membership:
        user.groups.add(group)
    grants = (["stores.change_store"] if direct else []) + (["stores.view_store", "auth.view_group"] if membership else [])
    cases.append({
        "account": {"isActive": active, "isStaff": staff, "isSuperuser": superuser},
        "grants": grants,
        "site": site.has_permission(SimpleNamespace(user=user)),
        "permissions": {key: user.has_perm(key) for key in ["stores.change_store", "stores.view_store", "auth.view_group", "users.change_posuser"]},
    })
sources = {"model-backend": inspect.getsourcefile(ModelBackend), "user-model": inspect.getsourcefile(User), "admin-site": inspect.getsourcefile(AdminSite), "username-field": inspect.getsourcefile(UsernameField), "username-validator": inspect.getsourcefile(User.username_validator.__class__)}
username_cases = []
username_field = UsernameField(max_length=150, validators=[User.username_validator])
for value in ["floor.fixture", "ｆｌｏｏｒ.ｆｉｘｔｕｒｅ", "cafe\u0301", "Straße", "汉字", " x ", "\u001cx\u001f", "\ufeffx", "", "has space", "a/b", "½", "a" * 150, "a" * 151, "𐐀" * 150, "e\u0301" * 100]:
    try:
        cleaned = username_field.clean(value)
        username_cases.append({"input":value,"valid":True,"value":cleaned})
    except ValidationError:
        username_cases.append({"input":value,"valid":False})
result = {"djangoVersion": django.get_version(), "database": "isolated SQLite :memory:", "sourceHashes": {name: hashlib.sha256(Path(path).read_bytes()).hexdigest() for name, path in sources.items()}, "cases": cases, "usernameCases": username_cases}
output = Path(__file__).resolve().parents[2] / "parity/administration-access-oracle.json"
output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({"djangoVersion": result["djangoVersion"], "cases": len(cases)}))
