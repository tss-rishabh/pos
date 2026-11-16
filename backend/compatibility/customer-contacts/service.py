"""Atomic durable acceptance; external publication is a separate supervised obligation."""

import time
import uuid

from sqlalchemy import and_, exists, insert, select, tuple_, update
from sqlalchemy.dialects.mysql import insert as mysql_insert

from codec import EffectCodec
from contract import ContactError, acknowledgement, validate_request
from models import (
    alternatives,
    jobs,
    node_challenges,
    node_deliveries,
    node_mutations,
    orders,
    receipts,
    refunds,
    users,
)


def source_jobs(payload):
    result = [
        ("auth-cache", {}),
        ("payment-customer", {}),
        ("clevertap", {}),
        ("moengage", {}),
        ("support", {}),
    ]
    result.extend(("refund-notice", item) for item in payload["refundRemails"])
    return result


class ContactEffects:
    def __init__(
        self,
        session_factory,
        transport_key,
        storage_key,
        *,
        clock=lambda: int(time.time() * 1000),
    ):
        self.sessions, self.transport_key = session_factory, transport_key
        self.codec, self.clock = EffectCodec(storage_key), clock

    def _node_proof(self, session, body):
        payload = body["payload"]
        challenge = (
            session.execute(
                select(node_challenges).where(
                    node_challenges.c.id == payload["challengeId"]
                )
            )
            .mappings()
            .first()
        )
        delivery = (
            session.execute(
                select(node_deliveries).where(
                    node_deliveries.c.id == body["deliveryId"]
                )
            )
            .mappings()
            .first()
        )
        mutation = (
            session.execute(
                select(node_mutations).where(
                    node_mutations.c.id == payload["operationId"]
                )
            )
            .mappings()
            .first()
        )
        if (
            not challenge
            or not delivery
            or not mutation
            or challenge["operator_id"] != payload["operatorId"]
            or challenge["store_id"] != payload["storeId"]
            or challenge["checkout_id"] != payload["checkoutId"]
            or challenge["customer_id"] != payload["customerId"]
            or challenge["kind"] != payload["kind"]
            or challenge["status"] not in ["COMMITTING", "UNCERTAIN", "COMMITTED"]
            or delivery["challenge_id"] != challenge["id"]
            or delivery["operator_id"] != payload["operatorId"]
            or delivery["customer_id"] != payload["customerId"]
            or delivery["kind"] != "source-effects"
            or delivery["status"] not in ["PENDING", "SENDING", "UNCERTAIN"]
            or mutation["challenge_id"] != challenge["id"]
            or mutation["operator_id"] != payload["operatorId"]
            or mutation["checkout_id"] != payload["checkoutId"]
            or mutation["action"] != "commit"
            or not isinstance(mutation["result"], dict)
            or mutation["result"].get("status") != "success"
        ):
            raise ContactError("CONTACT_EFFECTS_NODE_PROOF_INVALID", 409)
        customer = (
            session.execute(
                select(users).where(users.c.id == int(payload["customerId"]))
            )
            .mappings()
            .first()
        )
        if (
            not customer
            or customer["email" if payload["kind"] == "email" else "telephone"]
            != payload["newValue"]
        ):
            raise ContactError("CONTACT_EFFECTS_CONTACT_CHANGED", 409)
        if payload["refundRemails"]:
            pairs = {
                (int(item["orderId"]), int(item["refundRequestId"]))
                for item in payload["refundRemails"]
            }
            eligible = session.execute(
                select(alternatives.c.order_id, alternatives.c.refund_request_id)
                .join(orders, orders.c.id == alternatives.c.order_id)
                .join(refunds, refunds.c.id == alternatives.c.refund_request_id)
                .where(
                    and_(
                        orders.c.user_id == int(payload["customerId"]),
                        tuple_(
                            alternatives.c.order_id, alternatives.c.refund_request_id
                        ).in_(pairs),
                        alternatives.c.status == "PENDING",
                        refunds.c.is_completed == "FAILED",
                    )
                )
                .limit(1001)
            ).all()
            if {(row.order_id, row.refund_request_id) for row in eligible} != pairs:
                raise ContactError("CONTACT_EFFECTS_REFUND_PROOF_INVALID", 409)

    def accept(self, raw):
        body = validate_request(raw, self.transport_key)
        payload, delivery_id, now = body["payload"], body["deliveryId"], self.clock()
        with self.sessions() as session, session.begin():
            # Upsert locks an immutable receipt key before reading it. A mismatched
            # body can neither create a second job set nor overwrite private data.
            values = dict(
                id=delivery_id,
                body_hash=body["bodyHash"],
                operation_id=payload["operationId"],
                challenge_id=payload["challengeId"],
                operator_id=payload["operatorId"],
                customer_id=payload["customerId"],
                request_id=payload["requestId"],
                status="PENDING",
                sealed_payload=self.codec.seal(delivery_id, payload),
                created_at_ms=now,
            )
            if session.bind.dialect.name == "mysql":
                statement = (
                    mysql_insert(receipts)
                    .values(values)
                    .on_duplicate_key_update(id=receipts.c.id)
                )
            else:
                statement = insert(receipts).values(values).prefix_with("OR IGNORE")
            session.execute(statement)
            row = (
                session.execute(
                    select(receipts)
                    .where(receipts.c.id == delivery_id)
                    .with_for_update()
                )
                .mappings()
                .one()
            )
            if (
                row["body_hash"] != body["bodyHash"]
                or row["operation_id"] != payload["operationId"]
            ):
                raise ContactError("CONTACT_EFFECTS_IDEMPOTENCY_CONFLICT", 409)
            if row["status"] == "ACCEPTED":
                return acknowledgement(body)
            if (
                row["status"] != "PENDING"
                or session.execute(
                    select(jobs.c.id).where(jobs.c.receipt_id == delivery_id).limit(1)
                ).first()
            ):
                raise ContactError("CONTACT_EFFECTS_RECEIPT_INVALID", 409)
            self._node_proof(session, body)
            pending = []
            for position, (kind, detail) in enumerate(source_jobs(payload)):
                job_id = str(
                    uuid.uuid5(uuid.UUID(delivery_id), str(position) + ":" + kind)
                )
                pending.append(
                    dict(
                        id=job_id,
                        receipt_id=delivery_id,
                        kind=kind,
                        position=position,
                        status="PENDING",
                        sealed_payload=self.codec.seal(job_id, detail),
                        attempts=0,
                        created_at_ms=now,
                        updated_at_ms=now,
                    )
                )
            session.execute(insert(jobs), pending)
            session.execute(
                update(receipts)
                .where(receipts.c.id == delivery_id)
                .values(status="ACCEPTED")
            )

        return acknowledgement(body)

    def drain_one(self, adapter):
        now, token = self.clock(), str(uuid.uuid4())
        with self.sessions() as session, session.begin():
            # Unknown outcomes never auto-publish a CRM task/mail a second time.
            expired = session.execute(
                select(jobs.c.id)
                .where(
                    and_(jobs.c.status == "SENDING", jobs.c.lease_expires_at_ms <= now)
                )
                .order_by(jobs.c.created_at_ms)
                .limit(1)
                .with_for_update(skip_locked=True)
            ).first()
            if expired:
                session.execute(
                    update(jobs)
                    .where(jobs.c.id == expired.id)
                    .values(
                        status="UNCERTAIN",
                        lease_token=None,
                        lease_expires_at_ms=None,
                        updated_at_ms=now,
                    )
                )
            cache = jobs.alias("completed_auth_cache")
            eligible = and_(
                jobs.c.status == "PENDING",
                (jobs.c.kind == "auth-cache")
                | exists(
                    select(cache.c.id).where(
                        and_(
                            cache.c.receipt_id == jobs.c.receipt_id,
                            cache.c.kind == "auth-cache",
                            cache.c.status == "SUCCEEDED",
                        )
                    )
                ),
            )
            row = (
                session.execute(
                    select(jobs)
                    .where(eligible)
                    .order_by(jobs.c.created_at_ms, jobs.c.position, jobs.c.id)
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            receipt = (
                session.execute(
                    select(receipts).where(receipts.c.id == row["receipt_id"])
                )
                .mappings()
                .one()
            )
            session.execute(
                update(jobs)
                .where(jobs.c.id == row["id"])
                .values(
                    status="SENDING",
                    attempts=row["attempts"] + 1,
                    lease_token=token,
                    lease_expires_at_ms=now + 60000,
                    updated_at_ms=now,
                )
            )
        outcome = "uncertain"
        try:
            payload, detail = (
                self.codec.open(receipt["id"], receipt["sealed_payload"]),
                self.codec.open(row["id"], row["sealed_payload"]),
            )
            outcome = adapter(row["kind"], row["id"], payload, detail)
        except Exception:
            pass  # Never serialize source, broker, HTTP or private-payload exceptions.
        status = (
            "SUCCEEDED"
            if outcome == "accepted"
            else "FAILED"
            if outcome == "rejected"
            else "UNCERTAIN"
        )
        with self.sessions() as session, session.begin():
            current = session.execute(
                select(jobs.c.lease_token, jobs.c.status)
                .where(jobs.c.id == row["id"])
                .with_for_update()
            ).one()
            if current.lease_token != token or current.status != "SENDING":
                return "uncertain"
            session.execute(
                update(jobs)
                .where(jobs.c.id == row["id"])
                .values(
                    status=status,
                    lease_token=None,
                    lease_expires_at_ms=None,
                    updated_at_ms=self.clock(),
                )
            )
        return {
            "jobId": row["id"],
            "receiptId": receipt["id"],
            "operatorId": receipt["operator_id"],
            "requestId": receipt["request_id"],
            "kind": row["kind"],
            "status": status,
        }
