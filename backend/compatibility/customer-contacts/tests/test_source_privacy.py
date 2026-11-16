"""Run pinned source consumer AST with synthetic provider/DB leaves; never import source startup."""

import ast
import contextlib
import hashlib
import io
import json
import logging
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

owned = Path(__file__).resolve().parents[1]
backend = owned.parents[1]
source = backend.parent.parent / "backend-tss-api_v2"
sys.path.insert(0, str(owned / "payload"))
import pos_contact_task_privacy as privacy  # noqa: E402 -- Add only the owned candidate payload directory before import.

manifest = json.loads((owned / "source-manifest.json").read_text())
PRIVATE_EMAIL = "private.synthetic@example.test"
PRIVATE_PHONE = "9876543210"
PRIVATE_SECRET = "synthetic-provider-credential-secret"


def pinned(path):
    value = subprocess.run(
        ["git", "show", manifest["sourceCommit"] + ":" + path],
        cwd=source,
        check=True,
        capture_output=True,
    ).stdout
    expected = next(
        item["sha256"] for item in manifest["files"] if item["path"] == path
    )
    if hashlib.sha256(value).hexdigest() != expected:
        raise ValueError("SOURCE_BASELINE_CHANGED")
    return value.decode()


def compile_function(path, name, namespace):
    tree = ast.parse(pinned(path))
    node = next(
        item
        for item in tree.body
        if isinstance(item, ast.FunctionDef) and item.name == name
    )
    node.decorator_list = []
    exec(
        compile(
            ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
            "<pinned-private-source>",
            "exec",
        ),
        namespace,
    )
    return namespace[name]


class FakeRequests:
    class exceptions:
        RequestException = RuntimeError

    def post(self, url, **_kwargs):
        if "netcore" in url:
            raise RuntimeError(
                PRIVATE_EMAIL + " " + PRIVATE_PHONE + " " + PRIVATE_SECRET
            )
        return SimpleNamespace(
            content=json.dumps(
                {
                    "status": "success",
                    "processed": 1,
                    "email": PRIVATE_EMAIL,
                    "phone": PRIVATE_PHONE,
                }
            ).encode()
        )

    def get(self, _url, **_kwargs):
        return SimpleNamespace(
            status_code=503,
            json=lambda: {
                "email": PRIVATE_EMAIL,
                "phone": PRIVATE_PHONE,
                "credential": PRIVATE_SECRET,
            },
        )


class SourcePrivacyTests(unittest.TestCase):
    def setUp(self):
        self.previous_factory = logging.getLogRecordFactory()
        self.stream = io.StringIO()
        self.events = io.StringIO()
        self.logger = logging.getLogger("pos.fixture.source-consumers")
        self.logger.handlers = []
        self.logger.propagate = False
        self.logger.setLevel(logging.DEBUG)
        handler = logging.StreamHandler(self.stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        self.logger.addHandler(handler)
        self.request = SimpleNamespace(
            id=str(uuid.uuid4()),
            headers={
                "pos-contact-purpose": privacy.PURPOSE,
                "pos-contact-operator-id": "1",
                "pos-contact-customer-id": "7",
                "pos-contact-request-id": str(uuid.uuid4()),
                "pos-contact-operation-id": str(uuid.uuid4()),
            },
        )

    def tearDown(self):
        logging.setLogRecordFactory(self.previous_factory)
        self.logger.handlers = []

    def invoke(self, function, resource, args):
        with (
            patch.object(
                privacy, "current_task", SimpleNamespace(request=self.request)
            ),
            contextlib.redirect_stdout(self.events),
        ):
            return privacy.private_contact_task(resource)(function)(*args)

    def assert_private(self, resource):
        output = self.stream.getvalue() + self.events.getvalue()
        for private in [PRIVATE_EMAIL, PRIVATE_PHONE, PRIVATE_SECRET]:
            self.assertNotIn(private, output)
        events = [json.loads(line) for line in self.events.getvalue().splitlines()]
        self.assertEqual(
            [item["eventId"] for item in events],
            [
                "customer-contacts." + resource + ".started",
                "customer-contacts." + resource + ".returned",
            ],
        )
        for item in events:
            self.assertEqual(item["userId"], "1")
            self.assertEqual(
                item["requestId"], self.request.headers["pos-contact-request-id"]
            )
            self.assertEqual(item["taskId"], self.request.id)
        self.assertEqual(self.stream.getvalue(), "")
        self.assertIn("sourceErrorCount", events[-1])
        self.assertIn("sourceWarningCount", events[-1])
        self.assertGreater(
            events[-1]["sourceWarningCount"]
            if resource == "moengage-attributes"
            else events[-1]["sourceErrorCount"],
            0,
        )

    def test_actual_clevertap_consumer_and_netcore_helper_have_no_response_or_raw_exception_logs(
        self,
    ):
        http = FakeRequests()
        common = {"logger": self.logger, "requests": http, "json": json}
        row = dict(
            user_id=7,
            created_at=1,
            email=PRIVATE_EMAIL,
            firstname="Synthetic Private",
            lastname="Customer",
            phone=PRIVATE_PHONE,
            gender="O",
            dob="",
            exclusive_status="Non Exclusive",
            exclusive_expiry="",
            tss_money=0,
            min_expiry_tss_money=None,
            tss_points=0,
            min_expiry_tss_points=None,
            next_Tss_Point_To_Expire=0,
        )
        ct = compile_function(
            "tasks.py",
            "update_user_profile_ct",
            {
                **common,
                "X_CLEVERTAP_ACCOUNT_ID": "synthetic",
                "X_CLEVERTAP_PASSCODE": PRIVATE_SECRET,
                "CLEVERTAP_UPLOAD_URL": "https://clevertap.fixture.test/upload",
                "dateConvertor": str,
            },
        )
        netcore = compile_function(
            "task_helper.py",
            "call_netcore_user_contact_api",
            {
                **common,
                "settings": SimpleNamespace(
                    TSS_EVENTS_URL="https://netcore.fixture.test",
                    EVENT_APP_ID="synthetic",
                    EVENT_APP_KEY=PRIVATE_SECRET,
                ),
            },
        )
        effects = []
        function = compile_function(
            "tasks.py",
            "update_user_profile",
            {
                **common,
                "get_user_from_db": lambda _ids: [row],
                "update_user_profile_ct": ct,
                "clevertap_profile_push_log": lambda *args: effects.append(args),
                "call_netcore_user_contact_api": netcore,
            },
        )
        function([7], 7)
        self.assertIn(PRIVATE_EMAIL, self.stream.getvalue())
        self.stream.seek(0)
        self.stream.truncate(0)
        self.invoke(function, "clevertap-profile", ([7], 7))
        self.assert_private("clevertap-profile")
        self.assertEqual(len(effects), 2)

    def test_actual_moengage_consumer_and_response_data_helper_cannot_log_private_provider_fields(
        self,
    ):
        common = {
            "logger": self.logger,
            "requests": FakeRequests(),
            "settings": SimpleNamespace(
                MOENGAGE_EVENTS_URL="https://moengage.fixture.test/sync"
            ),
        }
        helper = compile_function(
            "libs/helper.py", "sync_user_attributes_moengage", common
        )
        function = compile_function(
            "tasks.py",
            "sync_user_attributes_moengage_task",
            {"logger": self.logger, "sync_user_attributes_moengage": helper},
        )
        function(7)
        self.assertIn(PRIVATE_EMAIL, self.stream.getvalue())
        self.stream.seek(0)
        self.stream.truncate(0)
        self.invoke(function, "moengage-attributes", (7,))
        self.assert_private("moengage-attributes")

    def test_actual_support_consumer_suppresses_nested_debug_results_and_exc_info(self):
        def failing(_user, _session):
            raise RuntimeError(
                PRIVATE_EMAIL + " " + PRIVATE_PHONE + " " + PRIVATE_SECRET
            )

        text = pinned("libs/CustomerSupportFlagging.py")
        node = next(
            item
            for item in ast.parse(text).body
            if isinstance(item, ast.FunctionDef)
            and item.name == "update_customer_support_flagging"
        )
        assignment = next(
            item
            for item in node.body
            if isinstance(item, ast.Assign) and isinstance(item.value, ast.List)
        )
        namespace = {
            item.id: (lambda _user, _session: {"synthetic_private_statistic": 1})
            for item in assignment.value.elts
        }
        namespace.update(
            {
                "logger": self.logger,
                "Session": object(),
                "update_and_check_if_user_exists": lambda *_args: None,
                "update_customer_support": lambda *_args: None,
                "update_user_order_count": failing,
            }
        )
        helper = compile_function(
            "libs/CustomerSupportFlagging.py",
            "update_customer_support_flagging",
            namespace,
        )
        function = compile_function(
            "tasks.py",
            "update_customer_support_flagging_task",
            {"logger": self.logger, "update_customer_support_flagging": helper},
        )
        function(7)
        self.assertIn(PRIVATE_SECRET, self.stream.getvalue())
        self.stream.seek(0)
        self.stream.truncate(0)
        self.invoke(function, "support-flags", (7,))
        self.assert_private("support-flags")

    def test_escaping_exception_is_static_and_scope_is_restored_for_ordinary_logs(self):
        def fail(_user):
            self.logger.error(PRIVATE_EMAIL, exc_info=True)
            raise RuntimeError(PRIVATE_SECRET)

        with self.assertRaises(privacy.PrivateContactTaskError) as result:
            self.invoke(fail, "support-flags", (7,))
        self.assertEqual(str(result.exception), "Customer contact source task failed")
        self.assertTrue(result.exception.__suppress_context__)
        self.assertNotIn(
            PRIVATE_SECRET, self.events.getvalue() + self.stream.getvalue()
        )
        self.logger.info("ordinary-source-event")
        self.assertIn("ordinary-source-event", self.stream.getvalue())

    def test_private_task_names_require_valid_purpose_and_exact_single_customer_scope(
        self,
    ):
        called = []

        def function(*_args):
            called.append(True)

        self.request.headers["pos-contact-customer-id"] = "8"
        with self.assertRaises(privacy.PrivateContactTaskError):
            self.invoke(function, "support-flags", (7,))
        self.request.headers = {}
        with self.assertRaises(privacy.PrivateContactTaskError):
            self.invoke(function, "support-flags", (7,))
        self.assertEqual(called, [])

    def test_private_source_requests_are_tls_only_bounded_and_never_follow_redirects(
        self,
    ):
        calls = []
        responses = []
        oversized = False

        class Response:
            closed = False

            def iter_content(self, chunk_size):
                self.chunk_size = chunk_size
                yield b"x" * 64001 if oversized else b'{"status":"success"}'

            def close(self):
                self.closed = True

        class Session:
            def request(self, method, url, *args, **kwargs):
                calls.append((method, url, kwargs))
                response = Response()
                responses.append(response)
                return response

        module = SimpleNamespace(sessions=SimpleNamespace(Session=Session))
        privacy._install_requests_guard(module)
        # Scope isolation preserves an ordinary source caller's original policy.
        Session().request(
            "GET", "http://legacy.fixture.test", timeout=100, allow_redirects=True
        )
        self.assertEqual(calls[-1][2]["timeout"], 100)

        def bounded(_user):
            return Session().request(
                "POST",
                "https://provider.fixture.test/update",
                timeout=100,
                allow_redirects=True,
            )

        response = self.invoke(bounded, "support-flags", (7,))
        self.assertTrue(response.closed)
        self.assertEqual(response._content, b'{"status":"success"}')
        self.assertEqual(calls[-1][2]["timeout"], (3, 5))
        self.assertIs(calls[-1][2]["allow_redirects"], False)
        self.assertIs(calls[-1][2]["stream"], True)
        for url in [
            "http://provider.fixture.test",
            "https://user:password@provider.fixture.test",
            "https://provider.fixture.test?email=" + PRIVATE_EMAIL,
        ]:
            before = len(calls)

            def refused(_user, target=url):
                return Session().request("GET", target)

            with self.assertRaises(privacy.PrivateContactTaskError):
                self.invoke(refused, "support-flags", (7,))
            self.assertEqual(len(calls), before)
        oversized = True
        with self.assertRaises(privacy.PrivateContactTaskError):
            self.invoke(bounded, "support-flags", (7,))
        self.assertTrue(responses[-1].closed)
        for value in [PRIVATE_EMAIL, PRIVATE_PHONE, PRIVATE_SECRET, "password@"]:
            self.assertNotIn(value, self.events.getvalue() + self.stream.getvalue())

    def test_real_requests_response_keeps_the_source_json_contract_after_bounded_close(
        self,
    ):
        import requests
        from requests.adapters import BaseAdapter

        captured = []

        class FakeAdapter(BaseAdapter):
            def send(self, request, **kwargs):
                captured.append(kwargs)
                response = requests.Response()
                response.status_code = 200
                response.raw = io.BytesIO(b'{"status":"success","processed":1}')
                response.encoding = "utf-8"
                return response

            def close(self):
                pass

        privacy._install_requests_guard(requests)
        session = requests.Session()
        session.mount("https://", FakeAdapter())

        def call(_user):
            return session.post(
                "https://provider.fixture.test/update", json={"customer_id": "7"}
            )

        try:
            response = self.invoke(call, "support-flags", (7,))
            self.assertEqual(response.json(), {"status": "success", "processed": 1})
            self.assertEqual(response.content, b'{"status":"success","processed":1}')
            self.assertEqual(captured[0]["timeout"], (3, 5))
            self.assertTrue(captured[0]["stream"])
            self.assertTrue(response.raw.closed)
        finally:
            session.close()

    def test_actual_celery_eager_registration_carries_the_bound_request_scope(self):
        from celery import Celery

        app = Celery(
            "pos-contact-private-native-task", broker="memory://", backend=None
        )
        app.conf.task_always_eager = True
        calls = []

        def run(user):
            self.logger.warning(PRIVATE_EMAIL + PRIVATE_PHONE + PRIVATE_SECRET)
            calls.append(user)
            return {"private": PRIVATE_EMAIL + PRIVATE_PHONE + PRIVATE_SECRET}

        targets = {resource: SimpleNamespace(run=run) for resource in privacy.RESOURCES}
        try:
            privacy.register_private_contact_tasks(app, targets)
            with contextlib.redirect_stdout(self.events):
                result = app.tasks[privacy.TASKS["moengage-attributes"]].apply(
                    args=[7],
                    headers=self.request.headers,
                    task_id=self.request.id,
                    throw=True,
                )
            self.assertTrue(result.successful())
            self.assertIsNone(result.result)
            self.assertEqual(calls, [7])
            self.assert_private("moengage-attributes")
        finally:
            app.close()

    def test_dry_apply_hashes_and_new_task_registration_preserve_original_source_functions(
        self,
    ):
        candidate = json.loads((owned / "privacy-candidate-manifest.json").read_text())
        original = pinned("tasks.py").encode()
        patch_bytes = (owned / candidate["patchFile"]).read_bytes()
        self.assertEqual(
            hashlib.sha256(original).hexdigest(), candidate["beforeSha256"]
        )
        self.assertEqual(
            hashlib.sha256(patch_bytes).hexdigest(), candidate["patchSha256"]
        )
        with tempfile.TemporaryDirectory(
            prefix="pos_contact_privacy_test_"
        ) as directory:
            root = Path(directory)
            (root / "tasks.py").write_bytes(original)
            subprocess.run(
                ["git", "init", "--quiet"], cwd=root, check=True, capture_output=True
            )
            subprocess.run(
                [
                    "git",
                    "apply",
                    "--whitespace=nowarn",
                    str(owned / candidate["patchFile"]),
                ],
                cwd=root,
                check=True,
                capture_output=True,
            )
            modified = (root / "tasks.py").read_bytes()
            self.assertEqual(
                hashlib.sha256(modified).hexdigest(), candidate["afterSha256"]
            )
            self.assertEqual(
                hashlib.sha256(
                    (root / "pos_contact_task_privacy.py").read_bytes()
                ).hexdigest(),
                candidate["newFileSha256"],
            )
            # Compile only definitions with the actual candidate filename. This
            # proves the read-only worker probe reports the exact patched source
            # bytes without importing source app/database/network startup.
            compiled = {}
            for resource, name in [
                ("clevertap-profile", "update_user_profile"),
                ("moengage-attributes", "sync_user_attributes_moengage_task"),
                ("support-flags", "update_customer_support_flagging_task"),
            ]:
                node = next(
                    item
                    for item in ast.parse(modified).body
                    if isinstance(item, ast.FunctionDef) and item.name == name
                )
                node.decorator_list = []
                namespace = {}
                exec(
                    compile(
                        ast.fix_missing_locations(
                            ast.Module(body=[node], type_ignores=[])
                        ),
                        str(root / "tasks.py"),
                        "exec",
                    ),
                    namespace,
                )
                compiled[resource] = SimpleNamespace(run=namespace[name])

            class ProbeApp:
                def task(self, **_options):
                    return lambda function: function

            privacy.register_private_contact_tasks(ProbeApp(), compiled)
            self.assertEqual(
                privacy.pos_contact_task_privacy(None),
                {
                    "contract": privacy.PURPOSE,
                    "helperSha256": candidate["newFileSha256"],
                    "tasksSha256": candidate["afterSha256"],
                    "tasks": sorted(privacy.TASKS.values()),
                },
            )
        before = {
            item.name: item
            for item in ast.parse(original).body
            if isinstance(item, ast.FunctionDef)
        }
        after = {
            item.name: item
            for item in ast.parse(modified).body
            if isinstance(item, ast.FunctionDef)
        }
        for name in [
            "update_user_profile",
            "sync_user_attributes_moengage_task",
            "update_customer_support_flagging_task",
        ]:
            self.assertEqual(ast.dump(before[name]), ast.dump(after[name]))
        registered = {}

        class FakeApp:
            def task(self, **options):
                def decorate(function):
                    registered[options["name"]] = function
                    return function

                return decorate

        calls = []
        targets = {
            resource: SimpleNamespace(run=lambda *args: calls.append(args))
            for resource in privacy.RESOURCES
        }
        privacy.register_private_contact_tasks(FakeApp(), targets)
        self.assertEqual(set(registered), set(privacy.TASKS.values()))
        with (
            patch.object(
                privacy, "current_task", SimpleNamespace(request=self.request)
            ),
            contextlib.redirect_stdout(self.events),
        ):
            registered[privacy.TASKS["clevertap-profile"]]([7], 7)
        self.assertEqual(calls, [([7], 7)])


if __name__ == "__main__":
    unittest.main()
