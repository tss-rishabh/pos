"""Pinned list queries read isolated MySQL only; mutation methods use memory-only recorders."""

import ast
import hashlib
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlparse


class MemorySelection(list):
    def update(self, **changes):
        for row in self:
            row.update(changes)


class MemoryCollection:
    def __init__(self, rows):
        self.rows = rows

    def filter(self, **filters):
        return MemorySelection(
            row
            for row in self.rows
            if all(row.get(key) == value for key, value in filters.items())
        )

    def create(self, **values):
        row = {"id": 77, **values}
        self.rows.append(row)
        return SimpleNamespace(**row)


def main():
    payload = json.load(sys.stdin)
    cases = payload["cases"]
    if len(cases) > 50:
        raise ValueError("SOURCE_CASE_LIMIT")
    database = payload.get("database")
    url = urlparse(database) if database else None
    if url and (
        url.scheme != "mysql"
        or url.hostname not in ["127.0.0.1", "localhost"]
        or not re.fullmatch(
            r"pos_rewrite_gift_card_batches_test_[a-z0-9_]+", url.path[1:]
        )
    ):
        raise ValueError("ISOLATED_LOCAL_SCHEMA_REQUIRED")
    import django

    if django.get_version() != "4.2.5":
        raise ValueError("PINNED_SOURCE_DJANGO_REQUIRED")
    import pymysql

    pymysql.install_as_MySQLdb()
    from django.conf import settings

    databases = (
        {
            "default": {
                "ENGINE": "django.db.backends.mysql",
                "NAME": url.path[1:],
                "HOST": url.hostname,
                "PORT": str(url.port or 3306),
                "USER": unquote(url.username or ""),
                "PASSWORD": unquote(url.password or ""),
                "OPTIONS": {"charset": "utf8mb4"},
            }
        }
        if url
        else {}
    )
    settings.configure(
        SECRET_KEY="isolated-gift-card-oracle",
        USE_TZ=False,
        USE_I18N=False,
        INSTALLED_APPS=["django.contrib.auth", "django.contrib.contenttypes"],
        DATABASES=databases,
    )
    django.setup()
    from django.contrib.auth.models import AbstractUser
    from django.core.exceptions import FieldError
    from django.core.paginator import EmptyPage, PageNotAnInteger, Paginator
    from django.core.serializers.json import DjangoJSONEncoder
    from django.db import connection, models
    from django.db.models import Q
    from django.http import HttpResponse

    class GiftCardCollection(models.Model):
        id = models.BigIntegerField(primary_key=True)
        size = models.IntegerField()
        is_completed = models.IntegerField()
        is_printed = models.IntegerField()
        is_block = models.IntegerField()
        message = models.CharField(max_length=255, null=True)
        created_by = models.BigIntegerField()
        created_at = models.DateTimeField()

        class Meta:
            app_label = "isolated_gift_oracle"
            db_table = "gift_card_collection"
            managed = False

    class Operator(models.Model):
        id = models.BigIntegerField(primary_key=True)
        first_name = models.CharField(max_length=150)
        last_name = models.CharField(max_length=150)
        get_full_name = AbstractUser.get_full_name

        class Meta:
            app_label = "isolated_gift_oracle"
            db_table = "pos_user"
            managed = False

    backend = Path(__file__).resolve().parents[2]
    source = backend.parent.parent / "backend-pos-web"
    expected = {
        row["path"]: row["sha256"]
        for row in json.loads((backend / "parity/legacy-inventory.json").read_text())[
            "source_hashes"
        ]
    }

    def declaration(filename, original_name, selected):
        data = (source / filename).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected[filename]:
            raise ValueError("SOURCE_BASELINE_CHANGED")
        original = next(
            node
            for node in ast.parse(data.decode()).body
            if isinstance(node, ast.ClassDef) and node.name == original_name
        )
        return ast.ClassDef(
            name=original_name,
            bases=[],
            keywords=[],
            body=[
                node
                for node in original.body
                if isinstance(node, ast.FunctionDef) and node.name in selected
            ],
            decorator_list=[],
        )

    declarations = [
        declaration(
            "helpers/helpers.py", "Helpers", ["get_admin_names", "clean_email"]
        ),
        declaration(
            "core/datatables/gift_card_datatable.py",
            "AjaxGiftCardListView",
            ["datatables"],
        ),
        *[
            declaration("core/views.py", name, ["post"])
            for name in [
                "AjaxGenerateGiftCardView",
                "AjaxPrintGiftCardView",
                "AjaxBlockGiftCardView",
            ]
        ],
    ]
    namespace = {
        "User": Operator,
        "GiftCardCollection": GiftCardCollection,
        "Q": Q,
        "Paginator": Paginator,
        "EmptyPage": EmptyPage,
        "PageNotAnInteger": PageNotAnInteger,
        "HttpResponse": HttpResponse,
        "json": json,
        "re": re,
    }
    exec(  # noqa: S102 -- Only pinned repository AST methods execute; input never supplies code.
        compile(
            ast.fix_missing_locations(ast.Module(body=declarations, type_ignores=[])),
            "<pinned-source-gift-card-views>",
            "exec",
        ),
        namespace,
    )
    if url:
        connection.ensure_connection()
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
    results = []
    for case in cases:
        operation = case["operation"]
        if operation == "list":
            if not url:
                raise ValueError("ISOLATED_LOCAL_SCHEMA_REQUIRED")
            values = {
                "search[value]": case.get("search", ""),
                "order[0][column]": "0",
                "order[0][dir]": case.get("direction", "desc"),
                "columns[0][data]": case.get("sort", "id"),
                "start": str(case.get("start", 0)),
                "draw": "1",
                "length": str(case.get("length", 10)),
            }
            try:
                result = namespace["AjaxGiftCardListView"]().datatables(
                    SimpleNamespace(POST=values)
                )
                result["recordsTotal"] = str(result["recordsTotal"])
                result["recordsFiltered"] = str(result["recordsFiltered"])
                for row in result["data"]:
                    row["id"] = str(row["id"])
                results.append(json.loads(json.dumps(result, cls=DjangoJSONEncoder)))
            except FieldError:
                results.append({"error": "FieldError"})
            continue
        rows = [dict(row) for row in case.get("rows", [])]
        calls = []
        namespace["GiftCardCollection"] = SimpleNamespace(
            objects=MemoryCollection(rows)
        )
        namespace["tasks"] = SimpleNamespace(
            generate_and_upload_gift_card=lambda *args, recorded_calls=calls: (
                recorded_calls.append(list(args))
            )
        )
        request = SimpleNamespace(
            POST=case.get("input", {}),
            user=SimpleNamespace(
                id=1,
                email=case.get("email", "fixture@example.test"),
                phone=case.get("phone", "9999999999"),
            ),
        )
        classes = {
            "generate": "AjaxGenerateGiftCardView",
            "print": "AjaxPrintGiftCardView",
            "block": "AjaxBlockGiftCardView",
        }
        if operation not in classes:
            raise ValueError("SOURCE_OPERATION_UNSUPPORTED")
        view = namespace[classes[operation]]()
        view.request = request
        response = json.loads(view.post(request).content)
        results.append({"response": response, "rows": rows, "generationCalls": calls})
        namespace["GiftCardCollection"] = GiftCardCollection
    if url:
        connection.close()
    json.dump(
        {
            "sourceHashes": {
                name: expected[name]
                for name in [
                    "helpers/helpers.py",
                    "core/datatables/gift_card_datatable.py",
                    "core/views.py",
                ]
            },
            "cases": results,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- Static failure omits input, credentials and raw exceptions.
        json.dump({"error": "SOURCE_GIFT_CARD_VIEW_ORACLE_FAILED"}, sys.stdout)
        sys.exit(1)
