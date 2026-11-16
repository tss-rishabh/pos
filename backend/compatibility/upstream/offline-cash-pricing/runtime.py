"""Gunicorn factory for the pinned upstream Python artifact, separate from Node."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from contextlib import contextmanager
from pathlib import Path

from app import create_app
from budget import check_deadline, remaining_milliseconds
from source_calculator import PricingError


class SourceRow(dict):
    def __getitem__(self, key):
        return (
            tuple(self.values())[key] if type(key) is int else super().__getitem__(key)
        )


class ReadOnlyExecutor:
    def __init__(self, connection):
        self.connection = connection

    def select(self, query, parameters, *, limit):
        from sqlalchemy import bindparam, text

        if not query.lstrip().upper().startswith("SELECT ") or ";" in query:
            raise PricingError("SOURCE_QUERY_UNSUPPORTED")
        remaining = remaining_milliseconds()
        # A new read cannot consume a fresh 20-second allowance after earlier
        # work. This optimizer hint changes the deadline, never the row result.
        query = query.lstrip()
        statement = text(
            "SELECT /*+ MAX_EXECUTION_TIME(" + str(remaining) + ") */ " + query[7:]
        )
        for name, value in parameters.items():
            if isinstance(value, (tuple, list)):
                statement = statement.bindparams(bindparam(name, expanding=True))
        result = self.connection.execute(statement, parameters)
        rows = result.fetchmany(limit)
        if len(rows) == limit:
            result.close()
            raise PricingError("SOURCE_RESULT_TOO_LARGE")
        result.close()
        check_deadline()
        return [SourceRow(row._mapping) for row in rows]


@contextmanager
def reader_session(engine):
    from sqlalchemy import text

    check_deadline()
    with engine.connect().execution_options(
        isolation_level="REPEATABLE READ"
    ) as connection:
        connection.execute(text("SET SESSION TRANSACTION READ ONLY"))
        connection.execute(text("SET SESSION MAX_EXECUTION_TIME=20000"))
        connection.commit()
        try:
            check_deadline()
            connection.execute(
                text("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
            )
            if (
                connection.execute(
                    text("SELECT @@session.transaction_read_only")
                ).scalar_one()
                != 1
            ):
                raise PricingError("SOURCE_READER_NOT_VERIFIED", 503)
            yield ReadOnlyExecutor(connection)
        finally:
            connection.rollback()


def create_application():
    # No legacy main/database module, handlers, Redis clients or persistence startup.
    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url

    try:
        source_root = Path(os.environ["POS_OFFLINE_SOURCE_ROOT"]).resolve(strict=True)
        ca_path = Path(os.environ["POS_OFFLINE_MYSQL_CA_FILE"]).resolve(strict=True)
        url = make_url(os.environ["POS_OFFLINE_MYSQL_READER_URL"])
        if (
            url.drivername != "mysql+pymysql"
            or not all((url.host, url.username, url.password, url.database))
            or url.query
        ):
            raise ValueError()
        engine = create_engine(
            url,
            future=True,
            echo=False,
            hide_parameters=True,
            pool_size=4,
            max_overflow=4,
            pool_pre_ping=True,
            pool_timeout=5,
            pool_recycle=300,
            connect_args={
                "ssl": {"ca": str(ca_path), "check_hostname": True},
                "connect_timeout": 5,
                "read_timeout": 25,
                "write_timeout": 5,
            },
        )
        settings_path = source_root / "settings.py"
        if hashlib.sha256(settings_path.read_bytes()).hexdigest() != (
            "10f18f0098b02363e66853945ebe8c971fafd5d32c2d29648d5ef8f8faf80917"
        ):
            raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
        specification = importlib.util.spec_from_file_location(
            "pos_offline_source_settings", settings_path
        )
        if specification is None or specification.loader is None:
            raise PricingError("SOURCE_REVISION_UNVERIFIED", 503)
        settings = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(settings)

        def emit(event):
            sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
            sys.stdout.flush()

        pricing = create_app(
            source_root,
            settings,
            lambda: reader_session(engine),
            os.environ["POS_OFFLINE_SERVICE_KEY"],
            business_timezone=os.environ.get(
                "POS_OFFLINE_BUSINESS_TIMEZONE", "Asia/Kolkata"
            ),
            emit=emit,
        )
        from template_app import PATH as template_path
        from template_app import create_template_app

        template = create_template_app(
            source_root,
            settings,
            lambda: reader_session(engine),
            os.environ["POS_OFFLINE_SERVICE_KEY"],
            business_timezone=os.environ.get(
                "POS_OFFLINE_BUSINESS_TIMEZONE", "Asia/Kolkata"
            ),
            emit=emit,
        )

        def application(environ, start_response):
            handler = template if environ.get("PATH_INFO") == template_path else pricing
            return handler(environ, start_response)

        return application
    except Exception:
        raise RuntimeError(
            "Offline cash pricing configuration is unavailable"
        ) from None
