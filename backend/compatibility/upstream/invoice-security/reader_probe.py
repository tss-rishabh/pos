"""Guarded isolated MySQL probe for the production reader-engine constructor."""
import json
import sys
from sqlalchemy import text
from factory import reader_engine
from runtime_probe import run_runtime

request = json.load(sys.stdin)
engine = reader_engine(request["url"], local_test=True)
try:
    with engine.connect() as connection:
        before = connection.execute(text("SELECT @@SESSION.sql_mode")).scalar_one()
        selected = connection.execute(text("SELECT marker FROM invoice_read_guard WHERE id=1")).scalar_one()
        rejected = False
        try:
            connection.execute(text("INSERT INTO invoice_read_guard(id,marker) VALUES (2,'forbidden')"))
            connection.commit()
        except Exception:
            rejected = True
            connection.rollback()
        rows = connection.execute(text("SELECT COUNT(*) FROM invoice_read_guard")).scalar_one()
        after = connection.execute(text("SELECT @@SESSION.sql_mode")).scalar_one()
    print(json.dumps({"selected": selected, "writeRejected": rejected, "rows": rows, "sqlModeUnchanged": before == after,
                      "runtime": run_runtime(request["url"])}))
finally:
    engine.dispose()
