"""Synthetic component checks; physical MySQL/concurrency evidence is a separate native oracle."""

import copy
import io
import json
import sys
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import create_engine, event, func, insert, select, update
from sqlalchemy.orm import sessionmaker

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import SourceAdapters, source_customer_token
from app import create_app
from codec import EffectCodec
from contract import CONTRACT, PATH, ContactError, acknowledgement, payload_hash
from models import (
    jobs,
    metadata,
    node_challenges,
    node_deliveries,
    node_mutations,
    receipts,
    users,
)
from runtime import verify_private_worker
from service import ContactEffects

KEY = "synthetic-contact-effects-service-key-" * 2
STORAGE = "synthetic-contact-effects-storage-key-" * 2


def request():
    payload = dict(
        contract=CONTRACT,
        operationId=str(uuid.uuid4()),
        challengeId=str(uuid.uuid4()),
        operatorId="1",
        customerId="7",
        storeId="1",
        checkoutId=str(uuid.uuid4()),
        kind="email",
        oldEmail="9876543210@temp.id",
        oldTelephone="9876543210",
        newValue="verified.fixture@example.test",
        refundRemails=[],
        requestId=str(uuid.uuid4()),
    )
    return dict(
        deliveryId=str(uuid.uuid4()),
        bodyHash=payload_hash(KEY, payload),
        payload=payload,
    )


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", echo=False, hide_parameters=True)
        metadata.create_all(self.engine)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)
        self.time = 1000000
        self.service = ContactEffects(
            self.sessions, KEY, STORAGE, clock=lambda: self.time
        )
        self.body = request()
        p = self.body["payload"]
        with self.sessions() as session, session.begin():
            session.execute(
                insert(users).values(
                    id=7,
                    email=p["newValue"],
                    telephone=p["oldTelephone"],
                    status=1,
                    is_block=0,
                    is_disabled=0,
                    is_two_fa=0,
                )
            )
            session.execute(
                insert(node_challenges).values(
                    id=p["challengeId"],
                    operator_id="1",
                    customer_id="7",
                    store_id="1",
                    checkout_id=p["checkoutId"],
                    kind="email",
                    status="COMMITTING",
                )
            )
            session.execute(
                insert(node_deliveries).values(
                    id=self.body["deliveryId"],
                    challenge_id=p["challengeId"],
                    operator_id="1",
                    customer_id="7",
                    kind="source-effects",
                    status="SENDING",
                )
            )
            session.execute(
                insert(node_mutations).values(
                    id=p["operationId"],
                    challenge_id=p["challengeId"],
                    operator_id="1",
                    checkout_id=p["checkoutId"],
                    action="commit",
                    result={"status": "success"},
                )
            )

    def tearDown(self):
        self.engine.dispose()

    def count(self, table):
        with self.sessions() as session:
            return session.execute(select(func.count()).select_from(table)).scalar_one()

    def test_exact_replays_return_same_ack_without_overwriting_sealed_input(self):
        ack = self.service.accept(self.body)
        with self.sessions() as session:
            sealed = session.execute(select(receipts.c.sealed_payload)).scalar_one()
        for _index in range(20):
            self.assertEqual(self.service.accept(self.body), ack)
        self.assertEqual(self.count(receipts), 1)
        self.assertEqual(self.count(jobs), 5)
        with self.sessions() as session:
            self.assertEqual(
                session.execute(select(receipts.c.sealed_payload)).scalar_one(), sealed
            )
        self.assertNotIn(self.body["payload"]["newValue"], sealed)

    def test_mismatched_idempotency_body_is_rejected_before_any_new_effect(self):
        self.service.accept(self.body)
        changed = copy.deepcopy(self.body)
        changed["payload"]["oldEmail"] = "different.fixture@example.test"
        changed["bodyHash"] = payload_hash(KEY, changed["payload"])
        with self.assertRaisesRegex(
            ContactError, "CONTACT_EFFECTS_IDEMPOTENCY_CONFLICT"
        ):
            self.service.accept(changed)
        self.assertEqual(self.count(jobs), 5)

    def test_current_node_scope_and_committed_mutation_are_required(self):
        with self.sessions() as session, session.begin():
            session.execute(update(node_mutations).values(action="verify"))
        with self.assertRaisesRegex(ContactError, "CONTACT_EFFECTS_NODE_PROOF_INVALID"):
            self.service.accept(self.body)
        self.assertEqual(self.count(receipts), 0)
        self.assertEqual(self.count(jobs), 0)

    def test_current_contact_must_match_the_committed_new_value(self):
        with self.sessions() as session, session.begin():
            session.execute(update(users).values(email="changed.fixture@example.test"))
        with self.assertRaisesRegex(ContactError, "CONTACT_EFFECTS_CONTACT_CHANGED"):
            self.service.accept(self.body)
        self.assertEqual(self.count(receipts), 0)

    def test_partial_job_insert_rolls_back_receipt_and_all_obligations(self):
        def fail(_connection, _cursor, statement, _parameters, _context, _many):
            if statement.startswith(
                "INSERT INTO pos_rewrite_customer_contact_effect_jobs"
            ):
                raise RuntimeError("Synthetic insert failure")

        event.listen(self.engine, "before_cursor_execute", fail)
        try:
            with self.assertRaises(RuntimeError):
                self.service.accept(self.body)
        finally:
            event.remove(self.engine, "before_cursor_execute", fail)
        self.assertEqual(self.count(receipts), 0)
        self.assertEqual(self.count(jobs), 0)

    def test_unknown_task_publication_is_not_automatically_repeated_and_cache_is_a_prerequisite(
        self,
    ):
        self.service.accept(self.body)
        calls = []

        def adapter(kind, _id, _payload, _detail):
            calls.append(kind)
            return "uncertain" if kind == "payment-customer" else "accepted"

        for _index in range(20):
            self.service.drain_one(adapter)
        self.assertEqual(calls[0], "auth-cache")
        self.assertEqual(calls.count("payment-customer"), 1)
        self.assertEqual(len(calls), 5)
        with self.sessions() as session:
            self.assertEqual(
                session.execute(
                    select(jobs.c.status).where(jobs.c.kind == "payment-customer")
                ).scalar_one(),
                "UNCERTAIN",
            )

    def test_expired_sending_cache_lease_is_uncertain_and_cannot_release_other_tasks(
        self,
    ):
        self.service.accept(self.body)
        with self.sessions() as session, session.begin():
            session.execute(
                update(jobs)
                .where(jobs.c.kind == "auth-cache")
                .values(
                    status="SENDING",
                    lease_token=str(uuid.uuid4()),
                    lease_expires_at_ms=self.time - 1,
                )
            )
        calls = []
        self.assertIsNone(self.service.drain_one(lambda *args: calls.append(args)))
        self.assertEqual(calls, [])
        with self.sessions() as session:
            self.assertEqual(
                session.execute(
                    select(jobs.c.status).where(jobs.c.kind == "auth-cache")
                ).scalar_one(),
                "UNCERTAIN",
            )

    def test_storage_authenticates_owner_key_and_ciphertext(self):
        codec = EffectCodec(STORAGE)
        owner = str(uuid.uuid4())
        sealed = codec.seal(owner, {"value": "synthetic-private"})
        self.assertEqual(codec.open(owner, sealed), {"value": "synthetic-private"})
        with self.assertRaises(ContactError):
            codec.open(str(uuid.uuid4()), sealed)
        with self.assertRaises(ContactError):
            EffectCodec(STORAGE + "changed").open(owner, sealed)

    def test_private_http_rejects_queries_duplicate_keys_and_bad_keys_without_private_logs(
        self,
    ):
        logs = []
        app = create_app(self.service, KEY, emit=logs.append)

        def call(body, **overrides):
            raw = body.encode()
            environment = {
                "PATH_INFO": PATH,
                "REQUEST_METHOD": "POST",
                "QUERY_STRING": "",
                "HTTP_X_CUSTOMER_CONTACT_KEY": KEY,
                "HTTP_X_CUSTOMER_CONTACT_CONTRACT": CONTRACT,
                "HTTP_X_REQUEST_ID": "9876543210",
                "HTTP_COOKIE": "synthetic-private-cookie",
                "CONTENT_TYPE": "application/json",
                "CONTENT_LENGTH": str(len(raw)),
                "wsgi.input": io.BytesIO(raw),
                **overrides,
            }
            statuses = []
            result = b"".join(
                app(environment, lambda status, _headers: statuses.append(status))
            )
            return statuses[0], result

        self.assertTrue(
            call(json.dumps(self.body), HTTP_X_CUSTOMER_CONTACT_KEY="bad")[
                0
            ].startswith("403")
        )
        self.assertTrue(
            call(
                json.dumps(self.body), QUERY_STRING="email=private.fixture@example.test"
            )[0].startswith("404")
        )
        self.assertTrue(
            call('{"payload":"private.fixture@example.test","payload":1}')[
                0
            ].startswith("400")
        )
        status, body = call(json.dumps(self.body))
        self.assertTrue(status.startswith("200"))
        self.assertEqual(json.loads(body), acknowledgement(self.body))
        encoded = json.dumps(logs)
        for private in [
            "9876543210",
            "private.fixture@example.test",
            self.body["payload"]["newValue"],
            KEY,
            "synthetic-private-cookie",
        ]:
            self.assertNotIn(private, encoded)
        self.assertTrue(
            all(
                "eventId" in item and "requestId" in item and "userId" in item
                for item in logs
            )
        )

    def test_source_task_contract_uses_bound_ids_explicit_queues_and_no_publish_retry(
        self,
    ):
        calls = []

        class FakeCelery:
            def send_task(self, task, **kwargs):
                calls.append((task, kwargs))
                return SimpleNamespace(id=kwargs["task_id"])

        adapter = SourceAdapters(
            self.sessions,
            SimpleNamespace(delete=lambda _key: 0),
            FakeCelery(),
            {"hs256": "a" * 64, "hs512": "b" * 64},
            payment_url="https://payment.fixture.test/customers/update",
            refund_url="https://mail.fixture.test/refund",
            default_queue="celery",
            support_queue="customer-support",
        )
        for kind in ["clevertap", "moengage", "support"]:
            self.assertEqual(
                adapter(kind, str(uuid.uuid4()), self.body["payload"], {}), "accepted"
            )
        self.assertEqual(calls[0][0], "pos.customer_contacts.clevertap_v1")
        self.assertEqual(calls[0][1]["args"], [[7], 7])
        self.assertEqual(calls[1][1]["args"], [7])
        self.assertEqual(calls[2][1]["queue"], "customer-support")
        self.assertTrue(
            all(
                item[1]["retry"] is False and item[1]["ignore_result"] is True
                for item in calls
            )
        )
        self.assertNotIn("@", json.dumps(calls))

    def test_source_worker_readiness_requires_exact_artifacts_private_names_and_isolated_queues(
        self,
    ):
        candidate = {"newFileSha256": "a" * 64, "afterSha256": "b" * 64}
        worker = "pos-contact-fixture@worker"
        queues = ["pos-contact-crm-v1", "pos-contact-support-v1"]
        from adapters import TASKS

        good = {
            "contract": "pos-customer-contact-tasks-v1",
            "helperSha256": candidate["newFileSha256"],
            "tasksSha256": candidate["afterSha256"],
            "tasks": sorted(TASKS.values()),
        }
        calls = []

        class Control:
            proof = good
            active = queues

            def broadcast(self, name, **kwargs):
                calls.append((name, kwargs))
                return [{worker: self.proof}]

            def inspect(self, **_kwargs):
                return SimpleNamespace(
                    active_queues=lambda: {
                        worker: [{"name": name} for name in self.active]
                    }
                )

        control = Control()
        client = SimpleNamespace(control=control)
        verify_private_worker(client, worker, candidate, queues)
        self.assertEqual(calls[0][0], "pos_contact_task_privacy")
        self.assertEqual(calls[0][1]["timeout"], 5)
        for changed in [
            {**good, "helperSha256": "c" * 64},
            {**good, "tasksSha256": "c" * 64},
            {**good, "tasks": ["tasks.update_user_profile"]},
            None,
        ]:
            control.proof = changed
            with self.assertRaisesRegex(
                ContactError, "CONTACT_EFFECTS_PRIVATE_WORKER_UNVERIFIED"
            ):
                verify_private_worker(client, worker, candidate, queues)
        control.proof = good
        control.active = [queues[0]]
        with self.assertRaises(ContactError):
            verify_private_worker(client, worker, candidate, queues)
        with self.assertRaises(ContactError):
            verify_private_worker(
                client, worker, candidate, ["celery", "customer-support"]
            )

    def test_fresh_short_lived_payment_token_has_the_source_two_factor_prefix_and_no_private_claims(
        self,
    ):
        token = source_customer_token(
            {"id": 7, "status": 1, "is_block": 0, "is_disabled": 0, "is_two_fa": 1},
            {"hs256": "a" * 64, "hs512": "b" * 64},
            now=1000000,
        )
        self.assertTrue(token.startswith("2f."))
        self.assertNotIn("@", token)
        import base64

        raw = token[3:].split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(raw + "=" * ((-len(raw)) % 4)))
        self.assertEqual(payload, {"sub": "7", "iat": 1000000, "exp": 1000600})


if __name__ == "__main__":
    unittest.main()
