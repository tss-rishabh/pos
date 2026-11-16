"""Execute pinned contact-reference helpers in a rollback-only isolated LOCAL MySQL transaction."""

import ast
import datetime as dates
import enum
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote, urlparse

from dateutil.parser import parse
from sqlalchemy import Enum, MetaData, Table, create_engine, text
from sqlalchemy.engine import URL
from sqlalchemy.orm import Session, declarative_base


def main():
    payload = json.load(sys.stdin)
    url = urlparse(payload["database"])
    if (
        url.scheme != "mysql"
        or url.hostname not in ["localhost", "127.0.0.1"]
        or not re.fullmatch(
            r"pos_rewrite_customer_contacts_test_[a-z0-9_]+", url.path[1:]
        )
    ):
        raise ValueError("ISOLATED_LOCAL_SCHEMA_REQUIRED")
    customer = str(payload["customerId"])
    if (
        not re.fullmatch(r"[1-9][0-9]{0,18}", customer)
        or int(customer) > 9223372036854775807
    ):
        raise ValueError("SOURCE_CUSTOMER_INVALID")
    wall = dates.datetime.fromisoformat(payload["wallTime"])
    backend = Path(__file__).resolve().parents[2]
    source = backend.parent.parent / "backend-tss-api_v2"
    manifest = json.loads(
        (backend / "compatibility/customer-contacts/source-manifest.json").read_text()
    )
    files = {}
    for item in manifest["files"]:
        result = subprocess.run(
            ["git", "show", manifest["sourceCommit"] + ":" + item["path"]],
            cwd=source,
            check=True,
            capture_output=True,
        )
        if hashlib.sha256(result.stdout).hexdigest() != item["sha256"]:
            raise ValueError("SOURCE_BASELINE_CHANGED")
        files[item["path"]] = result.stdout.decode()
    model_tree = ast.parse(files["models/User.py"])
    attributes = next(
        node
        for node in model_tree.body
        if isinstance(node, ast.ClassDef) and node.name == "Attributes"
    )
    namespace = {"enum": enum}
    exec(  # noqa: S102 -- Pinned repository AST only, never input-supplied code.
        compile(
            ast.fix_missing_locations(ast.Module(body=[attributes], type_ignores=[])),
            "<pinned-contact-enum>",
            "exec",
        ),
        namespace,
    )
    engine = create_engine(
        URL.create(
            "mysql+pymysql",
            username=unquote(url.username),
            password=unquote(url.password or ""),
            host=url.hostname,
            port=url.port or 3306,
            database=url.path[1:],
            query={"charset": "utf8mb4"},
        ),
        echo=False,
        connect_args={"connect_timeout": 3, "read_timeout": 10, "write_timeout": 10},
    )
    metadata = MetaData()
    base = declarative_base()
    classes = {}
    for name, table_name in [
        ("User", "users"),
        ("UserEAV", "user_eav"),
        ("JPCustomersModel", "jp_customers"),
        ("GiftVoucherModal", "gift_vouchers"),
        ("UserEmailMembershipCopyLog", "user_email_membership_copy_logs"),
    ]:
        table = Table(table_name, metadata, autoload_with=engine)
        if name == "UserEAV":
            table.c.attribute.type = Enum(namespace["Attributes"])
        classes[name] = type(name, (base,), {"__table__": table})

    class FixedDateTime(dates.datetime):
        @classmethod
        def now(cls, tz=None):
            if tz is not None:
                raise ValueError("SOURCE_EXPECTS_NAIVE_WALL_CLOCK")
            return wall

    namespace.update(classes)
    namespace.update(
        {
            "datetime": FixedDateTime,
            "parse": parse,
            "text": text,
            "settings": SimpleNamespace(
                REFUND_SUCCESS_STATUS="SUCCESS", REFUND_FAILED_STATUS="FAILED"
            ),
            "logger": SimpleNamespace(info=lambda *_args: None),
        }
    )
    selected = {
        "is_email_taken",
        "is_email_shared",
        "carry_membership_to_email",
        "carry_email_references",
        "carry_refund_emails",
        "active_exclusive_expiry",
    }
    tree = ast.parse(files["controllers/UserController.py"])
    constants = [
        node
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "USER_ORDERS_SQL"
            for target in node.targets
        )
    ]
    functions = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in selected
    ]
    if len(functions) != len(selected) or len(constants) != 1:
        raise ValueError("SOURCE_HELPERS_MISSING")
    exec(  # noqa: S102 -- Pinned repository AST only, never input-supplied code.
        compile(
            ast.fix_missing_locations(
                ast.Module(body=constants + functions, type_ignores=[])
            ),
            "<pinned-contact-references>",
            "exec",
        ),
        namespace,
    )
    projections = {
        "user_eav": "entity,attribute,value,is_active,created_at,updated_at",
        "user_email_membership_copy_logs": "user_id,old_email,new_email,shared_user_ids,exclusive_expiry,created_at",
        "jp_customers": "id,`user`,email,deleted_at",
        "gift_vouchers": "id,to_id",
        "welcome_offer": "id,email_id",
        "bank_transfer_requests": "id,email,status",
        "refund_alternate_payment_details": "id,email,status",
    }
    ordering = {
        "user_eav": "entity,attribute",
        "user_email_membership_copy_logs": "user_id,old_email,new_email",
    }
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)
    try:
        if namespace["is_email_taken"](session, payload["newEmail"]):
            raise ValueError("SOURCE_EMAIL_CONFLICT")
        namespace["carry_membership_to_email"](
            session, int(customer), payload["oldEmail"], payload["newEmail"]
        )
        namespace["carry_email_references"](
            session, int(customer), payload["oldEmail"], payload["newEmail"]
        )
        remails = namespace["carry_refund_emails"](
            session, int(customer), payload["newEmail"]
        )
        session.flush()
        tables = {}
        for table, projection in projections.items():
            statement = (
                "SELECT "
                + projection
                + " FROM `"
                + table
                + "` ORDER BY "
                + ordering.get(table, "id")
            )
            rows = session.execute(text(statement)).mappings().all()
            tables[table] = [dict(row) for row in rows]
            bigint_fields = (
                ["user_id"]
                if table == "user_email_membership_copy_logs"
                else ["id"]
                if table
                in [
                    "gift_vouchers",
                    "welcome_offer",
                    "bank_transfer_requests",
                    "refund_alternate_payment_details",
                ]
                else []
            )
            for row in tables[table]:
                for field in bigint_fields:
                    row[field] = str(row[field])
        result = {
            "sourceCommit": manifest["sourceCommit"],
            "tables": tables,
            "refundRemails": sorted(
                [
                    {"orderId": str(row[0]), "refundRequestId": str(row[1])}
                    for row in remails
                ],
                key=lambda row: (int(row["orderId"]), int(row["refundRequestId"])),
            ),
        }

        def serialize(value):
            if isinstance(value, dates.datetime):
                return value.strftime("%Y-%m-%d %H:%M:%S")
            raise TypeError("SOURCE_OUTPUT_UNSUPPORTED")

        json.dump(result, sys.stdout, default=serialize)
    finally:
        session.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
        engine.dispose()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Only static class/function/line metadata, never exception messages or locals.
        trace = error.__traceback__
        frames = []
        while trace is not None:
            frames.append(
                {"function": trace.tb_frame.f_code.co_name, "line": trace.tb_lineno}
            )
            trace = trace.tb_next
        json.dump(
            {
                "error": "SOURCE_CONTACT_ORACLE_FAILED",
                "kind": type(error).__name__,
                "frames": frames,
            },
            sys.stdout,
        )
        sys.exit(1)
