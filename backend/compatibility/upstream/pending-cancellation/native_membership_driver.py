"""Actual source-helper staging and native all-writer fence, disposable DB only.

Only the model's two used User columns are projected. UserEAV/Attributes,
ensure_user_email, all eight writers and the actual patched PosOrder block are
compiled from the pinned source. No application import, logging or transport.
"""

import ast
from concurrent.futures import ThreadPoolExecutor
import datetime
import enum
import json
import os
from pathlib import Path
import sys
import subprocess
import threading
from types import SimpleNamespace
from urllib.parse import urlparse

import sqlalchemy
from sqlalchemy import Column, Integer, String, Enum, text, event
from sqlalchemy.orm import declarative_base, sessionmaker
from native_membership_account import read_membership_account

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parent / 'screening-origins'))
sys.path.insert(0, str(ROOT.parent / 'public-screening-writer'))
sys.path.insert(0, str(ROOT.parent / 'legacy-order-imports'))
import prepare_membership_producers as producers
from prepare_membership_producers import api_candidates, MUTATORS

# Resolve only fixture I/O from the explicitly pinned checkout. The producer's
# literal source commit and all downstream hashes remain unchanged.
source_root = os.environ.get('MEMBERSHIP_NATIVE_SOURCE_REPOSITORY') or os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT')
if source_root:
    def source(path):
        return subprocess.check_output(
            ['git', 'show', producers.COMMIT + ':' + path],
            cwd=Path(source_root), text=True,
        )
    producers.source = source
else:
    source = producers.source
from membership_provenance import (
    MembershipReview,
    membership_order_stage,
    membership_user_lock,
    defer_membership_invalidation,
    current,
    assert_fence,
    TransactionSession,
)
from membership_fence import statements

raw = os.environ["MEMBERSHIP_NATIVE_URL"]
url = urlparse(raw)
if (
    url.scheme != "mysql+pymysql"
    or url.hostname != "127.0.0.1"
    or url.path != "/pos_checkout_contract_test"
    or not url.port
    or url.query
    or url.password
):
    raise RuntimeError("Disposable native bridge required")
application, metadata_environment = read_membership_account(raw)
os.environ.update(metadata_environment)
engine = sqlalchemy.create_engine(raw, pool_size=24, max_overflow=0, echo=False)
application_engine = sqlalchemy.create_engine(application, pool_size=24, max_overflow=0, echo=False, hide_parameters=True)
Session = sessionmaker(bind=application_engine)
Base = declarative_base()
namespace = {
    "Base": Base,
    "Column": Column,
    "Integer": Integer,
    "String": String,
    "Enum": Enum,
    "enum": enum,
    "datetime": datetime,
}
models = ast.parse(source("models/User.py"))
for node in models.body:
    if isinstance(node, ast.ClassDef) and node.name in ("Attributes", "UserEAV"):
        exec(
            compile(ast.Module(body=[node], type_ignores=[]), "<pinned-membership-model>", "exec"),
            namespace,
        )
    elif isinstance(node, ast.ClassDef) and node.name == "User":
        projected = ast.ClassDef(
            name="User",
            bases=node.bases,
            keywords=[],
            decorator_list=[],
            body=[
                item
                for item in node.body
                if isinstance(item, ast.Assign)
                and any(
                    isinstance(target, ast.Name) and target.id in ("__tablename__", "id", "email")
                    for target in item.targets
                )
            ],
        )
        exec(
            compile(
                ast.fix_missing_locations(ast.Module(body=[projected], type_ignores=[])),
                "<pinned-used-user-projection>",
                "exec",
            ),
            namespace,
        )
namespace.update(
    {
        "membership_user_lock": membership_user_lock,
        "defer_membership_invalidation": defer_membership_invalidation,
        "cache": SimpleNamespace(region_invalidate=lambda *args, **kwargs: None),
        "get_exclusive_token": lambda *args: None,
    }
)
helper = ast.parse(source("libs/helper.py"))
for node in helper.body:
    if isinstance(node, ast.FunctionDef) and node.name in (
        "ensure_user_email",
        "generate_temp_email",
    ):
        exec(
            compile(ast.Module(body=[node], type_ignores=[]), "<pinned-email-helper>", "exec"),
            namespace,
        )
patched = api_candidates()
dal = ast.parse(patched["controllers/user/userDal.py"][1])
for node in dal.body:
    if isinstance(node, ast.FunctionDef) and node.name in MUTATORS:
        exec(
            compile(ast.Module(body=[node], type_ignores=[]), "<patched-original-writer>", "exec"),
            namespace,
        )
controller = ast.parse(patched["controllers/OrderController.py"][1])
block = next(
    node
    for node in ast.walk(controller)
    if isinstance(node, ast.With)
    and any(
        isinstance(item.context_expr, ast.Call)
        and isinstance(item.context_expr.func, ast.Name)
        and item.context_expr.func.id == "membership_order_stage"
        for item in node.items
    )
)
stage_code = compile(
    ast.Module(body=[block], type_ignores=[]), "<actual-patched-PosOrder-membership-block>", "exec"
)
kind = os.environ.get("POS_MEMBERSHIP_BRIDGE_KIND", "new")
settings = SimpleNamespace(
    EXCLUSIVE_PRODUCT={"10": {"expiry_delta": 365}} if kind == "new" else {},
    EXCLUSIVE_UPGRADE_PRODUCT={"10": {"expiry_delta": 365}} if kind == "upgrade" else {},
)


class Cart:
    def update(self, *args):
        pass


def stage():
    with Session() as session:
        values = {
            **namespace,
            "session": session,
            "order": SimpleNamespace(id=5001),
            "settings": settings,
            "user": {
                "user_id": 77,
                "email": "fixture@example.test",
                "is_exclusive": kind == "upgrade",
            },
            "membership_order_stage": membership_order_stage,
            "exclusive_user": {"cart": kind == "new", "active": False},
            "cart": Cart(),
            "get_exclusive_product": lambda cart: {"prod_id": 10} if kind == "new" else None,
            "get_exclusive_upgrade_product": lambda cart: (
                {"prod_id": 10} if kind == "upgrade" else None
            ),
        }
        exec(stage_code, values)


def scalar(query):
    with engine.connect() as connection:
        return connection.execute(text(query)).scalar_one()


def snapshot():
    with engine.connect() as connection:
        return [
            list(connection.execute(text(query)).fetchall())
            for query in [
                "SELECT * FROM user_eav ORDER BY attribute",
                "SELECT * FROM pos_rewrite_membership_versions ORDER BY customer_id",
                "SELECT * FROM pos_rewrite_cancellation_membership_provenance ORDER BY order_id",
            ]
        ]


def execute(query, parameters=None):
    with application_engine.begin() as connection:
        connection.execute(text(query), parameters or {})


def execute_admin(query):
    with engine.begin() as connection:
        connection.execute(text(query))


def staged():
    # The late proof failure occurs after literal source setters called commit;
    # the compatibility facade suppresses those nested commits.
    before = snapshot()
    with Session() as preflight:
        preflight.execute(text('SELECT id FROM users WHERE id=77 FOR UPDATE')).close()
        try:
            from origin_history_privileges import qualified_head_metadata
            qualified_head_metadata(preflight)
            assert_fence(preflight, 'fixture@example.test')
        except Exception as error:
            import traceback
            frames = ','.join(Path(row.filename).name + ':' + str(row.lineno) for row in traceback.extract_tb(error.__traceback__))
            raise AssertionError('Native fixture metadata preflight ' + type(error).__name__ + ' module=' + str(getattr(error, 'name', None)) + ' at ' + frames) from None
    execute_admin('ALTER TABLE pos_rewrite_cancellation_membership_provenance ADD CONSTRAINT fixture_stage_failure CHECK(order_id<0)')
    failures = []
    def native_failure(context):
        original = getattr(context.original_exception, 'args', ())
        if context.statement and context.statement.lstrip().upper().startswith('INSERT INTO POS_REWRITE_CANCELLATION_MEMBERSHIP_PROVENANCE'):
            failures.append(original[0] if original else None)
    event.listen(application_engine, 'handle_error', native_failure)
    try:
        try:
            stage()
            raise AssertionError("Expected atomic stage rejection")
        except MembershipReview as error:
            import traceback

            formatted = ''.join(traceback.format_exception(error))
            assert all(value not in formatted for value in (
                'fixture_stage_failure', 'CHECK(order_id<0)',
                'INSERT INTO pos_rewrite_cancellation_membership_provenance',
            ))
    finally:
        event.remove(application_engine, 'handle_error', native_failure)
        execute_admin('ALTER TABLE pos_rewrite_cancellation_membership_provenance DROP CHECK fixture_stage_failure')
    assert failures == [3819], 'The actual late native provenance insert was not reached'
    assert before == snapshot(), "Nested original commits escaped stage rollback"
    with ThreadPoolExecutor(max_workers=20) as pool:
        list(pool.map(lambda _: stage(), range(20)))
    first = snapshot()
    stage()
    assert first == snapshot(), "Replay staged source twice"
    assert scalar("SELECT COUNT(*) FROM pos_rewrite_cancellation_membership_provenance") == 1
    assert (
        scalar("SELECT contract_version FROM pos_rewrite_cancellation_membership_provenance")
        == "pos-cancellation-membership-staged-v2"
    )
    if kind == "upgrade":
        assert (
            scalar("SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'")
            == "2031-01-01T00:00:00"
        )
    print("actual-source stage: late rollback +20 concurrent callers +exact replay passed")


def fence():
    original = snapshot()
    with application_engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES('fixture@example.test','EXCLUSIVE_NOTIFY','1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
            )
        )
    assert (
        scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
        == original[1][0][1]
    )
    execute("DELETE FROM user_eav WHERE attribute='EXCLUSIVE_NOTIFY'")
    revision = scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
    with application_engine.connect() as connection:
        transaction = connection.begin()
        connection.execute(text("UPDATE user_eav SET value='2' WHERE attribute='EXCLUSIVE_MEMBER'"))
        transaction.rollback()
    assert snapshot() == original, "External rollback advanced revision"
    execute("UPDATE user_eav SET value='2' WHERE attribute='EXCLUSIVE_MEMBER'")
    execute("UPDATE user_eav SET value='1' WHERE attribute='EXCLUSIVE_MEMBER'")
    assert (
        scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
        == revision + 2
    )
    execute("UPDATE users SET email='FIXTURE@example.test' WHERE id=77")
    execute("UPDATE users SET email='fixture@example.test' WHERE id=77")
    assert (
        scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
        == revision + 4
    )
    with application_engine.begin() as connection:
        row = (
            connection.execute(text("SELECT * FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'"))
            .mappings()
            .one()
        )
        connection.execute(text("DELETE FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'"))
        connection.execute(
            text(
                "INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES(:entity,:attribute,:value,:is_active,:created_at,:updated_at)"
            ),
            dict(row),
        )
    assert (
        scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
        == revision + 6
    )
    # An unrelated source writer cannot commit while the financial writer owns
    # the customer fence. Release permits the original DB-only change once.
    with application_engine.connect() as connection, ThreadPoolExecutor(max_workers=1) as pool:
        transaction = connection.begin()
        connection.execute(text("SELECT id FROM users WHERE id=77 FOR UPDATE")).one()
        entered = threading.Event()

        def external_write():
            entered.set()
            execute("UPDATE user_eav SET value='2' WHERE attribute='EXCLUSIVE_MEMBER'")

        future = pool.submit(external_write)
        assert entered.wait(2)
        try:
            from concurrent.futures import TimeoutError

            try:
                future.result(timeout=0.15)
                raise AssertionError("External EAV writer bypassed customer lock")
            except TimeoutError:
                pass
        finally:
            transaction.commit()
        future.result(timeout=5)
    execute("UPDATE user_eav SET value='1' WHERE attribute='EXCLUSIVE_MEMBER'")
    assert (
        scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
        == revision + 8
    )
    # Native collation duplicate owners must refuse, never choose an arbitrary ID.
    execute("INSERT INTO users(id,email,status) VALUES(78,'FIXTURE@example.test',1)")
    try:
        try:
            stage()
            raise AssertionError("Duplicate native-collation owners accepted")
        except MembershipReview:
            pass
        prior = snapshot()
        try:
            execute("UPDATE user_eav SET value='3' WHERE attribute='EXCLUSIVE_MEMBER'")
            raise AssertionError("Ambiguous trigger accepted")
        except sqlalchemy.exc.DBAPIError:
            pass
        assert snapshot() == prior
    finally:
        execute("DELETE FROM users WHERE id=78")
    before_move = scalar(
        "SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77"
    )
    execute("INSERT INTO users(id,email,status) VALUES(78,'other@example.test',1)")
    execute("UPDATE user_eav SET entity='other@example.test' WHERE entity='fixture@example.test'")
    execute("UPDATE user_eav SET entity='fixture@example.test' WHERE entity='other@example.test'")
    assert (
        scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
        == before_move + 4
    )
    assert scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=78") == 4
    execute("DELETE FROM users WHERE id=78")
    # Orphan rows acquire no guessed customer identity or synthetic entitlement.
    versions = scalar("SELECT COUNT(*) FROM pos_rewrite_membership_versions")
    execute(
        "INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES('orphan@example.test','EXCLUSIVE_MEMBER','1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"
    )
    execute("DELETE FROM user_eav WHERE entity='orphan@example.test'")
    assert scalar("SELECT COUNT(*) FROM pos_rewrite_membership_versions") == versions
    # Metadata checks refuse removed trigger bodies and unbounded lookup plans.
    execute_admin("DROP TRIGGER pos_rewrite_mem_eav_insert")
    try:
        with Session() as session:
            try:
                assert_fence(session, "fixture@example.test")
                raise AssertionError("Missing trigger accepted")
            except MembershipReview:
                pass
    finally:
        owner = os.environ['POS_MEMBERSHIP_REVISION_TRIGGER_DEFINER']
        import re
        if not re.fullmatch(r'nh_[A-Za-z0-9_]+@%', owner): raise RuntimeError('Locked fixture owner required')
        definition = next(value for value in statements() if 'CREATE TRIGGER pos_rewrite_mem_eav_insert ' in value)
        execute_admin(definition.replace('CREATE TRIGGER', "CREATE DEFINER='" + owner[:-2] + "'@'%' TRIGGER", 1))
    execute_admin("DROP INDEX fixture_user_email ON users")
    try:
        with Session() as session:
            try:
                assert_fence(session, "fixture@example.test")
                raise AssertionError("Missing email index accepted")
            except MembershipReview:
                pass
    finally:
        execute_admin("CREATE INDEX fixture_user_email ON users(email)")
    print(
        "native fence: insert/update/delete/email, external-writer serialization, notify exclusion, rollback, collation duplicates and metadata refusal passed"
    )


def writers():
    # Execute every original decorated source setter against actual native tables.
    # Independent expiry setters start from a coherent pair, as their callers do.
    class FixtureClock(datetime.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, 17, 12, 13, 14)

    fixed_clock = SimpleNamespace(datetime=FixtureClock, timedelta=datetime.timedelta)
    namespace["datetime"] = fixed_clock
    original = {**namespace, "datetime": fixed_clock}
    for node in ast.parse(patched["controllers/user/userDal.py"][0]).body:
        if isinstance(node, ast.FunctionDef) and node.name in MUTATORS:
            exec(
                compile(
                    ast.Module(body=[node], type_ignores=[]),
                    "<independent-original-membership-writer>",
                    "exec",
                ),
                original,
            )

    def arguments(session, name):
        user = (
            77
            if name.endswith("_check") and "expiry" not in name
            else (
                session.query(namespace["User"]).filter(namespace["User"].id == 77).one()
                if "expiry" in name
                else {"user_id": 77, "email": "fixture@example.test"}
            )
        )
        values = [session, user, 365]
        if name.endswith("_check"):
            values.append(datetime.datetime(2026, 1, 1))
        return values

    for name in sorted(MUTATORS):
        execute("DELETE FROM user_eav WHERE attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY')")
        upgrade = "upgrade" in name
        if upgrade or "expiry" in name:
            execute(
                "INSERT INTO user_eav(entity,attribute,value,is_active,created_at,updated_at) VALUES('fixture@example.test','EXCLUSIVE_MEMBER','1',1,'2025-01-02','2025-01-02'),('fixture@example.test','EXCLUSIVE_EXPIRY','2030-01-01T00:00:00',1,'2025-01-02','2025-01-02')"
            )
        revision = scalar(
            "SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77"
        )
        with Session() as session:
            # The independent original's commits are suppressed only to observe/roll
            # back the literal database result; no candidate decorator runs here.
            original[name](*arguments(TransactionSession(session), name))
            session.flush()
            expected = current(session, "fixture@example.test")
            session.rollback()
        with Session() as session:
            namespace[name](*arguments(session, name))
        with Session() as session:
            assert current(session, "fixture@example.test") == expected, (
                name + " diverged from original native source"
            )
        assert (
            scalar("SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=77")
            > revision
        )
        assert scalar("SELECT COUNT(*) FROM user_eav") == 2
        if upgrade:
            assert (
                scalar("SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'")
                == "2031-01-01T00:00:00"
            )
        elif "expiry" in name and name.endswith("_check"):
            assert (
                scalar("SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'")
                == "2027-01-01T00:00:00"
            )
    # A preloaded ORM identity and consistent-read snapshot must not overwrite
    # a later committed entitlement with a stale calculated expiry.
    execute("UPDATE user_eav SET value='2030-01-01T00:00:00' WHERE attribute='EXCLUSIVE_EXPIRY'")
    with Session() as session:
        old_expiry = (
            session.query(namespace["UserEAV"])
            .filter(namespace["UserEAV"].attribute == namespace["Attributes"].EXCLUSIVE_EXPIRY)
            .one()
        )
        assert old_expiry.value == "2030-01-01T00:00:00"
        execute(
            "UPDATE user_eav SET value='2031-01-01T00:00:00' WHERE attribute='EXCLUSIVE_EXPIRY'"
        )
        namespace["set_exclusive_upgrade_user"](
            session, {"user_id": 77, "email": "fixture@example.test"}, 365
        )
    assert (
        scalar("SELECT value FROM user_eav WHERE attribute='EXCLUSIVE_EXPIRY'")
        == "2032-01-01T00:00:00"
    )
    with Session() as session:
        stale_user = session.query(namespace["User"]).filter(namespace["User"].id == 77).one()
        execute("UPDATE users SET email='changed@example.test' WHERE id=77")
        before = snapshot()
        try:
            namespace["set_exclusive_expiry"](session, stale_user, 365)
            raise AssertionError("Stale supplied identity accepted")
        except MembershipReview:
            pass
        assert snapshot() == before
    execute("UPDATE users SET email='fixture@example.test' WHERE id=77")
    print(
        "all eight original/candidate userDal native differentials, source expiry vectors, stale ORM/snapshot and identity guards passed"
    )


try:
    {"stage": staged, "fence": fence, "writers": writers}[sys.argv[1]]()
finally:
    application_engine.dispose()
    engine.dispose()
