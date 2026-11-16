"""Execute bridge acceptance/fencing on the already isolated LOCAL Node contact fixture."""

import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import unquote, urlparse

from sqlalchemy import create_engine, func, select
from sqlalchemy.engine import URL
from sqlalchemy.orm import sessionmaker

backend = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(backend / "compatibility/customer-contacts"))
from contract import acknowledgement
from models import jobs, receipts
from service import ContactEffects


def main():
    data = json.load(sys.stdin)
    url = urlparse(data["database"])
    if (
        url.scheme != "mysql"
        or url.hostname not in ["127.0.0.1", "localhost"]
        or not re.fullmatch(
            r"pos_rewrite_customer_contacts_test_[a-z0-9_]+", url.path[1:]
        )
    ):
        raise ValueError("ISOLATED_LOCAL_SCHEMA_REQUIRED")
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
        hide_parameters=True,
        pool_size=8,
        max_overflow=16,
        pool_timeout=5,
        connect_args={"connect_timeout": 3, "read_timeout": 10, "write_timeout": 10},
    )
    try:
        with engine.begin() as connection:
            for statement in re.sub(
                r"^--.*$",
                "",
                (backend / "compatibility/customer-contacts/migration.sql").read_text(),
                flags=re.MULTILINE,
            ).split(";"):
                if statement.strip():
                    connection.exec_driver_sql(statement)
        sessions = sessionmaker(engine, expire_on_commit=False)
        body = data["body"]
        service = ContactEffects(
            sessions, data["transportKey"], "synthetic-native-bridge-storage-key-" * 2
        )
        with ThreadPoolExecutor(max_workers=20) as executor:
            responses = list(
                executor.map(lambda _index: service.accept(body), range(20))
            )
        if any(value != acknowledgement(body) for value in responses):
            raise ValueError("ACK_MISMATCH")
        calls = []

        def adapter(kind, _job, _payload, _detail):
            calls.append(kind)
            return "accepted"

        # Cache invalidation is an explicit prerequisite. Then multiple workers
        # cannot claim/publish the same remaining obligation concurrently.
        service.drain_one(adapter)
        with ThreadPoolExecutor(max_workers=20) as executor:
            list(executor.map(lambda _index: service.drain_one(adapter), range(20)))
        # SKIP LOCKED polls may legitimately find no claim while another
        # transaction holds the next row. Subsequent bounded worker ticks drain
        # any remaining obligations; an already published job is never repeated.
        for _index in range(5 + len(body["payload"]["refundRemails"])):
            service.drain_one(adapter)
        with sessions() as session:
            receipt_count = session.execute(
                select(func.count())
                .select_from(receipts)
                .where(receipts.c.id == body["deliveryId"])
            ).scalar_one()
            job_count = session.execute(
                select(func.count())
                .select_from(jobs)
                .where(jobs.c.receipt_id == body["deliveryId"])
            ).scalar_one()
            succeeded = session.execute(
                select(func.count())
                .select_from(jobs)
                .where(
                    jobs.c.receipt_id == body["deliveryId"],
                    jobs.c.status == "SUCCEEDED",
                )
            ).scalar_one()
        expected = 5 + len(body["payload"]["refundRemails"])
        if (
            receipt_count != 1
            or job_count != expected
            or succeeded != expected
            or len(calls) != expected
            or calls[0] != "auth-cache"
        ):
            raise ValueError("DURABLE_EFFECT_MISMATCH")
        json.dump(
            {
                "ack": responses[0],
                "receiptCount": receipt_count,
                "jobCount": job_count,
                "succeeded": succeeded,
                "publishCalls": len(calls),
            },
            sys.stdout,
        )
    finally:
        engine.dispose()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 -- Static failure kind only; never exception messages or source rows.
        json.dump(
            {
                "error": "CONTACT_BRIDGE_ORACLE_FAILED",
                "kind": type(error).__name__,
                "reason": str(error)
                if str(error)
                in [
                    "ACK_MISMATCH",
                    "DURABLE_EFFECT_MISMATCH",
                    "ISOLATED_LOCAL_SCHEMA_REQUIRED",
                ]
                else "INTERNAL",
            },
            sys.stdout,
        )
        sys.exit(1)
