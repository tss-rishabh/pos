import ast
import json
import os
from pathlib import Path
import types
import unittest
from unittest.mock import patch

from prepare import build, candidate

ROOT = Path(__file__).resolve().parent


class PrivateError(Exception):
    pass


FALCON = types.SimpleNamespace(**{name: type(name, (PrivateError,), {}) for name in (
    "HTTPForbidden", "HTTPServiceUnavailable", "HTTPUnauthorized", "HTTPBadRequest")})


def helper_namespace():
    tree = ast.parse((ROOT / "pos_customer_context.py").read_text())
    tree.body = [node for node in tree.body if not (
        isinstance(node, ast.Import) and any(alias.name == "falcon" for alias in node.names))]
    namespace = {"falcon": FALCON}
    exec(compile(tree, "reviewed-pos-customer-context", "exec"), namespace)
    return namespace


class Request:
    def __init__(self, subject="777", path="/api/v2/cart", key=None, private=True):
        self.path = path
        self.uri = "https://api.example.test" + path
        self.method = "POST"
        self.auth = "fixture-jwt"
        self.context = {"session": object(), "data": {"is_pos": True, "store_id": 1, "tab_id": 123}}
        self.headers = ({
            "X-POS-Customer-Context-Key": key or "private-context-fixture-" * 3,
            "X-POS-Customer-Context": "pos-customer-context-v1",
            "X-POS-Customer-ID": subject,
        } if private else {})

    def get_header(self, name):
        return self.headers.get(name)


class Response:
    def __init__(self):
        self.headers = {}

    def set_header(self, key, value):
        self.headers[key] = value


def user_row(**changes):
    return {"id": 777, "firstname": "Fresh", "lastname": "Profile", "email": "fresh@example.test",
            "telephone": "9876543210", "is_two_fa": 0, "is_block": 0, "is_disabled": 0, "status": 1,
            "tss_money": 125.5, "cashback": 7, "tss_points": 9, "is_cod_enable": 1,
            "fb_id": None, "gender": "F", "birthdate": "2000-02-29", **changes}


class CustomerContextTests(unittest.TestCase):
    def setUp(self):
        self.namespace = helper_namespace()
        self.environment = patch.dict(os.environ, {"TSS_POS_CUSTOMER_CONTEXT_KEY": "private-context-fixture-" * 3})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def prepare(self, request):
        return self.namespace["prepare_private_pos_context"](request)

    def test_saved_patch_matches_pinned_source_and_is_not_enabled(self):
        manifest = build()
        self.assertFalse(manifest["enabled"])
        self.assertEqual(manifest["contract"], "pos-customer-context-v1")
        saved = json.loads((ROOT / "manifest.json").read_text())
        self.assertEqual(saved, manifest)

    def test_only_exact_paths_method_and_complete_private_headers_are_accepted(self):
        for path in self.namespace["PATHS"]:
            self.assertTrue(self.prepare(Request(path=path)))
        for path in ("/api/v2/cart/", "/api/v2/cartwidgets", "/api/v2/pos/exchange", "/api/v3/cart"):
            with self.assertRaises(FALCON.HTTPForbidden):
                self.prepare(Request(path=path))
        request = Request()
        request.method = "GET"
        with self.assertRaises(FALCON.HTTPForbidden):
            self.prepare(request)
        for missing in list(Request().headers):
            request = Request()
            del request.headers[missing]
            with self.assertRaises(FALCON.HTTPForbidden):
                self.prepare(request)
        self.assertFalse(self.prepare(Request(private=False)))

    def test_missing_configuration_wrong_key_and_unauthenticated_requests_fail_closed(self):
        with patch.dict(os.environ, {"TSS_POS_CUSTOMER_CONTEXT_KEY": ""}):
            with self.assertRaises(FALCON.HTTPServiceUnavailable):
                self.prepare(Request())
        with self.assertRaises(FALCON.HTTPForbidden):
            self.prepare(Request(key="wrong-private-context-" * 3))
        request = Request()
        request.auth = None
        with self.assertRaises(FALCON.HTTPUnauthorized):
            self.prepare(request)

    def test_subject_binding_range_and_writer_session_are_required(self):
        for subject in ("0", "01", "-1", "1.0", "18446744073709551616", "777\n"):
            with self.assertRaises(FALCON.HTTPForbidden):
                self.prepare(Request(subject=subject))
        request = Request()
        self.prepare(request)
        with self.assertRaises(FALCON.HTTPForbidden):
            self.namespace["load_private_pos_user"](request, 778, lambda *args, **kwargs: self.fail())
        request.context.pop("session")
        with self.assertRaises(FALCON.HTTPServiceUnavailable):
            self.namespace["load_private_pos_user"](request, 777, lambda *args, **kwargs: self.fail())

    def test_blocked_disabled_inactive_ambiguous_or_wrong_identity_rows_are_never_loaded(self):
        for row in (None, user_row(id=778), *[user_row(status=value) for value in (0, 2, None, True)],
                    *[user_row(is_block=value) for value in (1, 2, "0", False)],
                    *[user_row(is_disabled=value) for value in (1, 2, "0", False)],
                    {key: value for key, value in user_row().items() if key != "is_disabled"}):
            request = Request()
            self.prepare(request)
            with self.assertRaises(FALCON.HTTPUnauthorized):
                self.namespace["load_private_pos_user"](request, 777, lambda *args, **kwargs: row)
            self.assertFalse(request.context[self.namespace["CONTEXT"]]["loaded"])

    def test_native_nullable_disabled_flag_keeps_active_customers_eligible(self):
        self.assertIn("is_disabled", self.namespace["USER_SQL"])
        for disabled in (0, None):
            request = Request()
            self.prepare(request)
            self.namespace["load_private_pos_user"](
                request, 777, lambda *args, **kwargs: user_row(is_disabled=disabled))
            self.assertTrue(request.context[self.namespace["CONTEXT"]]["loaded"])

    def test_database_errors_have_no_raw_query_or_customer_details(self):
        request = Request()
        self.prepare(request)

        def failure(*args, **kwargs):
            raise RuntimeError("private-email@example.test password=secret SQL SELECT * FROM users")

        with self.assertRaises(FALCON.HTTPServiceUnavailable) as caught:
            self.namespace["load_private_pos_user"](request, 777, failure)
        self.assertEqual(str(caught.exception), "Fresh customer context is unavailable.")

    def test_payload_is_pos_and_store_are_validated_without_changing_guest_tabs(self):
        for data in ({}, {"is_pos": False, "store_id": 1}, {"is_pos": 1, "store_id": 1},
                     {"is_pos": True, "store_id": True}, {"is_pos": True, "store_id": "1"}):
            request = Request()
            self.prepare(request)
            self.namespace["load_private_pos_user"](request, 777, lambda *args, **kwargs: user_row())
            request.context["data"] = data
            with self.assertRaises(FALCON.HTTPBadRequest):
                self.namespace["validate_private_pos_payload"](request)
        request = Request()
        before = dict(request.context["data"])
        self.prepare(request)
        self.namespace["load_private_pos_user"](request, 777, lambda *args, **kwargs: user_row(is_block=None))
        self.namespace["validate_private_pos_payload"](request)
        self.assertEqual(before, request.context["data"])

    def test_actual_patched_auth_method_bypasses_cache_and_keeps_fresh_membership_context(self):
        import subprocess
        source = subprocess.check_output(["git", "show", "2960acbea10c4eaf16b6d99e15ff6e03ef7724c5:middleware/AuthHandler.py"],
                                         cwd=Path(os.environ.get('POS_LEGACY_IMPORT_SOURCE_ROOT', str(ROOT.parents[4] / "backend-tss-api_v2"))), text=True)
        auth_class = next(node for node in ast.parse(candidate(source)).body
                          if isinstance(node, ast.ClassDef) and node.name == "AuthHandler")
        namespace = dict(self.namespace)
        calls = []

        def fetch_one(session, query, params, to_dict):
            self.assertIn("is_disabled", query)
            calls.append((session, query, params, to_dict))
            return user_row()

        def cache_forbidden(*args, **kwargs):
            self.fail("Private customer context touched the shared Redis cache")

        memberships = []
        namespace.update({"SKIP_URL_LIST": [], "_is_public_endpoint": lambda path: False,
                          "decodeJwt": lambda token: {"sub": "777"},
                          "_get_cached_user": cache_forbidden, "_set_cached_user": cache_forbidden,
                          "fetchOne": fetch_one,
                          "get_exclusive_token": lambda session, user_id, email: memberships.append((session, user_id, email)) or True})
        exec(compile(ast.Module(body=[auth_class], type_ignores=[]), "pinned-auth-handler-candidate", "exec"), namespace)
        request, response = Request(), Response()
        handler = namespace["AuthHandler"]()
        handler.process_request(request, response)
        handler.process_resource(request, response, object(), {})
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0][0], request.context["session"])
        self.assertEqual(calls[0][2], {"user_id": 777})
        self.assertEqual(memberships, [(request.context["session"], 777, "fresh@example.test")])
        self.assertEqual(request.context["user"]["tss_money"], 125.5)
        self.assertEqual(request.context["user"]["cashback"], 7)
        self.assertEqual(request.context["user"]["birthdate"], "2000-02-29")
        self.assertEqual(response.headers["X-POS-Customer-Context"], "pos-customer-context-v1")
        self.assertEqual(response.headers["X-POS-Customer-ID"], "777")
        self.assertEqual(response.headers["Cache-Control"], "private, no-store")


if __name__ == "__main__":
    unittest.main()
