"""Execute the pinned Django history formatter/paginator with synthetic data only."""

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import django
from django.conf import settings

settings.configure(
    SECRET_KEY="synthetic-administration-history",
    USE_TZ=False,
    USE_I18N=True,
    LANGUAGE_CODE="en-us",
    INSTALLED_APPS=[
        "django.contrib.auth",
        "django.contrib.contenttypes",
        "django.contrib.admin",
    ],
    DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}},
)
django.setup()
from django.contrib.admin.models import LogEntry
from django.contrib.auth.models import User
from django.core.paginator import Paginator
from django.utils.formats import date_format
from django.utils.translation import override


def main():
    if django.get_version() != "4.2.5":
        raise ValueError("PINNED_DJANGO_REQUIRED")
    payload = json.load(sys.stdin)
    results = []
    with override("en-us"):
        for case in payload["cases"]:
            if case["operation"] == "message":
                try:
                    result = {
                        "text": LogEntry(
                            change_message=case["raw"]
                        ).get_change_message(),
                        "state": "available",
                    }
                except (KeyError, TypeError, AttributeError):
                    result = {
                        "text": "This history message is unavailable.",
                        "state": "invalid",
                    }
                results.append(result)
            elif case["operation"] == "actor":
                user = User(
                    username=case["username"],
                    first_name=case["firstName"],
                    last_name=case["lastName"],
                )
                name = user.get_username()
                if user.get_full_name():
                    name += " (" + user.get_full_name() + ")"
                results.append(name)
            elif case["operation"] == "page":
                page = Paginator(range(case["total"]), 100).get_page(case["page"])
                results.append(
                    {
                        "page": page.number,
                        "pages": page.paginator.num_pages,
                        "start": page.start_index() - 1 if page.paginator.count else 0,
                        "count": len(page.object_list),
                    }
                )
            elif case["operation"] == "date":
                results.append(
                    date_format(
                        datetime.fromisoformat(case["value"]), "DATETIME_FORMAT"
                    )
                )
            else:
                raise ValueError("SOURCE_OPERATION_UNSUPPORTED")
    models = Path(django.__file__).parent / "contrib/admin/models.py"
    json.dump(
        {
            "djangoVersion": django.get_version(),
            "modelsSha256": hashlib.sha256(models.read_bytes()).hexdigest(),
            "cases": results,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:  # noqa: BLE001 -- Tool boundary emits a static error instead of a payload traceback.
        json.dump({"error": "SOURCE_HISTORY_ORACLE_FAILED"}, sys.stdout)
        sys.exit(1)
