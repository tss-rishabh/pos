"""Pinned Django history query on one explicitly isolated local MySQL schema only."""

import hashlib
import json
import re
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlparse


def main():
    payload = json.load(sys.stdin)
    url = urlparse(payload["database"])
    schema = url.path.lstrip("/")
    if (
        url.scheme != "mysql"
        or url.hostname not in ["127.0.0.1", "localhost"]
        or not re.fullmatch(
            r"pos_rewrite_administration_history_test_[a-z0-9_]+", schema
        )
    ):
        raise ValueError("ISOLATED_LOCAL_SCHEMA_REQUIRED")
    actor_table = payload.get("actorTable", "auth_user")
    if actor_table not in ["auth_user", "pos_user"]:
        raise ValueError("ACTOR_BINDING_REQUIRED")
    import django
    import pymysql

    if django.get_version() != "4.2.5":
        raise ValueError("PINNED_DJANGO_REQUIRED")
    pymysql.install_as_MySQLdb()
    with TemporaryDirectory(prefix="pos-history-oracle-") as temporary:
        package = Path(temporary) / "history_fixture"
        package.mkdir()
        (package / "__init__.py").write_text("")
        (package / "models.py").write_text(
            "from django.db import models\n"
            "from django.contrib.auth.models import AbstractBaseUser\n"
            "class Actor(AbstractBaseUser):\n"
            " id=models.BigIntegerField(primary_key=True)\n"
            " username=models.CharField(max_length=150)\n"
            " first_name=models.CharField(max_length=150)\n"
            " last_name=models.CharField(max_length=150)\n"
            " USERNAME_FIELD='username'\n"
            " def get_full_name(self):return ('%s %s' % (self.first_name,self.last_name)).strip()\n"
            " class Meta:\n"
            f"  app_label='history_fixture';db_table={actor_table!r};managed=False\n"
        )
        sys.path.insert(0, temporary)
        from django.conf import settings

        settings.configure(
            SECRET_KEY="synthetic-history-oracle",
            USE_TZ=False,
            USE_I18N=True,
            LANGUAGE_CODE="en-us",
            AUTH_USER_MODEL="history_fixture.Actor",
            INSTALLED_APPS=[
                "django.contrib.auth",
                "django.contrib.contenttypes",
                "history_fixture",
                "django.contrib.admin",
            ],
            DATABASES={
                "default": {
                    "ENGINE": "django.db.backends.mysql",
                    "NAME": schema,
                    "HOST": url.hostname,
                    "PORT": str(url.port or 3306),
                    "USER": unquote(url.username or ""),
                    "PASSWORD": unquote(url.password or ""),
                    "OPTIONS": {"charset": "utf8mb4"},
                }
            },
        )
        django.setup()
        # Only synthetic actors are read; private credential columns never enter the emitted oracle DTO.
        from django.contrib.admin.models import LogEntry
        from django.contrib.contenttypes.models import ContentType
        from django.core.paginator import Paginator
        from django.db import connection
        from django.utils.formats import date_format
        from django.utils.translation import override

        connection.ensure_connection()
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION TRANSACTION READ ONLY")
        results = []
        with override("en-us"):
            for case in payload["cases"]:
                content_type = ContentType.objects.get(
                    app_label=case["appLabel"], model=case["model"]
                )
                queryset = (
                    LogEntry.objects.filter(
                        object_id=case["objectId"], content_type=content_type
                    )
                    .select_related()
                    .order_by("action_time")
                )
                if case.get("from"):
                    queryset = queryset.filter(action_time__gte=case["from"])
                if case.get("to"):
                    queryset = queryset.filter(action_time__lt=case["to"])
                page = Paginator(queryset, 100).get_page(case.get("page", "1"))
                rows = []
                for entry in page:
                    name = entry.user.get_username()
                    if entry.user.get_full_name():
                        name += " (" + entry.user.get_full_name() + ")"
                    rows.append(
                        {
                            "id": str(entry.id),
                            "actorId": str(entry.user_id),
                            "actor": name,
                            "actionTimeLabel": date_format(
                                entry.action_time, "DATETIME_FORMAT"
                            ),
                            "action": entry.get_change_message(),
                            "actionFlag": entry.action_flag,
                        }
                    )
                results.append(
                    {
                        "total": str(page.paginator.count),
                        "page": str(page.number),
                        "pages": str(page.paginator.num_pages),
                        "data": rows,
                    }
                )
        connection.close()
        source_file = Path(django.__file__).parent / "contrib/admin/options.py"
        json.dump(
            {
                "djangoVersion": django.get_version(),
                "adminOptionsSha256": hashlib.sha256(
                    source_file.read_bytes()
                ).hexdigest(),
                "cases": results,
            },
            sys.stdout,
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Suppress connection/payload details at this tool boundary.
        json.dump(
            {"error": "SOURCE_HISTORY_ORACLE_FAILED", "kind": type(error).__name__},
            sys.stdout,
        )
        sys.exit(1)
