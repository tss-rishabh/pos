"""Inventory pinned source references and demonstrate Django's collector in SQLite :memory: only."""

import ast
import hashlib
import inspect
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

FRAMEWORK_SOURCE_HASHES = {
    "collector": "4a486c648cdbd28ac68593aec59a82fd1884110443549de767546b37e8945aa3",
    "model-admin": "6ec6f17f63b5d59e6c98091e2d0459d75234d12ee3adfa8343a7c48e5ec090f9",
    "delete-selected": "be3c006463067f8ae3949488686397fbb49f3f45e69094ffd3ae6c1a1603c83f",
    "nested-objects": "36ececcc1c00c0e457e0cac92f0427cdd7c4db3b95892631e758c4d0af00e466",
    "log-entry": "cbedaccad27557e2a784aa94cfc29f421a3fc33c4d6cd857437f151b8d4a6f4f",
    "user": "ec32a1649744813926d63dfc5bf0527cc437aa1d72f8086a984950f241ca8406",
    "model": "24fa9de51f41179ca166bf6fc7d3ade969804fde870450e5c6e76e15ffc76b9a",
    "auth-admin": "9160a8e50274bba60806b2bc46bdab8b2df9e1b42f08c0fdb71cd69715b6bab4",
    "admin-site": "e66217c4fda5294b946ba6dbaeebbe156d7aa636266cd24ebb68af838f170b47",
}


def source_inventory(backend):
    baseline = json.loads((backend / "parity/legacy-inventory.json").read_text())
    expected = {item["path"]: item["sha256"] for item in baseline["source_hashes"]}
    source = backend.parent.parent / "backend-pos-web"
    paths = sorted({item["file"] for item in baseline["models"]})
    relations, store_ids, operator_ids = [], [], []
    hashes = {}
    for name in paths:
        data = (source / name).read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != expected[name]:
            raise ValueError("SOURCE_BASELINE_CHANGED")
        hashes[name] = digest
        for model in ast.parse(data.decode()).body:
            if not isinstance(model, ast.ClassDef):
                continue
            table = None
            for item in model.body:
                if isinstance(item, ast.ClassDef) and item.name == "Meta":
                    for field in item.body:
                        if isinstance(field, ast.Assign) and any(
                            isinstance(target, ast.Name) and target.id == "db_table"
                            for target in field.targets
                        ):
                            table = ast.literal_eval(field.value)
            for field in model.body:
                if not isinstance(field, ast.Assign) or not isinstance(
                    field.value, ast.Call
                ):
                    continue
                call = field.value
                kind = ast.unparse(call.func).split(".")[-1]
                for target in field.targets:
                    if not isinstance(target, ast.Name):
                        continue
                    item = {
                        "file": name,
                        "line": field.lineno,
                        "model": model.name,
                        "table": table,
                        "field": target.id,
                        "type": kind,
                    }
                    if kind in [
                        "ForeignKey",
                        "OneToOneField",
                        "ManyToManyField",
                        "LegacyForeignKey",
                    ]:
                        item["target"] = (
                            ast.unparse(call.args[0]) if call.args else None
                        )
                        item["onDelete"] = next(
                            (
                                ast.unparse(value.value)
                                for value in call.keywords
                                if value.arg == "on_delete"
                            ),
                            None,
                        )
                        if item["target"] in ["Store", "PosUser", "User", "Group"]:
                            relations.append(item)
                    elif target.id == "store_id":
                        store_ids.append(item)
                    elif target.id in [
                        "django_user_id",
                        "pos_user_id",
                        "pos_admin_id",
                        "added_by",
                        "updated_by",
                        "created_by",
                        "closed_by_id",
                        "updated_by_id",
                        "export_requested_by",
                    ]:
                        item["semanticStatus"] = "unclassified-until-domain-proof"
                        operator_ids.append(item)
    for name in ["stores/admin.py", "users/admin.py", "POSAdmin/settings.py"]:
        digest = hashlib.sha256((source / name).read_bytes()).hexdigest()
        if digest != expected[name]:
            raise ValueError("SOURCE_BASELINE_CHANGED")
        hashes[name] = digest
    return {
        "sourceCommit": baseline["source_commit"],
        "sourceHashes": hashes,
        "registeredModels": [
            {
                "key": "users.PosUser",
                "registration": "users/admin.py:20",
                "administration": "UserAdmin",
            },
            {
                "key": "stores.Store",
                "registration": "stores/admin.py:6",
                "administration": "ModelAdmin",
            },
            {
                "key": "auth.Group",
                "registration": "Django4.2.5 auth.admin autodiscovery",
                "administration": "GroupAdmin",
            },
        ],
        "registeredTargetRelations": relations,
        "scalarStoreReferences": store_ids,
        "scalarOperatorCandidates": operator_ids,
    }


def main():
    import django

    if django.get_version() != "4.2.5":
        raise ValueError("PINNED_DJANGO_REQUIRED")
    backend = Path(__file__).resolve().parents[2]
    inventory = source_inventory(backend)
    with TemporaryDirectory(prefix="pos-collector-oracle-") as temporary:
        package = Path(temporary) / "collector_fixture"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "urls.py").write_text("urlpatterns=[]\n")
        models = "from django.db import models\nclass Parent(models.Model):\n name=models.CharField(max_length=20)\n"
        for name, policy, constraint in [
            ("Cascading", "CASCADE", True),
            ("Restricted", "DO_NOTHING", True),
            ("Unconstrained", "DO_NOTHING", False),
            ("Protected", "PROTECT", True),
            ("Nullable", "SET_NULL", True),
        ]:
            models += f"class {name}(models.Model):\n parent=models.ForeignKey(Parent,on_delete=models.{policy},null={policy == 'SET_NULL'},db_constraint={constraint})\n"
        models += (
            "class ScalarReference(models.Model):\n parent_id=models.IntegerField()\n"
        )
        (package / "models.py").write_text(models)
        sys.path.insert(0, temporary)
        from django.conf import settings

        settings.configure(
            SECRET_KEY="in-memory-collector-oracle",
            ROOT_URLCONF="collector_fixture.urls",
            INSTALLED_APPS=[
                "django.contrib.auth",
                "django.contrib.contenttypes",
                "django.contrib.admin",
                "collector_fixture",
            ],
            DATABASES={
                "default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}
            },
            USE_TZ=False,
            LANGUAGE_CODE="en-us",
        )
        django.setup()
        from collector_fixture import models as fixture
        from django.contrib.admin import AdminSite, ModelAdmin
        from django.contrib.admin.actions import delete_selected
        from django.contrib.admin.models import LogEntry
        from django.contrib.admin.utils import NestedObjects
        from django.contrib.auth.admin import GroupAdmin, UserAdmin
        from django.contrib.auth.models import Group, Permission, User
        from django.contrib.contenttypes.models import ContentType
        from django.core.management import call_command
        from django.db import IntegrityError, transaction
        from django.db import models as orm
        from django.db.models.deletion import Collector, ProtectedError
        from django.http import HttpResponse
        from django.test import RequestFactory

        framework = {
            "collector": Collector,
            "model-admin": ModelAdmin,
            "delete-selected": delete_selected,
            "nested-objects": NestedObjects,
            "log-entry": LogEntry,
            "user": User,
            "model": orm.Model,
            "auth-admin": UserAdmin,
            "admin-site": AdminSite,
        }
        hashes = {
            name: hashlib.sha256(
                Path(inspect.getsourcefile(value)).read_bytes()
            ).hexdigest()
            for name, value in framework.items()
        }
        if hashes != FRAMEWORK_SOURCE_HASHES:
            raise ValueError("FRAMEWORK_SOURCE_HASH_MISMATCH")
        call_command("migrate", verbosity=0, interactive=False, run_syncdb=True)
        cases = []
        for name in [
            "Empty",
            "Cascading",
            "Restricted",
            "Unconstrained",
            "Protected",
            "Nullable",
            "ScalarReference",
        ]:
            parent = fixture.Parent.objects.create(name="fixture")
            parent_id = parent.pk
            child = (
                None
                if name == "Empty"
                else getattr(fixture, name).objects.create(parent_id=parent_id)
            )
            collector = NestedObjects(using="default")
            collector.collect([parent])
            preview = sorted(
                model._meta.model_name
                for model, objects in collector.data.items()
                for _ in objects
            )
            error = None
            try:
                with transaction.atomic():
                    parent.delete()
            except (IntegrityError, ProtectedError) as caught:
                error = type(caught).__name__
            child_state = None
            if child is not None:
                saved = (
                    child.__class__.objects.filter(pk=child.pk)
                    .values_list("parent_id", flat=True)
                    .first()
                )
                child_state = {
                    "exists": child.__class__.objects.filter(pk=child.pk).exists(),
                    "reference": saved,
                }
            cases.append(
                {
                    "kind": name,
                    "previewModels": preview,
                    "protected": len(collector.protected),
                    "error": error,
                    "parentExists": fixture.Parent.objects.filter(
                        pk=parent_id
                    ).exists(),
                    "child": child_state,
                }
            )
        actor = User.objects.create(
            username="synthetic-actor", is_active=True, is_staff=True, is_superuser=True
        )
        authored = User.objects.create(username="synthetic-authored")
        content_type = ContentType.objects.get_for_model(fixture.Parent)
        LogEntry.objects.log_action(
            user_id=authored.id,
            content_type_id=content_type.id,
            object_id="1",
            object_repr="fixture",
            action_flag=2,
            change_message="Changed fixture.",
        )
        authored_id = authored.id
        authored.delete()
        cases.append(
            {
                "kind": "AuthoredLogCascade",
                "authoredLogsRemaining": LogEntry.objects.filter(
                    user_id=authored_id
                ).count(),
            }
        )
        member = User.objects.create(username="synthetic-member")
        group = Group.objects.create(name="synthetic-group")
        group.permissions.add(Permission.objects.first())
        member.groups.add(group)
        group.delete()
        cases.append(
            {
                "kind": "GroupMembershipCascade",
                "memberExists": User.objects.filter(pk=member.id).exists(),
                "membershipsRemaining": member.groups.count(),
            }
        )

        class FixtureAdmin(ModelAdmin):
            def response_delete(self, request, object_display, object_id):
                return HttpResponse("synthetic")

            def message_user(self, request, message, **kwargs):
                return None

        site = AdminSite()
        site.register(fixture.Parent, FixtureAdmin)

        class FixtureUserAdmin(UserAdmin):
            def response_delete(self, request, object_display, object_id):
                return HttpResponse("synthetic")

            def message_user(self, request, message, **kwargs):
                return None

        site.register(User, FixtureUserAdmin)
        site.register(Group, GroupAdmin)
        from collector_fixture import urls
        from django.urls import path

        urls.urlpatterns = [path("admin/", site.urls)]
        administration = site._registry[fixture.Parent]
        from itertools import product
        from types import SimpleNamespace

        permission_cases = []
        delete_permission = Permission.objects.get(
            content_type=content_type, codename="delete_parent"
        )
        permission_group = Group.objects.create(name="synthetic-delete-grant")
        permission_group.permissions.add(delete_permission)
        for index, (active, staff, superuser, direct, membership) in enumerate(
            product([False, True], repeat=5)
        ):
            operator = User.objects.create(
                username=f"permission-fixture-{index}",
                is_active=active,
                is_staff=staff,
                is_superuser=superuser,
            )
            if direct:
                operator.user_permissions.add(delete_permission)
            if membership:
                operator.groups.add(permission_group)
            request = SimpleNamespace(user=operator)
            permission_cases.append(
                {
                    "account": {
                        "active": active,
                        "staff": staff,
                        "superuser": superuser,
                        "directDelete": direct,
                        "groupDelete": membership,
                    },
                    "siteAllowed": site.has_permission(request),
                    "modelDeleteAllowed": administration.has_delete_permission(request),
                    "combinedAllowed": site.has_permission(request)
                    and administration.has_delete_permission(request),
                }
            )
        User.objects.filter(username__startswith="permission-fixture-").delete()
        permission_group.delete()
        for action in ["SingleDelete", "BulkDelete"]:
            parent = fixture.Parent.objects.create(name="fixture")
            fixture.Restricted.objects.create(parent=parent)
            target_id = parent.id
            request = RequestFactory().post("/synthetic/", {"post": "yes"})
            request.user = actor
            request._dont_enforce_csrf_checks = True
            before = LogEntry.objects.filter(
                user_id=actor.id, content_type=content_type, object_id=str(target_id)
            ).count()
            error = None
            try:
                if action == "SingleDelete":
                    administration.delete_view(request, str(target_id))
                else:
                    delete_selected(
                        administration,
                        request,
                        fixture.Parent.objects.filter(pk=target_id),
                    )
            except (IntegrityError, ProtectedError) as caught:
                error = type(caught).__name__
            after = LogEntry.objects.filter(
                user_id=actor.id, content_type=content_type, object_id=str(target_id)
            ).count()
            cases.append(
                {
                    "kind": action,
                    "error": error,
                    "parentExists": fixture.Parent.objects.filter(
                        pk=target_id
                    ).exists(),
                    "committedDeletionLogDelta": after - before,
                }
            )
        self_actor = User.objects.create(
            username="synthetic-self-last-superuser",
            is_active=True,
            is_staff=True,
            is_superuser=True,
        )
        actor.is_superuser = False
        actor.save(update_fields=["is_superuser"])
        self_id = self_actor.id
        request = RequestFactory().post("/synthetic/", {"post": "yes"})
        request.user = self_actor
        request._dont_enforce_csrf_checks = True
        user_admin = site._registry[User]
        allowed = user_admin.has_delete_permission(request, self_actor)
        superusers_before = User.objects.filter(is_superuser=True).count()
        LogEntry.objects.log_action(
            user_id=self_id,
            content_type_id=content_type.id,
            object_id="1",
            object_repr="fixture",
            action_flag=2,
            change_message="Changed fixture.",
        )
        user_admin.delete_view(request, str(self_id))
        cases.append(
            {
                "kind": "SelfLastSuperuserDelete",
                "authorized": allowed,
                "superusersBefore": superusers_before,
                "error": None,
                "operatorExists": User.objects.filter(pk=self_id).exists(),
                "remainingAuthoredLogs": LogEntry.objects.filter(
                    user_id=self_id
                ).count(),
            }
        )
        metadata = json.loads(
            (backend / "evidence/mysql-administration-inbound-schema.json").read_text()
        )
        json.dump(
            {
                **inventory,
                "djangoVersion": django.get_version(),
                "database": "SQLite :memory: only",
                "frameworkHashes": hashes,
                "inheritedDeleteMethods": {
                    "UserAdmin": UserAdmin.has_delete_permission
                    is ModelAdmin.has_delete_permission,
                    "GroupAdmin": GroupAdmin.has_delete_permission
                    is ModelAdmin.has_delete_permission,
                },
                "deletePermissionCases": permission_cases,
                "physicalInboundMetadata": {
                    "path": "evidence/mysql-administration-inbound-schema.json",
                    "sha256": hashlib.sha256(
                        (
                            backend
                            / "evidence/mysql-administration-inbound-schema.json"
                        ).read_bytes()
                    ).hexdigest(),
                    "inboundForeignKeys": metadata["inboundForeignKeys"],
                    "errors": metadata["errors"],
                },
                "collectorCases": cases,
                "destructiveEndpointsImplemented": False,
            },
            sys.stdout,
            indent=2,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Static tool boundary suppresses payload/connection traceback details.
        json.dump(
            {"error": "SOURCE_COLLECTOR_ORACLE_FAILED", "kind": type(error).__name__},
            sys.stdout,
        )
        sys.exit(1)
