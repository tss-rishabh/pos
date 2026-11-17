"""SQLAlchemy durable commands. Migration is reviewed/applied separately on the API writer."""

import uuid
from sqlalchemy import BigInteger, Column, Integer, JSON, MetaData, String, Table, select, update
from contract import CONTRACT, SyncError, body_hash, valid_uuid, validate_proof

metadata = MetaData()
commands = Table("pos_ecommerce_full_sync_commands", metadata,
    Column("id", String(36), primary_key=True), Column("body_hash", String(64), nullable=False),
    Column("store_id", String(20), nullable=False), Column("actor_id", String(20), nullable=False),
    Column("request_id", String(128)), Column("state", String(16), nullable=False),
    Column("proof", JSON), Column("error_code", String(64)), Column("worker_id", String(36)),
    Column("lease_until", BigInteger), Column("created_ms", BigInteger, nullable=False),
    Column("updated_ms", BigInteger, nullable=False), Column("attempt", Integer, nullable=False))
registry = Table("pos_ecommerce_full_sync_registry", metadata,
    Column("id", String(32), primary_key=True), Column("active_id", String(36)))
reconciliations = Table("pos_ecommerce_full_sync_reconciliations", metadata,
    Column("id", String(36), primary_key=True), Column("operation_id", String(36), nullable=False),
    Column("worker_id", String(36)), Column("evidence_sha256", String(64), nullable=False),
    Column("created_ms", BigInteger, nullable=False))


class CommandStore:
    def __init__(self, engine, clock):
        self.engine, self.clock = engine, clock

    def now(self):
        return int(self.clock() * 1000)

    def _lock(self, conn):
        # An empty global slot is seeded by the reviewed migration, never at startup.
        row = conn.execute(select(registry).where(registry.c.id == "catalog").with_for_update()).mappings().first()
        if row is None:
            raise SyncError("ECOMMERCE_FULL_SYNC_SCHEMA_UNAVAILABLE")
        return row

    def view(self, row):
        state, error = row["state"], row["error_code"]
        if state == "running" and row["lease_until"] <= self.now():
            state, error = "uncertain", "ECOMMERCE_FULL_SYNC_WORKER_INTERRUPTED"
        return {"contract": CONTRACT, "operationId": row["id"], "requestHash": row["body_hash"],
                "status": state, "proof": row["proof"] if state == "succeeded" else None, "errorCode": error}

    def accept(self, body):
        digest, now = body_hash(body), self.now()
        with self.engine.begin() as conn:
            self._lock(conn)
            row = conn.execute(select(commands).where(commands.c.id == body["operationId"])).mappings().first()
            if row:
                if row["body_hash"] != digest:
                    raise SyncError("ECOMMERCE_FULL_SYNC_OPERATION_REUSED", 409)
                return self.view(row)
            conn.execute(commands.insert().values(id=body["operationId"], body_hash=digest,
                store_id=body["storeId"], actor_id=body["actorId"], request_id=body["requestId"],
                state="queued", created_ms=now, updated_ms=now, attempt=0))
            row = conn.execute(select(commands).where(commands.c.id == body["operationId"])).mappings().one()
            return self.view(row)

    def read(self, operation_id):
        if not valid_uuid(operation_id):
            raise SyncError("ECOMMERCE_FULL_SYNC_REQUEST_INVALID", 400)
        with self.engine.connect() as conn:
            row = conn.execute(select(commands).where(commands.c.id == operation_id)).mappings().first()
            return self.view(row) if row else None

    def trace(self, operation_id):
        with self.engine.connect() as conn:
            row = conn.execute(select(commands.c.actor_id, commands.c.request_id).where(commands.c.id == operation_id)).mappings().first()
            return {"requestId": row["request_id"], "userId": row["actor_id"]} if row else {"requestId": None, "userId": None}

    def claim(self, worker_id, lease_seconds=15):
        if not valid_uuid(worker_id) or not 5 <= lease_seconds <= 60:
            raise SyncError("ECOMMERCE_FULL_SYNC_WORKER_INVALID")
        with self.engine.begin() as conn:
            slot = self._lock(conn)
            # No automatic lease takeover: a stale source process can still write
            # Mongo/Redis after a DB lease expires. Explicit stopped-worker review is required.
            if slot["active_id"] is not None:
                return None
            row = conn.execute(select(commands).where(commands.c.state == "queued")
                .order_by(commands.c.created_ms, commands.c.id).limit(1).with_for_update()).mappings().first()
            if row is None:
                return None
            now = self.now()
            conn.execute(update(registry).where(registry.c.id == "catalog").values(active_id=row["id"]))
            conn.execute(update(commands).where(commands.c.id == row["id"]).values(state="running", worker_id=worker_id,
                lease_until=now + lease_seconds * 1000, updated_ms=now, attempt=row["attempt"] + 1, error_code=None))
            return {"operationId": row["id"], "workerId": worker_id, "actorId": row["actor_id"], "requestId": row["request_id"]}

    def heartbeat(self, command, lease_seconds=15):
        with self.engine.begin() as conn:
            self._lock(conn)
            changed = conn.execute(update(commands).where(commands.c.id == command["operationId"],
                commands.c.worker_id == command["workerId"], commands.c.state == "running").values(
                lease_until=self.now() + lease_seconds * 1000, updated_ms=self.now()))
            return changed.rowcount == 1

    def finish(self, command, proof=None, code=None):
        if proof is not None:
            validate_proof(proof)
        with self.engine.begin() as conn:
            slot = self._lock(conn)
            row = conn.execute(select(commands).where(commands.c.id == command["operationId"]).with_for_update()).mappings().one()
            if slot["active_id"] != row["id"] or row["worker_id"] != command["workerId"] or row["state"] != "running":
                raise SyncError("ECOMMERCE_FULL_SYNC_WORKER_FENCED")
            conn.execute(update(commands).where(commands.c.id == row["id"]).values(
                state="succeeded" if proof else "uncertain", proof=proof,
                error_code=None if proof else (code or "ECOMMERCE_FULL_SYNC_IO_UNCERTAIN"), updated_ms=self.now()))
            if proof:
                conn.execute(update(registry).where(registry.c.id == "catalog").values(active_id=None))

    def reconcile_stopped(self, operation_id, stopped_worker_id, evidence_sha256):
        import re
        if not valid_uuid(operation_id) or not valid_uuid(stopped_worker_id) or not re.fullmatch(r"[a-f0-9]{64}", evidence_sha256):
            raise SyncError("ECOMMERCE_FULL_SYNC_RECONCILIATION_INVALID", 400)
        with self.engine.begin() as conn:
            slot = self._lock(conn)
            row = conn.execute(select(commands).where(commands.c.id == operation_id).with_for_update()).mappings().first()
            if (not row or slot["active_id"] != operation_id or row["worker_id"] != stopped_worker_id
                    or row["state"] not in {"running", "uncertain"} or row["lease_until"] > self.now()):
                raise SyncError("ECOMMERCE_FULL_SYNC_RECONCILIATION_REQUIRED", 409)
            conn.execute(reconciliations.insert().values(id=str(uuid.uuid4()), operation_id=operation_id,
                worker_id=stopped_worker_id, evidence_sha256=evidence_sha256, created_ms=self.now()))
            conn.execute(update(commands).where(commands.c.id == operation_id).values(state="queued", worker_id=None,
                lease_until=None, error_code=None, updated_ms=self.now()))
            conn.execute(update(registry).where(registry.c.id == "catalog").values(active_id=None))
