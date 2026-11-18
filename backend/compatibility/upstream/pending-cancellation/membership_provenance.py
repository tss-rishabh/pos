"""Transactional producer for real API-v2 membership mutations; no service startup.

The companion source patch surrounds the actual PosOrder block and decorates
its original userDal writers. Nested source commits and invalidations are held
until the membership state, native revision and signed provenance commit.
"""

from contextlib import contextmanager
from datetime import datetime
from functools import wraps
import hashlib
import hmac
import json
import os
import re
import uuid

from sqlalchemy import text
from membership_fence_contract import DEFINITIONS, FENCE_CONTRACT

STAGED_CONTRACT = "pos-cancellation-membership-staged-v2"
ACTIVATED_CONTRACT = "pos-cancellation-membership-provenance-v2"
HASH_KIND = "pending-cancellation.membership-provenance.v2"
HEADER_SQL = "LOWER(SHA2(CAST(JSON_OBJECT('order_id',orders.id,'user_id',orders.user_id,'payment_method',orders.payment_method,'pay_amt',orders.pay_amt,'cashback_used',orders.cashback_used,'tss_money_used',orders.tss_money_used,'tss_points_used',orders.tss_points_used,'voucher_used',orders.voucher_used,'voucher_amt_used',orders.voucher_amt_used,'coupon_used',orders.coupon_used,'coupon_amt_used',orders.coupon_amt_used) AS CHAR CHARACTER SET utf8mb4),256))"
STATE_HASH_SQL = "LOWER(SHA2(CAST(JSON_OBJECT('attribute',user_eav.attribute,'value',user_eav.value,'active',user_eav.is_active,'created_at',UNIX_TIMESTAMP(user_eav.created_at),'updated_at',UNIX_TIMESTAMP(user_eav.updated_at)) AS CHAR CHARACTER SET utf8mb4),256))"
STATE_SQL = (
    """SELECT attribute,value,is_active AS active,
 DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(created_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS createdAt,
 DATE_FORMAT(TIMESTAMPADD(SECOND,UNIX_TIMESTAMP(updated_at),'1970-01-01 00:00:00'),'%Y-%m-%d %H:%i:%s') AS updatedAt,
 """
    + STATE_HASH_SQL
    + """ AS hash FROM user_eav
 WHERE entity=:entity AND attribute IN ('EXCLUSIVE_MEMBER','EXCLUSIVE_EXPIRY')
 ORDER BY attribute LIMIT 3 FOR UPDATE"""
)


class MembershipReview(RuntimeError):
    def __init__(self):
        super().__init__("Membership state requires reconciliation.")


def _fail():
    raise MembershipReview() from None


def _identifier(value):
    if (
        type(value) not in (str, int)
        or re.fullmatch(r"[1-9][0-9]{0,18}", str(value)) is None
        or int(value) > 9223372036854775807
    ):
        _fail()
    return int(value)


def _rows(session, statement, parameters=None):
    result = session.execute(text(statement), parameters or {})
    if hasattr(result, "mappings"):
        return [dict(row) for row in result.mappings().all()]
    return [dict(row) for row in result.fetchall()]


def _one(session, statement, parameters=None):
    rows = _rows(session, statement, parameters)
    if len(rows) != 1:
        _fail()
    return rows[0]


def config(settings=None):
    if os.environ.get("POS_MEMBERSHIP_NATIVE_REVISION_CONTRACT") != FENCE_CONTRACT:
        _fail()
    key = os.environ.get("POS_MEMBERSHIP_PROOF_KEY", "")
    if not 32 <= len(key.encode()) <= 4096:
        _fail()
    try:
        ids = json.loads(os.environ["POS_MEMBERSHIP_PRODUCT_IDS"])
    except (KeyError, ValueError, TypeError):
        _fail()
    if not isinstance(ids, list) or len(ids) > 1000 or any(type(value) is not str for value in ids):
        _fail()
    parsed = [_identifier(value) for value in ids]
    if len(set(parsed)) != len(parsed):
        _fail()
    if settings is not None:
        expected = {
            _identifier(value)
            for values in (settings.EXCLUSIVE_PRODUCT, settings.EXCLUSIVE_UPGRADE_PRODUCT)
            for value in values
        }
        if expected != set(parsed):
            _fail()
    return key, parsed


def assert_fence(session, entity):
    # These locking reads retain both tables' MDL, including against DROP TRIGGER.
    _rows(
        session,
        "SELECT entity FROM user_eav WHERE entity=:entity AND attribute='EXCLUSIVE_MEMBER' LIMIT 1 FOR SHARE",
        {"entity": entity},
    )
    columns = _rows(
        session,
        "SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,DATA_TYPE AS dataType,COLLATION_NAME AS collation FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND ((TABLE_NAME='users' AND COLUMN_NAME='email') OR (TABLE_NAME='user_eav' AND COLUMN_NAME IN ('created_at','updated_at')))",
    )
    if (
        len(columns) != 3
        or not any(
            row["tableName"] == "users" and row["collation"] == "utf8mb3_general_ci"
            for row in columns
        )
        or any(row["tableName"] == "user_eav" and row["dataType"] != "timestamp" for row in columns)
    ):
        _fail()
    indexes = _rows(
        session,
        "SELECT TABLE_NAME AS tableName,INDEX_NAME AS indexName,SEQ_IN_INDEX AS ordinal,COLUMN_NAME AS columnName,SUB_PART AS prefix FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('users','user_eav') AND IS_VISIBLE='YES' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX LIMIT 1001",
    )
    if len(indexes) > 1000:
        _fail()
    groups = {}
    for row in indexes:
        groups.setdefault((row["tableName"], row["indexName"]), []).append(row)

    def supports(table, names):
        return any(
            kind == table
            and [row["columnName"] for row in rows[: len(names)]] == names
            and all(row["prefix"] is None for row in rows[: len(names)])
            for (kind, _), rows in groups.items()
        )

    if not supports("users", ["email"]) or not supports("user_eav", ["entity", "attribute"]):
        _fail()
    # Exact readonly metadata runs in this native transaction and validates the
    # current isolated owner and all writer privileges before returning bodies.
    # No application TRIGGER grant or cross-request attestation is accepted.
    try:
        from origin_history_privileges import qualified_head_metadata
        triggers = qualified_head_metadata(session)['membershipRevisionTriggers']
    except Exception:
        _fail()
    if len(triggers) != len(DEFINITIONS):
        _fail()
    indexed = {row["name"]: row for row in triggers}
    for expected in DEFINITIONS:
        actual = indexed.get(expected["name"])
        if (
            not actual
            or any(
                actual[field] != expected[key]
                for field, key in [
                    ("event", "event"),
                    ("tableName", "table"),
                    ("timing", "timing"),
                    ("hash", "hash"),
                ]
            )
            or not {"STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"}.intersection(
                actual["sqlMode"].split(",")
            )
        ):
            _fail()


def lock_customer(session, customer_id):
    customer_id = _identifier(customer_id)
    row = _one(
        session,
        "SELECT id,email,status,is_block,is_disabled FROM users WHERE id=:id FOR UPDATE",
        {"id": customer_id},
    )
    if (
        not row["email"]
        or row["status"] != 1
        or row["is_block"] not in (None, 0)
        or row["is_disabled"] not in (None, 0)
    ):
        _fail()
    owners = _rows(
        session,
        "SELECT id FROM users WHERE email=:entity ORDER BY id LIMIT 2 FOR UPDATE",
        {"entity": row["email"]},
    )
    if len(owners) != 1 or owners[0]["id"] != customer_id:
        _fail()
    assert_fence(session, row["email"])
    session.execute(
        text(
            "INSERT INTO pos_rewrite_membership_versions(customer_id,revision) VALUES(:id,0) ON DUPLICATE KEY UPDATE customer_id=customer_id"
        ),
        {"id": customer_id},
    )
    revision = _one(
        session,
        "SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR UPDATE",
        {"id": customer_id},
    )["revision"]
    return row, int(revision)


def current(session, entity):
    rows = _rows(session, STATE_SQL, {"entity": entity})
    if len(rows) not in (0, 2) or (
        rows and {row["attribute"] for row in rows} != {"EXCLUSIVE_EXPIRY", "EXCLUSIVE_MEMBER"}
    ):
        _fail()
    for row in rows:
        if (
            row["active"] not in (0, 1)
            or not isinstance(row["createdAt"], str)
            or not isinstance(row["updatedAt"], str)
            or not re.fullmatch("[a-f0-9]{64}", row["hash"])
        ):
            _fail()
        if row["attribute"] == "EXCLUSIVE_MEMBER" and row["value"] not in (
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
        ):
            _fail()
        if row["attribute"] == "EXCLUSIVE_EXPIRY":
            try:
                datetime.fromisoformat(row["value"])
            except (ValueError, TypeError):
                _fail()
    return rows


def _hash(kind, value, key):
    # JS operationHash orders the outer object as kind,input; only input keys sort.
    encoded = (
        '{"kind":'
        + json.dumps(kind, ensure_ascii=False, separators=(",", ":"))
        + ',"input":'
        + json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "}"
    )
    return hmac.new(key.encode(), encoded.encode(), hashlib.sha256).hexdigest()


def proof_hash(record, key):
    return _hash(
        HASH_KIND,
        {
            "orderId": str(record["orderId"]),
            "customerId": str(record["customerId"]),
            "revision": str(record["revision"]),
            "headerHash": record["headerHash"],
            "before": record["before"],
            "confirmed": record["confirmed"],
            "contract": record["contract"],
            "operationId": record["operationId"],
            "createdAt": record["createdAt"],
            "entityDigest": record["entityDigest"],
        },
        key,
    )


def bump(session, customer_id):
    session.execute(
        text(
            "UPDATE pos_rewrite_membership_versions SET revision=revision+1 WHERE customer_id=:id"
        ),
        {"id": customer_id},
    )
    return int(
        _one(
            session,
            "SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR UPDATE",
            {"id": customer_id},
        )["revision"]
    )


class TransactionSession:
    def __init__(self, session, readonly=False):
        self.session, self.readonly, self.invalidations = session, readonly, []

    def __getattr__(self, name):
        return getattr(self.session, name)

    def commit(self):
        return None

    def query(self, *entities):
        # The source reuses SQLAlchemy objects, sometimes after an earlier
        # nonlocking read established an old RepeatableRead snapshot. Refresh
        # identities AND use a current locking read; either one alone is stale.
        self.session.flush()
        return self.session.query(*entities).populate_existing().with_for_update()

    def defer(self, callback, args, kwargs):
        self.invalidations.append((callback, args, kwargs))


def defer_membership_invalidation(session, callback, *args, **kwargs):
    if not isinstance(session, TransactionSession):
        _fail()
    # The original cache key receives the original session identity.
    session.defer(
        callback, tuple(session.session if value is session else value for value in args), kwargs
    )


def _publish(proxy):
    for callback, args, kwargs in proxy.invalidations:
        try:
            callback(*args, **kwargs)
        except Exception:
            pass  # Never claim cache coherence; private POS reads bypass it.


def membership_user_lock(function):
    @wraps(function)
    def guarded(session, user, *args, **kwargs):
        if isinstance(session, TransactionSession):
            if session.readonly:
                _fail()
            return function(session, user, *args, **kwargs)
        try:
            config()
            identity = user.get("user_id") if isinstance(user, dict) else getattr(user, "id", user)
            customer, _ = lock_customer(session, identity)
            supplied_email = (
                user.get("email") if isinstance(user, dict) else getattr(user, "email", None)
            )
            if supplied_email is not None and supplied_email != customer["email"]:
                _fail()
            current(session, customer["email"])
            proxy = TransactionSession(session)
            result = function(proxy, user, *args, **kwargs)
            session.flush()
            current(session, customer["email"])
            bump(session, customer["id"])
            session.commit()
        except Exception:
            session.rollback()
            _fail()
        _publish(proxy)
        return result

    return guarded


@contextmanager
def membership_order_stage(session, order_id, user, settings):
    try:
        key, ids = config(settings)
        order_id = _identifier(order_id)
        order = _one(
            session,
            "SELECT id,user_id,payment_method,payment_status,order_status,"
            + HEADER_SQL
            + " AS header FROM orders WHERE id=:id FOR UPDATE",
            {"id": order_id},
        )
        lines = _rows(
            session,
            "SELECT prod_id,qty FROM has_products WHERE order_id=:id ORDER BY id LIMIT 1001 FOR UPDATE",
            {"id": order_id},
        )
        if not lines or len(lines) > 1000:
            _fail()
        members = [row for row in lines if row["prod_id"] in ids]
        if not members:
            yield SimpleStage(True, TransactionSession(session, readonly=True))
            return
        if (
            any(row["qty"] < 1 or row["qty"] > 999 for row in members)
            or order["payment_method"] not in (3, 14)
            or order["payment_status"] != 0
            or order["order_status"] != 0
            or _identifier(user["user_id"]) != order["user_id"]
        ):
            _fail()
        customer, _ = lock_customer(session, order["user_id"])
        if user.get("email") != customer["email"]:
            _fail()
        before = current(session, customer["email"])
        existing = _rows(
            session,
            "SELECT * FROM pos_rewrite_cancellation_membership_provenance WHERE order_id=:id FOR UPDATE",
            {"id": order_id},
        )
        if existing:
            record = _decode(existing[0])
            actual_revision = _one(
                session,
                "SELECT revision FROM pos_rewrite_membership_versions WHERE customer_id=:id FOR UPDATE",
                {"id": customer["id"]},
            )["revision"]
            if (
                record["contract"] != STAGED_CONTRACT
                or record["headerHash"] != order["header"]
                or record["customerId"] != str(customer["id"])
                or record["revision"] != str(actual_revision)
                or record["confirmed"] != before
                or record["entityDigest"]
                != _hash("pending-cancellation.membership-entity.v1", customer["email"], key)
                or not hmac.compare_digest(record["proofHash"], proof_hash(record, key))
            ):
                _fail()
            yield SimpleStage(False, TransactionSession(session))
            session.commit()
            return
        if bool(user.get("is_exclusive")) != any(
            row["attribute"] == "EXCLUSIVE_MEMBER" and row["active"] == 1 for row in before
        ):
            _fail()
        proxy = TransactionSession(session)
        yield SimpleStage(True, proxy)
        session.flush()
        confirmed = current(session, customer["email"])
        if len(confirmed) != 2:
            _fail()
        revision = bump(session, customer["id"])
        created_at = _one(
            session, "SELECT DATE_FORMAT(UTC_TIMESTAMP(),'%Y-%m-%d %H:%i:%s') AS value"
        )["value"]
        record = {
            "orderId": str(order_id),
            "customerId": str(customer["id"]),
            "revision": str(revision),
            "headerHash": order["header"],
            "before": before,
            "confirmed": confirmed,
            "contract": STAGED_CONTRACT,
            "operationId": str(uuid.uuid4()),
            "createdAt": created_at,
            "entityDigest": _hash(
                "pending-cancellation.membership-entity.v1", customer["email"], key
            ),
        }
        values = {
            **record,
            "before": json.dumps(before, separators=(",", ":")),
            "confirmed": json.dumps(confirmed, separators=(",", ":")),
            "proofHash": proof_hash(record, key),
        }
        session.execute(
            text(
                "INSERT INTO pos_rewrite_cancellation_membership_provenance(order_id,customer_id,revision,header_hash,before_state,confirmed_state,proof_hash,contract_version,operation_id,created_at,entity_digest) VALUES(:orderId,:customerId,:revision,:headerHash,:before,:confirmed,:proofHash,:contract,:operationId,:createdAt,:entityDigest)"
            ),
            values,
        )
        session.commit()
    except Exception:
        session.rollback()
        _fail()
    else:
        _publish(proxy)


class SimpleStage:
    def __init__(self, apply, session):
        self.apply, self.session = apply, session


def _decode(row):
    return {
        "orderId": str(row["order_id"]),
        "customerId": str(row["customer_id"]),
        "revision": str(row["revision"]),
        "headerHash": row["header_hash"],
        "before": (
            json.loads(row["before_state"])
            if isinstance(row["before_state"], str)
            else row["before_state"]
        ),
        "confirmed": (
            json.loads(row["confirmed_state"])
            if isinstance(row["confirmed_state"], str)
            else row["confirmed_state"]
        ),
        "contract": row["contract_version"],
        "operationId": row["operation_id"],
        "createdAt": (
            row["created_at"].strftime("%Y-%m-%d %H:%M:%S")
            if isinstance(row["created_at"], datetime)
            else row["created_at"]
        ),
        "proofHash": row["proof_hash"],
        "entityDigest": row["entity_digest"],
    }
